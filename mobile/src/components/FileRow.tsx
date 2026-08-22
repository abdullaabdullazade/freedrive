import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { FileItem } from "../api/types";
import { colors, radii, spacing } from "../theme";
import { formatRelativeDate, mimeCategory } from "../utils/format";
import { Icon, type IconName } from "./Icon";

interface FileRowProps {
  file: FileItem;
  subtitle?: string;
  onPress?: () => void;
  onMenuPress?: () => void;
  /** Grid column count — sets tile width so last-row items stay square-sized. */
  columns?: number;
}

function iconFor(mime: string): { bg: string; name: IconName } {
  const cat = mimeCategory(mime);
  switch (cat) {
    case "image":
      return { bg: colors.image, name: "image" };
    case "video":
      return { bg: colors.video, name: "video" };
    case "sheet":
      return { bg: colors.sheet, name: "sheet" };
    case "doc":
      return { bg: colors.doc, name: "doc" };
    default:
      return { bg: colors.fab, name: "file" };
  }
}

export function FileRow({ file, subtitle, onPress, onMenuPress }: FileRowProps) {
  const icon = iconFor(file.mime_type);
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={[styles.icon, { backgroundColor: icon.bg }]}>
        <Icon name={icon.name} size={20} color="#FFFFFF" />
      </View>
      <View style={styles.meta}>
        <Text style={styles.name} numberOfLines={1}>
          {file.name}
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {subtitle ?? formatRelativeDate(file.updated_at || file.accessed_at)}
        </Text>
      </View>
      <Pressable style={styles.menu} onPress={onMenuPress} hitSlop={10}>
        <Icon name="more" size={20} color={colors.textSecondary} />
      </Pressable>
    </Pressable>
  );
}

export function FileGridTile({
  file,
  subtitle,
  onPress,
  onMenuPress,
  columns = 2,
}: FileRowProps) {
  const icon = iconFor(file.mime_type);
  return (
    <Pressable style={[styles.tile, { width: `${100 / columns}%` }]} onPress={onPress}>
      <View style={[styles.tilePreview, { backgroundColor: icon.bg }]}>
        <Icon name={icon.name} size={40} color="#FFFFFF" />
        <Pressable style={styles.tileMenu} onPress={onMenuPress} hitSlop={8}>
          <Icon name="more" size={18} color="#FFFFFF" />
        </Pressable>
      </View>
      <Text style={styles.tileName} numberOfLines={2}>
        {file.name}
      </Text>
      {subtitle ? (
        <Text style={styles.tileSub} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
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
  tileSub: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
});
