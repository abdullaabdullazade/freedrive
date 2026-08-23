import * as XLSX from "xlsx";

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const XLS_MIME = "application/vnd.ms-excel";
export const CSV_MIME = "text/csv";

const MIN_ROWS = 20;
const MIN_COLS = 10;
const EXTRA_ROWS = 5;
const EXTRA_COLS = 3;

export type SheetKind = "workbook" | "csv";

export type ParsedSpreadsheet = {
  kind: SheetKind;
  workbook: XLSX.WorkBook | null;
  csvRows: string[][];
  sheetNames: string[];
  ext: "xlsx" | "xls" | "csv" | "tsv";
};

export type CellEdit = {
  sheetIdx: number;
  row: number;
  col: number;
  value: string;
};

export function isSpreadsheetFile(
  name: string,
  mime = "",
): boolean {
  const m = mime.toLowerCase();
  const n = name.toLowerCase();
  if (
    m.includes("spreadsheetml") ||
    m.includes("ms-excel") ||
    m.includes("spreadsheet") ||
    m.includes("csv")
  ) {
    return true;
  }
  return /\.(xlsx|xls|csv|tsv)$/i.test(n);
}

function fileExt(name: string): "xlsx" | "xls" | "csv" | "tsv" {
  const n = name.toLowerCase();
  if (n.endsWith(".xls") && !n.endsWith(".xlsx")) return "xls";
  if (n.endsWith(".tsv")) return "tsv";
  if (n.endsWith(".csv")) return "csv";
  return "xlsx";
}

function isCsvLike(name: string, mime: string): boolean {
  const m = mime.toLowerCase();
  const n = name.toLowerCase();
  if (n.endsWith(".csv") || n.endsWith(".tsv")) return true;
  if (m.includes("csv") && !m.includes("spreadsheetml") && !m.includes("ms-excel")) {
    return true;
  }
  return false;
}

export function columnName(index: number): string {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name || "A";
}

function parseCsvText(text: string, delimiter = ","): string[][] {
  const rows = text.split(/\r?\n/).filter((r) => r.length > 0).map((r) => r.split(delimiter));
  return rows.length ? rows : [[""]];
}

export function parseSpreadsheet(
  bytes: Uint8Array,
  name: string,
  mime = "",
): ParsedSpreadsheet {
  const ext = fileExt(name);
  if (isCsvLike(name, mime) || ext === "csv" || ext === "tsv") {
    const text = new TextDecoder().decode(bytes);
    const delimiter = ext === "tsv" ? "\t" : ",";
    return {
      kind: "csv",
      workbook: null,
      csvRows: parseCsvText(text, delimiter),
      sheetNames: ["Sheet1"],
      ext,
    };
  }

  const workbook = XLSX.read(bytes, {
    type: "array",
    cellFormula: true,
    cellStyles: true,
    cellNF: true,
    cellDates: true,
  });
  const sheetNames = workbook.SheetNames || [];
  if (!sheetNames.length) {
    throw new Error("No worksheet found in this file");
  }
  return {
    kind: "workbook",
    workbook,
    csvRows: [],
    sheetNames,
    ext: ext === "xls" ? "xls" : "xlsx",
  };
}

function sheetDisplayValue(
  sheet: XLSX.WorkSheet,
  row: number,
  col: number,
): string {
  const address = XLSX.utils.encode_cell({ r: row, c: col });
  const cell = sheet[address] as XLSX.CellObject | undefined;
  if (!cell) return "";
  if (cell.f) return `=${cell.f}`;
  try {
    return String(XLSX.utils.format_cell(cell) ?? cell.v ?? "");
  } catch {
    return String(cell.v ?? "");
  }
}

