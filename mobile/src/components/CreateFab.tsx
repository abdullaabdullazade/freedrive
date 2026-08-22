import React, { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "./Icon";
import { colors, radii, spacing } from "../theme";

type Props = {
  onCamera: () => void;
  onUpload: () => void;
  onFolder: () => void;
  onDocument: () => void;
  onSpreadsheet: () => void;
};

export function CreateFab({
  onCamera,
  onUpload,
  onFolder,
  onDocument,
  onSpreadsheet,
}: Props) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();

  const close = () => setOpen(false);

  return (
    <View pointerEvents="box-none" style={styles.wrap}>
      {open ? (
        <Pressable style={styles.overlay} onPress={close} accessibilityLabel="Dismiss" />
      ) : null}

      <View
        style={[styles.stack, { paddingBottom: insets.bottom + spacing.lg }]}
        pointerEvents="box-none"
      >
        <Pressable
          style={styles.camera}
          onPress={() => {
            close();
            onCamera();
          }}
          accessibilityLabel="Camera"
        >
          <Icon name="camera" size={22} color={colors.text} />
        </Pressable>

        {open ? (
          <>
            <Pressable
              style={styles.pill}
              onPress={() => {
                close();
                onDocument();
              }}
            >
              <Icon name="doc" size={20} color={colors.text} />
              <Text style={styles.pillText}>Document</Text>
            </Pressable>
            <Pressable
              style={styles.pill}
              onPress={() => {
                close();
                onSpreadsheet();
              }}
            >
              <Icon name="sheet" size={20} color={colors.text} />
              <Text style={styles.pillText}>Spreadsheet</Text>
            </Pressable>
            <Pressable
              style={styles.pill}
              onPress={() => {
                close();
                onUpload();
              }}
            >
              <Icon name="upload" size={20} color={colors.text} />
              <Text style={styles.pillText}>Upload</Text>
            </Pressable>
            <Pressable
              style={styles.pill}
              onPress={() => {
                close();
                onFolder();
              }}
            >
              <Icon name="folder" size={20} color={colors.text} />
              <Text style={styles.pillText}>Folder</Text>
            </Pressable>
          </>
        ) : null}

        <Pressable
          style={[styles.main, open && styles.mainOpen]}
          onPress={() => setOpen((v) => !v)}
          accessibilityLabel={open ? "Close" : "Create"}
        >
          <Icon
            name={open ? "close" : "plus"}
            size={28}
            color={open ? "#1A1C2C" : colors.text}
          />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    ...StyleSheet.absoluteFill,
    justifyContent: "flex-end",
    alignItems: "flex-end",
    zIndex: 40,
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: colors.overlay,
  },
  stack: {
    paddingRight: spacing.lg,
    alignItems: "flex-end",
    gap: spacing.md,
  },
  camera: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: "#5C3D4A",
    alignItems: "center",
    justifyContent: "center",
  },
  main: {
    width: 60,
    height: 60,
    borderRadius: 18,
    backgroundColor: colors.fab,
    alignItems: "center",
    justifyContent: "center",
  },
  mainOpen: {
    backgroundColor: colors.accentSoft,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: "#2B3548",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.pill,
  },
  pillText: {
    color: colors.text,
    fontWeight: "600",
    fontSize: 15,
  },
});
