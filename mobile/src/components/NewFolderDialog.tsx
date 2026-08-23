import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { colors, radii, spacing } from "../theme";

type Props = {
  visible: boolean;
  onCancel: () => void;
  onCreate: (name: string) => Promise<void> | void;
};

export function NewFolderDialog({ visible, onCancel, onCreate }: Props) {
  const [name, setName] = useState("Untitled folder");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (visible) {
      setName("Untitled folder");
      setError("");
      setBusy(false);
    }
  }, [visible]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Folder name is required");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onCreate(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>New folder</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            autoFocus
            selectTextOnFocus
            editable={!busy}
            placeholder="Untitled folder"
            placeholderTextColor={colors.textSecondary}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.actions}>
            <Pressable onPress={onCancel} disabled={busy} style={styles.actionBtn}>
              <Text style={styles.actionText}>Cancel</Text>
            </Pressable>
            <Pressable onPress={() => void submit()} disabled={busy} style={styles.actionBtn}>
              {busy ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <Text style={styles.actionText}>Create</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
  },
  card: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: radii.lg,
    padding: spacing.xl,
  },
  title: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "600",
    marginBottom: spacing.lg,
  },
  input: {
    borderWidth: 2,
    borderColor: colors.accent,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.text,
    fontSize: 16,
    backgroundColor: colors.inputBg,
  },
  error: {
    color: colors.danger,
    marginTop: spacing.sm,
    fontSize: 13,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.lg,
    marginTop: spacing.xl,
  },
  actionBtn: {
    minWidth: 64,
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  actionText: {
    color: colors.accentMuted,
    fontWeight: "600",
    fontSize: 15,
  },
});