export function getDisplayGrid(
  parsed: ParsedSpreadsheet,
  sheetIdx: number,
  edits: Map<string, string>,
): { rows: number; cols: number; getCell: (r: number, c: number) => string } {
  let usedRows = 1;
  let usedCols = 1;

  if (parsed.kind === "csv") {
    usedRows = Math.max(1, parsed.csvRows.length);
    usedCols = Math.max(
      1,
      ...parsed.csvRows.map((r) => r.length),
      1,
    );
  } else if (parsed.workbook) {
    const sheet = parsed.workbook.Sheets[parsed.sheetNames[sheetIdx]];
    if (sheet?.["!ref"]) {
      const range = XLSX.utils.decode_range(sheet["!ref"]);
      usedRows = Math.max(1, range.e.r + 1);
      usedCols = Math.max(1, range.e.c + 1);
    }
  }

  for (const [key, value] of edits) {
    if (!value) continue;
    const [s, r, c] = key.split(":").map(Number);
    if (s !== sheetIdx) continue;
    usedRows = Math.max(usedRows, r + 1);
    usedCols = Math.max(usedCols, c + 1);
  }

  const rows = Math.max(MIN_ROWS, usedRows + EXTRA_ROWS);
  const cols = Math.max(MIN_COLS, usedCols + EXTRA_COLS);

  const getCell = (r: number, c: number): string => {
    const key = editKey(sheetIdx, r, c);
    if (edits.has(key)) return edits.get(key) ?? "";
    if (parsed.kind === "csv") {
      return parsed.csvRows[r]?.[c] ?? "";
    }
    const sheet = parsed.workbook?.Sheets[parsed.sheetNames[sheetIdx]];
    if (!sheet) return "";
    return sheetDisplayValue(sheet, r, c);
  };

  return { rows, cols, getCell };
}

export function editKey(sheetIdx: number, row: number, col: number): string {
  return `${sheetIdx}:${row}:${col}`;
}

function assignCellValue(sheet: XLSX.WorkSheet, address: string, value: string): void {
  if (!value) {
    delete sheet[address];
    return;
  }
  let next: XLSX.CellObject;
  if (value.startsWith("=")) {
    next = { f: value.slice(1), t: "n" };
  } else if (/^-?\d+(\.\d+)?$/.test(value)) {
    next = { v: Number(value), t: "n" };
  } else if (/^(true|false)$/i.test(value)) {
    next = { v: value.toLowerCase() === "true", t: "b" };
  } else {
    next = { v: value, t: "s" };
  }
  sheet[address] = next;

  const decoded = XLSX.utils.decode_cell(address);
  const range = XLSX.utils.decode_range(sheet["!ref"] || address);
  range.s.r = Math.min(range.s.r, decoded.r);
  range.s.c = Math.min(range.s.c, decoded.c);
  range.e.r = Math.max(range.e.r, decoded.r);
  range.e.c = Math.max(range.e.c, decoded.c);
  sheet["!ref"] = XLSX.utils.encode_range(range);
}

export function serializeSpreadsheet(
  parsed: ParsedSpreadsheet,
  edits: Map<string, string>,
): { bytes: Uint8Array; mimeType: string } {
  if (parsed.kind === "csv" || !parsed.workbook) {
    const rows = parsed.csvRows.map((r) => [...r]);
    for (const [key, value] of edits) {
      const [, row, col] = key.split(":").map(Number);
      while (rows.length <= row) rows.push([]);
      while (rows[row].length <= col) rows[row].push("");
      rows[row][col] = value;
    }
    const delimiter = parsed.ext === "tsv" ? "\t" : ",";
    const out = rows.map((r) => r.join(delimiter)).join("\n");
    return {
      bytes: new TextEncoder().encode(out),
      mimeType: parsed.ext === "tsv" ? "text/tab-separated-values" : CSV_MIME,
    };
  }

  const workbook = parsed.workbook;
  for (const [key, value] of edits) {
    const [sheetIdx, row, col] = key.split(":").map(Number);
    const name = parsed.sheetNames[sheetIdx];
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const address = XLSX.utils.encode_cell({ r: row, c: col });
    assignCellValue(sheet, address, value);
  }

  const bookType = parsed.ext === "xls" ? "xls" : "xlsx";
  const out = XLSX.write(workbook, {
    bookType,
    type: "array",
    cellStyles: true,
  }) as ArrayBuffer | Uint8Array | number[];

  const bytes =
    out instanceof Uint8Array
      ? out
      : out instanceof ArrayBuffer
        ? new Uint8Array(out)
        : new Uint8Array(out);

  return {
    bytes,
    mimeType: bookType === "xls" ? XLS_MIME : XLSX_MIME,
  };
}

/** Empty single-sheet workbook for Create → Spreadsheet. */
export function emptyXlsxBytes(): Uint8Array {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([[""]]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
  const out = XLSX.write(workbook, {
    bookType: "xlsx",
    type: "array",
  }) as ArrayBuffer | Uint8Array | number[];
  if (out instanceof Uint8Array) return out;
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  return new Uint8Array(out);
}
