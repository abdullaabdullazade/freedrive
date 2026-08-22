import * as Clipboard from "expo-clipboard";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, ApiError } from "../api/client";
import type { FileItem, FolderItem, ShareLink, SharedItem } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { colors, radii, spacing } from "../theme";
import { formatBytes, formatRelativeDate } from "../utils/format";
import { copyText, downloadFileToDevice, downloadFileToShare } from "../utils/openFile";
import { Icon, type IconName } from "./Icon";

export type ItemTarget =
  | { kind: "file"; item: FileItem }
  | { kind: "folder"; item: FolderItem };

interface ItemActionsSheetProps {
  target: ItemTarget | null;
  onClose: () => void;
  onChanged: () => void;
}

type Dialog = "none" | "rename" | "move" | "info" | "color" | "share";

type ActionRow = {
  key: string;
  label: string;
  icon: IconName;
  danger?: boolean;
  dividerAfter?: boolean;
};

const FOLDER_COLORS = [
  "#DADCE0",
  "#F28B82",
  "#FBBC04",
  "#FFF475",
  "#CCFF90",
  "#A7FFEB",
  "#CBF0F8",
  "#AECBFA",
  "#D7AEFB",
  "#FDCFE8",
];

function publicLinkUrl(serverUrl: string | null, token: string): string {
  const base = (serverUrl || "").replace(/\/$/, "");
  return `${base}/api/v1/public/share/${token}/download`;
}

