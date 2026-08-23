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
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import type { StorageInfo, User } from "../api/types";
import { formatBytes } from "../utils/format";
import { UserAvatar } from "./UserAvatar";

interface ProfileMenuProps {
  visible: boolean;
  onClose: () => void;
  onSettings: () => void;
  onStorage: () => void;
  onAdmin: () => void;
  onLegal: (document: "privacy" | "terms") => void;
}

function displayName(user: User | null): string {
  if (!user) return "User";
  if (user.username?.trim()) return user.username.trim();
  const email = user.email || "";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email || "User";
}

export function ProfileMenu({ visible, onClose, onSettings, onStorage, onAdmin, onLegal }: ProfileMenuProps) {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(340, width * 0.85);

  const [rendered, setRendered] = useState(visible);
  const progress = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);
  const [storage, setStorage] = useState<StorageInfo | null>(null);

  useEffect(() => {
    if (visible) {
      closingRef.current = false;
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
  const usedPct = total > 0 ? Math.round((used / total) * 100) : null;
  const storageWarning = usedPct !== null && usedPct >= 80;
  const openNative = (action: () => void) => {
    onClose();
    action();
  };

  const onSignOut = () => {
    onClose();
    logout().catch(console.error);
  };

  if (!rendered) return null;

  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [panelWidth, 0],
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
        <View style={styles.spacer} />
        <Animated.View
          style={[
            styles.panel,
            {
              width: panelWidth,
              transform: [{ translateX }],
              marginTop: insets.top + 8,
              marginBottom: insets.bottom + 8,
              marginRight: 12,
            },
          ]}
        >
          <Pressable style={styles.closeBtn} onPress={onClose} hitSlop={8}>
            <Text style={styles.closeText}>×</Text>
          </Pressable>

          <View style={styles.header}>
            <UserAvatar size={80} />
            <View style={styles.headerText}>
              <Text style={styles.greeting}>Hi, {displayName(user)}!</Text>
              <Text style={styles.email} numberOfLines={1}>
                {user?.email}
              </Text>
              {user?.role === "admin" ? <Text style={styles.roleBadge}>Administrator</Text> : null}
            </View>
          </View>

          <View style={styles.actions}>
            <Pressable style={styles.actionBtn} onPress={() => openNative(onSettings)}>
              <Text style={styles.actionBtnText}>Manage account</Text>
            </Pressable>
            <Pressable style={styles.signOutBtn} onPress={onSignOut}>
              <Text style={styles.signOutText}>Sign out</Text>
            </Pressable>
          </View>

          {user?.role === "admin" ? (
            <Pressable style={styles.adminBtn} onPress={() => openNative(onAdmin)}>
              <Text style={styles.adminBtnText}>Open admin panel</Text>
            </Pressable>
          ) : null}

          {storage && total > 0 ? (
            <View style={styles.storage}>
              <View style={styles.storageHeader}>
                {storageWarning ? (
                  <View style={styles.warnBadge}>
                    <Text style={styles.warnText}>!</Text>
                  </View>
                ) : null}
                <Text style={styles.storageLabel}>
                  {formatBytes(used)} of {formatBytes(total)} used
                </Text>
                <Text style={styles.storagePercent}>{usedPct ?? 0}%</Text>
              </View>
              <View style={styles.barTrack}>
                <View
                  style={[styles.barFill, { width: `${Math.min(100, usedPct ?? 0)}%` }]}
                />
              </View>
              <Pressable style={styles.storageAction} onPress={() => openNative(onStorage)}>
                <Text style={styles.storageLink}>Manage storage</Text>
                <Text style={styles.storageArrow}>›</Text>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.footer}>
            <Pressable onPress={() => openNative(() => onLegal("privacy"))}>
              <Text style={styles.footerLink}>Privacy Policy</Text>
            </Pressable>
            <Text style={styles.footerDot}>·</Text>
            <Pressable onPress={() => openNative(() => onLegal("terms"))}>
              <Text style={styles.footerLink}>Terms of Service</Text>
            </Pressable>
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
    alignItems: "flex-start",
  },
  backdropFill: {
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  backdrop: { flex: 1 },
  spacer: { flex: 1 },
  panel: {
    backgroundColor: "#1E1F20",
    borderWidth: 1,
    borderColor: "#3C4043",
    borderRadius: 16,
    paddingTop: 20,
    paddingHorizontal: 20,
    paddingBottom: 16,
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
    alignSelf: "flex-start",
  },
  closeBtn: {
    position: "absolute",
    top: 12,
    right: 12,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  closeText: {
    color: "#9AA0A6",
    fontSize: 22,
    lineHeight: 24,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    marginBottom: 20,
    paddingRight: 28,
  },
  headerText: { flex: 1, minWidth: 0 },
  greeting: {
    color: "#E3E3E3",
    fontSize: 22,
    fontWeight: "400",
    marginBottom: 4,
  },
  email: {
    color: "#9AA0A6",
    fontSize: 14,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 12,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#3C4043",
    backgroundColor: "#28292A",
    alignItems: "center",
  },
  actionBtnText: {
    color: "#E3E3E3",
    fontSize: 13,
    fontWeight: "500",
  },
  signOutBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  signOutText: { color: "#F28B82", fontSize: 13, fontWeight: "600" },
  adminBtn: {
    borderRadius: 12,
    backgroundColor: "#0B3A5B",
    paddingVertical: 12,
    alignItems: "center",
    marginBottom: 18,
  },
  adminBtnText: { color: "#A8C7FA", fontSize: 14, fontWeight: "700" },
  roleBadge: {
    alignSelf: "flex-start",
    marginTop: 7,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "#0B3A5B",
    color: "#A8C7FA",
    fontSize: 11,
    fontWeight: "700",
  },
  storage: {
    marginBottom: 16,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#28292A",
  },
  storageHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  warnBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#F9AB00",
    alignItems: "center",
    justifyContent: "center",
  },
  warnText: {
    color: "#202124",
    fontSize: 12,
    fontWeight: "700",
  },
  storageLabel: {
    color: "#9AA0A6",
    fontSize: 13,
    flex: 1,
  },
  storagePercent: { color: "#E3E3E3", fontSize: 12, fontWeight: "600" },
  storageLink: {
    color: "#A8C7FA",
    fontSize: 13,
    fontWeight: "600",
  },
  storageAction: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 10 },
  storageArrow: { color: "#A8C7FA", fontSize: 20, lineHeight: 20 },
  barTrack: {
    height: 4,
    borderRadius: 999,
    backgroundColor: "#28292A",
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    backgroundColor: "#A8C7FA",
    borderRadius: 999,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#3C4043",
  },
  footerLink: {
    color: "#A8C7FA",
    fontSize: 12,
  },
  footerDot: {
    color: "#9AA0A6",
    fontSize: 12,
  },
});
