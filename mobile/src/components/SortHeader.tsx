import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { SortDir, SortKey, ViewMode } from "../api/types";
import { colors, radii, spacing } from "../theme";
import { Icon } from "./Icon";

interface SortHeaderProps {
  sort: SortKey;
  dir: SortDir;
  viewMode: ViewMode;
  onToggleSort: () => void;
  onChangeViewMode: (mode: ViewMode) => void;
}

export function SortHeader({
  sort,
  dir,
  viewMode,
  onToggleSort,
  onChangeViewMode,
}: SortHeaderProps) {
  const label = sort === "name" ? "Name" : "Date modified";

  return (
    <View style={styles.row}>
      <Pressable style={styles.sortBtn} onPress={onToggleSort}>
        <Text style={styles.sortText}>{label}</Text>
        <View style={styles.arrowCircle}>
          <View style={dir === "desc" ? styles.flip : undefined}>
            <Icon name="arrow_up" size={14} color={colors.text} />
          </View>
        </View>
      </Pressable>
      <View style={styles.toggle}>
        <Pressable
          style={[styles.toggleBtn, viewMode === "list" && styles.toggleActive]}
          onPress={() => onChangeViewMode("list")}
        >
          <Icon
            name="list"
            size={16}
            color={viewMode === "list" ? "#0B1C2C" : colors.text}
          />
        </Pressable>
        <Pressable
          style={[styles.toggleBtn, viewMode === "grid" && styles.toggleActive]}
          onPress={() => onChangeViewMode("grid")}
        >
          <Icon
            name="grid"
            size={16}
            color={viewMode === "grid" ? "#0B1C2C" : colors.text}
          />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  sortBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  sortText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "500",
  },
  arrowCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.fab,
    alignItems: "center",
    justifyContent: "center",
  },
  flip: {
    transform: [{ rotate: "180deg" }],
  },
  toggle: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    padding: 2,
  },
  toggleBtn: {
    width: 40,
    height: 32,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  toggleActive: {
    backgroundColor: colors.accentSoft,
  },
});