export function ItemActionsSheet({ target, onClose, onChanged }: ItemActionsSheetProps) {
  const insets = useSafeAreaInsets();
  const { serverUrl } = useAuth();
  const [rendered, setRendered] = useState(Boolean(target));
  const [dialog, setDialog] = useState<Dialog>("none");
  const [busy, setBusy] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [shareEmail, setShareEmail] = useState("");
  const [shares, setShares] = useState<SharedItem[]>([]);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const progress = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);

  useEffect(() => {
    if (target) {
      closingRef.current = false;
      progress.setValue(0);
      setDialog("none");
      setRenameValue(target.item.name);
      setRendered(true);
    } else if (rendered && !closingRef.current) {
      closingRef.current = true;
      Animated.timing(progress, {
        toValue: 0,
        duration: 200,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        closingRef.current = false;
        setRendered(false);
        setDialog("none");
      });
    }
  }, [target, rendered, progress]);

  const onModalShow = () => {
    Animated.timing(progress, {
      toValue: 1,
      duration: 250,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  };

  if (!rendered || !target) return null;

  const starred = target.item.is_starred;
  const fileActions: ActionRow[] = [
    { key: "share", label: "Share", icon: "person_add" },
    { key: "manage", label: "Manage access", icon: "people", dividerAfter: true },
    {
      key: "star",
      label: starred ? "Remove from starred" : "Add to starred",
      icon: starred ? "star_filled" : "star",
      dividerAfter: true,
    },
    { key: "link", label: "Copy link", icon: "link", dividerAfter: true },
    { key: "download", label: "Download", icon: "download" },
    { key: "rename", label: "Rename", icon: "rename" },
    { key: "move", label: "Move", icon: "move" },
    { key: "info", label: "View information", icon: "info", dividerAfter: true },
    { key: "trash", label: "Move to bin", icon: "trash", danger: true },
  ];

  const folderActions: ActionRow[] = [
    { key: "share", label: "Share", icon: "person_add" },
    { key: "manage", label: "Manage access", icon: "people", dividerAfter: true },
    {
      key: "star",
      label: starred ? "Remove from starred" : "Add to starred",
      icon: starred ? "star_filled" : "star",
      dividerAfter: true,
    },
    { key: "link", label: "Copy link", icon: "link", dividerAfter: true },
    { key: "rename", label: "Rename", icon: "rename" },
    { key: "color", label: "Change colour", icon: "palette" },
    { key: "move", label: "Move", icon: "move" },
    { key: "info", label: "View information", icon: "info", dividerAfter: true },
    { key: "trash", label: "Move to bin", icon: "trash", danger: true },
  ];

  const actions = target.kind === "file" ? fileActions : folderActions;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      // Mutation may have succeeded server-side before the client timed out.
      onChanged();
      Alert.alert("Error", err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadShareData = async () => {
    const [byMe, allLinks] = await Promise.all([api.sharedByMe(), api.listLinks()]);
    const id = target.item.id;
    setShares(
      byMe.filter((s) =>
        target.kind === "file" ? s.item_id === id || s.share.file_id === id : s.item_id === id || s.share.folder_id === id,
      ),
    );
    setLinks(
      allLinks.filter((l) =>
        target.kind === "file" ? l.file_id === id : l.folder_id === id,
      ),
    );
  };

  const onAction = (key: string) => {
    if (key === "share" || key === "manage") {
      setDialog("share");
      loadShareData().catch((err) =>
        Alert.alert("Error", err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    if (key === "rename") {
      setRenameValue(target.item.name);
      setDialog("rename");
      return;
    }
    if (key === "move") {
      setDialog("move");
      api.listAllFolders().then(setFolders).catch((err) =>
        Alert.alert("Error", err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    if (key === "info") {
      setDialog("info");
      return;
    }
    if (key === "color") {
      setDialog("color");
      return;
    }
    if (key === "star") {
      void run(async () => {
        if (target.kind === "file") {
          await api.updateFile(target.item.id, { is_starred: !starred });
        } else {
          await api.updateFolder(target.item.id, { is_starred: !starred });
        }
        onChanged();
        onClose();
      });
      return;
    }
    if (key === "trash") {
      Alert.alert("Move to bin?", target.item.name, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Move to bin",
          style: "destructive",
          onPress: () =>
            void run(async () => {
              if (target.kind === "file") await api.deleteFile(target.item.id);
              else await api.deleteFolder(target.item.id);
              onChanged();
              onClose();
            }),
        },
      ]);
      return;
    }
    if (key === "download" && target.kind === "file") {
      onClose();
      void downloadFileToDevice(target.item);
      return;
    }
    if (key === "link") {
      void run(async () => {
        const body =
          target.kind === "file"
            ? { file_id: target.item.id, permission: "read" }
            : { folder_id: target.item.id, permission: "read" };
        let link = (await api.listLinks()).find((l) =>
          target.kind === "file" ? l.file_id === target.item.id : l.folder_id === target.item.id,
        );
        if (!link) link = await api.createLink(body);
        const url = publicLinkUrl(serverUrl, link.token);
        await copyText(url);
        Alert.alert("Link copied", url);
        onClose();
      });
    }
  };

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [480, 0],
  });

  return (
    <Modal visible transparent animationType="none" onShow={onModalShow} onRequestClose={onClose}>
      <View style={styles.wrap}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress, backgroundColor: colors.overlay }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>

        <Animated.View
          style={[
            styles.sheet,
            { paddingBottom: insets.bottom + 12, transform: [{ translateY }] },
          ]}
        >
          <View style={styles.grabber} />
          <View style={styles.header}>
            <View style={styles.headerIcon}>
              <Icon
                name={target.kind === "folder" ? "folder" : "doc"}
                size={22}
                color={target.kind === "folder" ? colors.folder : "#FFFFFF"}
              />
            </View>
            <Text style={styles.headerTitle} numberOfLines={2}>
              {target.item.name}
            </Text>
          </View>

          {busy ? <ActivityIndicator color={colors.accent} style={{ marginVertical: 12 }} /> : null}

          {dialog === "none" ? (
            <ScrollView style={{ maxHeight: 420 }}>
              {actions.map((a) => (
                <React.Fragment key={a.key}>
                  <Pressable style={styles.row} onPress={() => onAction(a.key)}>
                    <Icon name={a.icon} size={22} color={a.danger ? colors.danger : colors.text} />
                    <Text style={[styles.rowLabel, a.danger && { color: colors.danger }]}>{a.label}</Text>
                  </Pressable>
                  {a.dividerAfter ? <View style={styles.divider} /> : null}
                </React.Fragment>
              ))}
            </ScrollView>
          ) : null}

          {dialog === "rename" ? (
            <View style={styles.dialog}>
              <Text style={styles.dialogTitle}>Rename</Text>
              <TextInput
                style={styles.input}
                value={renameValue}
                onChangeText={setRenameValue}
                autoFocus
                selectTextOnFocus
              />
              <View style={styles.dialogActions}>
                <Pressable onPress={() => setDialog("none")}>
                  <Text style={styles.linkBtn}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={() =>
                    void run(async () => {
                      const name = renameValue.trim();
                      if (!name) return;
                      if (target.kind === "file") await api.updateFile(target.item.id, { name });
                      else await api.updateFolder(target.item.id, { name });
                      onChanged();
                      onClose();
                    })
                  }
                >
                  <Text style={styles.linkBtnPrimary}>Save</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {dialog === "move" ? (
            <View style={styles.dialog}>
              <Text style={styles.dialogTitle}>Move to</Text>
              <Pressable
                style={styles.row}
                onPress={() =>
                  void run(async () => {
                    if (target.kind === "file") {
                      await api.updateFile(target.item.id, { folder_id: null });
                    } else {
                      await api.updateFolder(target.item.id, { parent_id: null });
                    }
                    onChanged();
                    onClose();
                  })
                }
              >
                <Icon name="folder" size={22} color={colors.folder} />
                <Text style={styles.rowLabel}>My Drive (root)</Text>
              </Pressable>
              <FlatList
                data={folders.filter((f) => f.id !== target.item.id)}
                keyExtractor={(f) => f.id}
                style={{ maxHeight: 280 }}
                renderItem={({ item }) => (
                  <Pressable
                    style={styles.row}
                    onPress={() =>
                      void run(async () => {
                        if (target.kind === "file") {
                          await api.updateFile(target.item.id, { folder_id: item.id });
                        } else {
                          await api.updateFolder(target.item.id, { parent_id: item.id });
                        }
                        onChanged();
                        onClose();
                      })
                    }
                  >
                    <Icon name="folder" size={22} color={item.color || colors.folder} />
                    <Text style={styles.rowLabel}>{item.name}</Text>
                  </Pressable>
                )}
              />
              <Pressable onPress={() => setDialog("none")}>
                <Text style={[styles.linkBtn, { marginTop: 8 }]}>Back</Text>
              </Pressable>
            </View>
          ) : null}

          {dialog === "info" ? (
            <View style={styles.dialog}>
              <Text style={styles.dialogTitle}>Information</Text>
              <InfoLine label="Name" value={target.item.name} />
              {target.kind === "file" ? (
                <>
                  <InfoLine label="Type" value={target.item.mime_type || "—"} />
                  <InfoLine label="Size" value={formatBytes(target.item.size)} />
                </>
              ) : (
                <InfoLine label="Colour" value={target.item.color || "Default"} />
              )}
              <InfoLine label="Modified" value={formatRelativeDate(target.item.updated_at)} />
              <InfoLine label="Created" value={formatRelativeDate(target.item.created_at)} />
              <Pressable onPress={() => setDialog("none")} style={{ marginTop: 12 }}>
                <Text style={styles.linkBtn}>Back</Text>
              </Pressable>
            </View>
          ) : null}

          {dialog === "color" && target.kind === "folder" ? (
            <View style={styles.dialog}>
              <Text style={styles.dialogTitle}>Change colour</Text>
              <View style={styles.colorGrid}>
                {FOLDER_COLORS.map((c) => (
                  <Pressable
                    key={c}
                    style={[styles.colorDot, { backgroundColor: c }]}
                    onPress={() =>
                      void run(async () => {
                        await api.updateFolder(target.item.id, { color: c });
                        onChanged();
                        onClose();
                      })
                    }
                  />
                ))}
              </View>
              <Pressable onPress={() => setDialog("none")}>
                <Text style={styles.linkBtn}>Back</Text>
              </Pressable>
            </View>
          ) : null}

          {dialog === "share" ? (
            <View style={styles.dialog}>
              <Text style={styles.dialogTitle}>Share & access</Text>

              {target.kind === "file" ? (
                <>
                  <Pressable
                    style={styles.row}
                    onPress={() => {
                      const file = target.item;
                      onClose();
                      void downloadFileToShare(file);
                    }}
                  >
                    <Icon name="share" size={22} color={colors.text} />
                    <Text style={styles.rowLabel}>Send a copy</Text>
                  </Pressable>
                  <View style={styles.divider} />
                </>
              ) : null}

              <TextInput
                style={styles.input}
                placeholder="Email address"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                keyboardType="email-address"
                value={shareEmail}
                onChangeText={setShareEmail}
              />
              <Pressable
                style={styles.primaryBtn}
                onPress={() =>
                  void run(async () => {
                    const email = shareEmail.trim().toLowerCase();
                    if (!email) return;
                    await api.createUserShare({
                      ...(target.kind === "file"
                        ? { file_id: target.item.id }
                        : { folder_id: target.item.id }),
                      shared_email: email,
                      permission: "read",
                    });
                    setShareEmail("");
                    await loadShareData();
                    onChanged();
                  })
                }
              >
                <Text style={styles.primaryBtnText}>Share</Text>
              </Pressable>

              {shares.map((s) => (
                <View key={s.share.id} style={styles.shareRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowLabel}>{s.share.shared_with}</Text>
                    <Text style={styles.sub}>{s.share.permission}</Text>
                  </View>
                  <Pressable
                    onPress={() =>
                      void run(async () => {
                        await api.deleteUserShare(s.share.id);
                        await loadShareData();
                        onChanged();
                      })
                    }
                  >
                    <Text style={{ color: colors.danger }}>Remove</Text>
                  </Pressable>
                </View>
              ))}

              <View style={styles.divider} />
              <Text style={styles.dialogTitle}>Public link</Text>
              {links.length === 0 ? (
                <Pressable
                  style={styles.primaryBtn}
                  onPress={() =>
                    void run(async () => {
                      await api.createLink({
                        ...(target.kind === "file"
                          ? { file_id: target.item.id }
                          : { folder_id: target.item.id }),
                        permission: "read",
                      });
                      await loadShareData();
                    })
                  }
                >
                  <Text style={styles.primaryBtnText}>Create link</Text>
                </Pressable>
              ) : (
                links.map((l) => {
                  const url = publicLinkUrl(serverUrl, l.token);
                  return (
                    <View key={l.id} style={{ marginBottom: 8 }}>
                      <Text style={styles.sub} numberOfLines={2}>
                        {url}
                      </Text>
                      <View style={styles.dialogActions}>
                        <Pressable
                          onPress={async () => {
                            await Clipboard.setStringAsync(url);
                            Alert.alert("Copied");
                          }}
                        >
                          <Text style={styles.linkBtnPrimary}>Copy</Text>
                        </Pressable>
                        <Pressable
                          onPress={() =>
                            void run(async () => {
                              await api.deleteLink(l.id);
                              await loadShareData();
                            })
                          }
                        >
                          <Text style={{ color: colors.danger }}>Remove</Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                })
              )}

              <Pressable onPress={() => setDialog("none")} style={{ marginTop: 8 }}>
                <Text style={styles.linkBtn}>Back</Text>
              </Pressable>
            </View>
          ) : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={styles.sub}>{label}</Text>
      <Text style={styles.rowLabel}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#1E1F20",
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    maxHeight: "88%",
  },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#5F6368",
    marginTop: 8,
    marginBottom: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  headerIcon: {
    width: 40,
    height: 40,
    borderRadius: radii.sm,
    backgroundColor: colors.doc,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { flex: 1, color: colors.text, fontSize: 18, fontWeight: "500" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    paddingVertical: 14,
  },
  rowLabel: { color: colors.text, fontSize: 16, flex: 1 },
  sub: { color: colors.textSecondary, fontSize: 13 },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: 4,
  },
  dialog: { paddingBottom: spacing.md },
  dialogTitle: { color: colors.text, fontSize: 16, fontWeight: "600", marginBottom: spacing.md },
  input: {
    backgroundColor: colors.inputBg,
    color: colors.text,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.md,
  },
  dialogActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.xl },
  linkBtn: { color: colors.textSecondary, fontSize: 15, fontWeight: "500" },
  linkBtnPrimary: { color: colors.accent, fontSize: 15, fontWeight: "600" },
  colorGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginBottom: spacing.lg },
  colorDot: { width: 40, height: 40, borderRadius: 20 },
  primaryBtn: {
    backgroundColor: colors.accentSoft,
    borderRadius: radii.pill,
    paddingVertical: 12,
    alignItems: "center",
    marginBottom: spacing.md,
  },
  primaryBtnText: { color: "#0B1C2C", fontWeight: "600" },
  shareRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: 8,
  },
});
