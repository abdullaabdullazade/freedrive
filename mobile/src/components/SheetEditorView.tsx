import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, spacing } from "../theme";
import {
  columnName,
  editKey,
  getDisplayGrid,
  parseSpreadsheet,
  serializeSpreadsheet,
  type ParsedSpreadsheet,
} from "../utils/sheetCodec";

const CELL_W = 108;
const CELL_H = 36;
const HEADER_W = 44;

function base64ToBytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

type Props = {
  uri: string;
  fileName: string;
  mime: string;
  editing: boolean;
  edits: Map<string, string>;
  onEditsChange: (next: Map<string, string>) => void;
  activeSheetIdx: number;
  onActiveSheetIdxChange: (idx: number) => void;
  parsed: ParsedSpreadsheet | null;
  onParsed: (parsed: ParsedSpreadsheet) => void;
  loadError: string | null;
  onLoadError: (msg: string | null) => void;
};

export function SheetEditorView({
  uri,
  fileName,
  mime,
  editing,
  edits,
  onEditsChange,
  activeSheetIdx,
  onActiveSheetIdxChange,
  parsed,
  onParsed,
  loadError,
  onLoadError,
}: Props) {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(!parsed);
  const [selected, setSelected] = useState<{ row: number; col: number }>({
    row: 0,
    col: 0,
  });
  const [formulaDraft, setFormulaDraft] = useState("");

  useEffect(() => {
    if (parsed) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      onLoadError(null);
      try {
        const b64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const bytes = base64ToBytes(b64);
        const next = parseSpreadsheet(bytes, fileName, mime);
        if (!cancelled) onParsed(next);
      } catch (err) {
        if (!cancelled) {
          onLoadError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uri, fileName, mime, parsed, onParsed, onLoadError]);

  const grid = useMemo(() => {
    if (!parsed) return null;
    return getDisplayGrid(parsed, activeSheetIdx, edits);
  }, [parsed, activeSheetIdx, edits]);

  useEffect(() => {
    if (!grid) return;
    setFormulaDraft(grid.getCell(selected.row, selected.col));
  }, [grid, selected.row, selected.col, activeSheetIdx]);

  const commitCell = useCallback(
    (row: number, col: number, value: string) => {
      const key = editKey(activeSheetIdx, row, col);
      const baseline = (() => {
        if (!parsed) return "";
        const without = new Map(edits);
        without.delete(key);
        return getDisplayGrid(parsed, activeSheetIdx, without).getCell(row, col);
      })();
      const next = new Map(edits);
      if (value === baseline) next.delete(key);
      else next.set(key, value);
      onEditsChange(next);
    },
    [activeSheetIdx, edits, onEditsChange, parsed],
  );

  const selectCell = useCallback(
    (row: number, col: number) => {
      if (editing && grid) {
        commitCell(selected.row, selected.col, formulaDraft);
      }
      setSelected({ row, col });
    },
    [commitCell, editing, formulaDraft, grid, selected.col, selected.row],
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (loadError || !parsed || !grid) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>
          Failed to open table: {loadError || "Unknown error"}
        </Text>
      </View>
    );
  }

  const address = `${columnName(selected.col)}${selected.row + 1}`;
  const hasSheetTabs = parsed.sheetNames.length > 1;

  return (
    <View
      style={[
        styles.root,
        !hasSheetTabs ? { paddingBottom: insets.bottom } : null,
      ]}
    >
      <View style={styles.formulaBar}>
        <Text style={styles.address}>{address}</Text>
        <Text style={styles.fx}>fx</Text>
        {editing ? (
          <TextInput
            style={styles.formulaInput}
            value={formulaDraft}
            onChangeText={setFormulaDraft}
            onEndEditing={() =>
              commitCell(selected.row, selected.col, formulaDraft)
            }
            onSubmitEditing={() =>
              commitCell(selected.row, selected.col, formulaDraft)
            }
            placeholder="Cell value"
            placeholderTextColor={colors.textSecondary}
          />
        ) : (
          <Text style={styles.formulaReadonly} numberOfLines={1}>
            {formulaDraft || " "}
          </Text>
        )}
      </View>

      <ScrollView
        style={styles.gridScroll}
        contentContainerStyle={{ flexGrow: 1 }}
        bounces={false}
      >
        <ScrollView horizontal bounces={false}>
          <View>
            <View style={styles.row}>
              <View style={[styles.corner, { width: HEADER_W, height: CELL_H }]} />
              {Array.from({ length: grid.cols }, (_, c) => (
                <View
                  key={`h-${c}`}
                  style={[styles.colHeader, { width: CELL_W, height: CELL_H }]}
                >
                  <Text style={styles.headerText}>{columnName(c)}</Text>
                </View>
              ))}
            </View>
            {Array.from({ length: grid.rows }, (_, r) => (
              <View key={`r-${r}`} style={styles.row}>
                <View style={[styles.rowHeader, { width: HEADER_W, height: CELL_H }]}>
                  <Text style={styles.headerText}>{r + 1}</Text>
                </View>
                {Array.from({ length: grid.cols }, (_, c) => {
                  const active = selected.row === r && selected.col === c;
                  const value = grid.getCell(r, c);
                  return (
                    <Pressable
                      key={`c-${r}-${c}`}
                      onPress={() => selectCell(r, c)}
                      style={[
                        styles.cell,
                        { width: CELL_W, height: CELL_H },
                        active && styles.cellActive,
                      ]}
                    >
                      <Text style={styles.cellText} numberOfLines={1}>
                        {value}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>
        </ScrollView>
      </ScrollView>

      {hasSheetTabs ? (
        <ScrollView
          horizontal
          style={[styles.tabs, { paddingBottom: insets.bottom, maxHeight: 44 + insets.bottom }]}
          contentContainerStyle={styles.tabsInner}
          showsHorizontalScrollIndicator={false}
        >
          {parsed.sheetNames.map((name, idx) => {
            const active = idx === activeSheetIdx;
            return (
              <Pressable
                key={`${name}-${idx}`}
                onPress={() => {
                  if (editing) {
                    commitCell(selected.row, selected.col, formulaDraft);
                  }
                  onActiveSheetIdxChange(idx);
                  setSelected({ row: 0, col: 0 });
                }}
                style={[styles.tab, active && styles.tabActive]}
              >
                <Text style={[styles.tabText, active && styles.tabTextActive]}>
                  {name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
}

export async function loadAndSerializeSheet(
  uri: string,
  fileName: string,
  mime: string,
  edits: Map<string, string>,
  existing?: ParsedSpreadsheet | null,
): Promise<{ bytes: Uint8Array; mimeType: string; parsed: ParsedSpreadsheet }> {
  let parsed = existing ?? null;
  if (!parsed) {
    const b64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    parsed = parseSpreadsheet(base64ToBytes(b64), fileName, mime);
  }
  const { bytes, mimeType } = serializeSpreadsheet(parsed, edits);
  return { bytes, mimeType, parsed };
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
    padding: spacing.lg,
  },
  error: { color: "#ea4335", textAlign: "center" },
  formulaBar: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    gap: 8,
  },
  address: {
    minWidth: 36,
    color: colors.textSecondary,
    fontWeight: "600",
    fontSize: 13,
  },
  fx: { color: colors.textSecondary, fontSize: 13, fontWeight: "600" },
  formulaInput: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 6,
    backgroundColor: colors.surface,
  },
  formulaReadonly: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    paddingVertical: 4,
  },
  gridScroll: { flex: 1 },
  row: { flexDirection: "row" },
  corner: {
    backgroundColor: colors.surface,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  colHeader: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  rowHeader: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  headerText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
  cell: {
    justifyContent: "center",
    paddingHorizontal: 6,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  cellActive: {
    borderWidth: 2,
    borderColor: colors.accent,
    margin: -1,
  },
  cellText: { color: colors.text, fontSize: 13 },
  tabs: {
    maxHeight: 44,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  tabsInner: {
    paddingHorizontal: spacing.sm,
    alignItems: "center",
    gap: 4,
  },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: { borderBottomColor: colors.sheet },
  tabText: { color: colors.textSecondary, fontSize: 13 },
  tabTextActive: { color: colors.text, fontWeight: "600" },
});
