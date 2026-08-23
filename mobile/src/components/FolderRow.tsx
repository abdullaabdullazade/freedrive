import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Computer, FolderItem } from "../api/types";
import { colors, radii, spacing } from "../theme";
import { formatRelativeDate } from "../utils/format";
import { Icon } from "./Icon";

interface FolderRowProps {
  folder: FolderItem;
  onPress: () => void;
  onMenuPress?: () => void;
  columns?: number;
}

export function FolderRow({ folder, onPress, onMenuPress }: FolderRowProps) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.icon}>
        <Icon name="folder" size={22} color={colors.folder} />
      </View>
      <View style={styles.meta}>
        <Text style={styles.name} numberOfLines={1}>
          {folder.name}
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {formatRelativeDate(folder.updated_at)}
        </Text>
      </View>
      <Pressable style={styles.menu} onPress={onMenuPress} hitSlop={10}>
        <Icon name="more" size={20} color={colors.textSecondary} />
      </Pressable>
    </Pressable>
  );
}

interface ComputerRowProps {
  computer: Computer;
  onPress: () => void;
  onMenuPress?: () => void;
}

export function ComputerRow({ computer, onPress, onMenuPress }: ComputerRowProps) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.icon}>
        <Icon name="computer" size={22} color={colors.folder} />
      </View>
      <View style={styles.meta}>
        <Text style={styles.name} numberOfLines={1}>
          {computer.name || computer.hostname || "Computer"}
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {formatRelativeDate(computer.last_seen_at || computer.updated_at)}
        </Text>
      </View>
      <Pressable style={styles.menu} onPress={onMenuPress} hitSlop={10}>
        <Icon name="more" size={20} color={colors.textSecondary} />
      </Pressable>
    </Pressable>
  );
}

export function FolderGridTile({ folder, onPress, onMenuPress, columns = 2 }: FolderRowProps) {
  return (
    <Pressable style={[styles.tile, { width: `${100 / columns}%` }]} onPress={onPress}>
      <View style={styles.tilePreview}>
        <Icon name="folder" size={44} color={colors.folder} />
        <Pressable style={styles.tileMenu} onPress={onMenuPress} hitSlop={8}>
          <Icon name="more" size={18} color={colors.textSecondary} />
        </Pressable>
      </View>
      <Text style={styles.tileName} numberOfLines={2}>
        {folder.name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  meta: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "500",
  },
  sub: {
    color: colors.textSecondary,
    fontSize: 13,
    marginTop: 2,
  },
  menu: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  tile: {
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md,
  },
  tilePreview: {
    width: "100%",
    aspectRatio: 1,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  tileMenu: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  tileName: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "500",
  },
});
