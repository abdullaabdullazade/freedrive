import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../api/client";
import type { StorageInfo } from "../api/types";
import { colors, radii, spacing } from "../theme";
import { formatBytes } from "../utils/format";
import { Icon, type IconName } from "./Icon";
import { Logo } from "./Logo";

export type DrawerRoute = "Recent" | "Trash";

interface AppDrawerProps {
  visible: boolean;
  onClose: () => void;
  onNavigate: (route: DrawerRoute) => void;
  onSettings?: () => void;
}

function DrawerItem({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress?: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
      onPress={onPress}
    >
      <Icon name={icon} size={20} color={colors.text} />
      <Text style={styles.itemLabel}>{label}</Text>
    </Pressable>
  );
}

export function AppDrawer({ visible, onClose, onNavigate, onSettings }: AppDrawerProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(320, width * 0.78);

  // Keep the modal mounted while the slide-out animation plays.
  const [rendered, setRendered] = useState(visible);
  const progress = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);
  const [storage, setStorage] = useState<StorageInfo | null>(null);

  useEffect(() => {
    if (visible) {
      closingRef.current = false;
      // Reset to off-screen before the modal shows; open animation starts in onShow.
      progress.setValue(0);
      setRendered(true);
      let cancelled = false;
      api
        .myStorage()
        .then((s) => {
          if (!cancelled) setStorage(s);
        })
        .catch(() => {
          if (!cancelled) setStorage(null);
        });
      return () => {
        cancelled = true;
      };
    }
    if (rendered && !closingRef.current) {
      closingRef.current = true;
      Animated.timing(progress, {
        toValue: 0,
        duration: 200,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        closingRef.current = false;
        setRendered(false);
      });
    }
  }, [visible, rendered, progress]);

  const onModalShow = () => {
    Animated.timing(progress, {
      toValue: 1,
      duration: 250,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  };

  const used = storage?.used_bytes ?? 0;
  const total = storage?.total_bytes ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;

  const go = (route: DrawerRoute) => {
    onClose();
    onNavigate(route);
  };

  if (!rendered) return null;

  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-panelWidth, 0],
  });

  return (
    <Modal
      visible
      transparent
      animationType="none"
      onShow={onModalShow}
      onRequestClose={onClose}
    >
      <View style={styles.backdropWrap}>
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.backdropFill, { opacity: progress }]}
        >
          <Pressable style={styles.backdrop} onPress={onClose} />
        </Animated.View>
        <Animated.View
          style={[
            styles.panel,
            {
              width: panelWidth,
              transform: [{ translateX }],
              paddingTop: insets.top + spacing.lg,
              paddingBottom: insets.bottom + spacing.lg,
            },
          ]}
        >
          <View style={styles.header}>
            <Logo size={28} />
            <Text style={styles.headerTitle}>FreeDrive</Text>
          </View>
          <View style={styles.divider} />

          <DrawerItem icon="clock" label="Recent" onPress={() => go("Recent")} />
          <DrawerItem icon="trash" label="Bin" onPress={() => go("Trash")} />
          <DrawerItem
            icon="settings"
            label="Settings"
            onPress={() => {
              onClose();
              onSettings?.();
            }}
          />
          <DrawerItem icon="help" label="Help and feedback" onPress={onClose} />

          <View style={styles.divider} />
          <View style={styles.storage}>
            <View style={styles.storageRow}>
              <Icon name="cloud" size={20} color={colors.text} />
              <Text style={styles.itemLabel}>
                Storage{total > 0 ? ` (${pct}% full)` : ""}
              </Text>
            </View>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${pct}%` }]} />
            </View>
            <Text style={styles.storageMeta}>
              {formatBytes(used)} of {formatBytes(total)} used
            </Text>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdropWrap: {
    flex: 1,
    flexDirection: "row",
  },
  backdropFill: {
    backgroundColor: colors.overlay,
  },
  backdrop: { flex: 1 },
  panel: {
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.md,
    borderTopRightRadius: radii.lg,
    borderBottomRightRadius: radii.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  headerTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "600",
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.sm,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    borderRadius: radii.pill,
  },
  itemPressed: { backgroundColor: colors.surface },
  itemLabel: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "500",
  },
  storage: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  storageRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    marginBottom: spacing.md,
  },
  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceElevated,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    backgroundColor: "#F9AB00",
  },
  storageMeta: {
    color: colors.textSecondary,
    fontSize: 13,
    marginTop: spacing.sm,
  },
});
