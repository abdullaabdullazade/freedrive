import React from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { colors, radii, spacing } from "../theme";
import { Icon } from "./Icon";
import { UserAvatar } from "./UserAvatar";

interface SearchBarProps {
  value: string;
  onChangeText: (v: string) => void;
  onSubmit?: () => void;
  onMenuPress?: () => void;
  onAvatarPress?: () => void;
  placeholder?: string;
}

export function SearchBar({
  value,
  onChangeText,
  onSubmit,
  onMenuPress,
  onAvatarPress,
  placeholder = "Search in Drive",
}: SearchBarProps) {
  return (
    <View style={styles.row}>
      {onMenuPress ? (
        <Pressable style={styles.iconBtn} onPress={onMenuPress} hitSlop={8}>
          <Icon name="menu" size={22} />
        </Pressable>
      ) : null}
      <View style={styles.inputWrap}>
        <Icon name="search" size={18} color={colors.textSecondary} />
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          onSubmitEditing={onSubmit}
          placeholder={placeholder}
          placeholderTextColor={colors.textSecondary}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>
      <Pressable onPress={onAvatarPress} hitSlop={8}>
        <UserAvatar size={36} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  iconBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  inputWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg,
    height: 48,
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    padding: 0,
  },
});
