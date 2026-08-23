export type PreviewKind = "pdf" | "image" | "video" | "audio" | "text" | "binary";

const textExtensions = new Set([
  "txt", "md", "json", "csv", "log", "xml", "yaml", "yml", "toml", "ini",
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "css", "scss", "sass", "less",
  "html", "htm", "vue", "svelte", "go", "rs", "py", "pyw", "sh", "bash",
  "zsh", "fish", "c", "h", "cc", "cpp", "cxx", "hpp", "java", "kt", "kts",
  "cs", "fs", "fsx", "vb", "php", "rb", "swift", "dart", "scala", "lua",
  "r", "sql", "graphql", "gql", "proto", "dockerfile", "makefile", "gradle",
  "properties", "env", "conf", "cfg", "lock", "gitignore", "editorconfig",
]);

const mimeByExtension: Record<string, string> = {
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
  flac: "audio/flac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mkv: "video/x-matroska", avi: "video/x-msvideo",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", avif: "image/avif",
  pdf: "application/pdf",
};

export function effectiveMimeType(mimeType: string, name: string): string {
  const mime = mimeType.trim().toLowerCase();
  const extension = name.split(".").pop()?.toLowerCase() || "";
  if (!mime || mime === "application/octet-stream" || mime === "binary/octet-stream") {
    return mimeByExtension[extension] || "application/octet-stream";
  }
  return mime;
}

export function previewKindFor(mimeType: string, name: string): PreviewKind {
  const mime = effectiveMimeType(mimeType, name);
  const extension = name.split(".").pop()?.toLowerCase() || "";
  if (mime === "application/pdf" || extension === "pdf") return "pdf";
  // Show SVG source as text instead of executing active or remote content.
  if (mime === "image/svg+xml" || extension === "svg") return "text";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/") || mime.includes("json") || mime.includes("xml") || textExtensions.has(extension)) {
    return "text";
  }
  return "binary";
}

export function binaryPreview(bytes: Uint8Array, limit = 64 * 1024): string {
  const shown = bytes.subarray(0, Math.min(bytes.length, limit));
  const rows: string[] = [];
  for (let offset = 0; offset < shown.length; offset += 16) {
    const chunk = shown.subarray(offset, offset + 16);
    const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
    const ascii = Array.from(chunk, (byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".").join("");
    rows.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  if (shown.length < bytes.length) rows.push(`\n… ${bytes.length - shown.length} more bytes. Save a copy to inspect the complete file.`);
  return rows.join("\n");
}

export function textPreview(bytes: Uint8Array, limit = 2 * 1024 * 1024): string {
  const shown = bytes.subarray(0, Math.min(bytes.length, limit));
  const text = new TextDecoder().decode(shown);
  return shown.length < bytes.length
    ? `${text}\n\n… ${bytes.length - shown.length} more bytes. Save a copy to inspect the complete file.`
    : text;
}

export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
