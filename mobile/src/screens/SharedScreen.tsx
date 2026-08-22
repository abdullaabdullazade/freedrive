import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { CompositeScreenProps } from "@react-navigation/native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../api/client";
import type { SharedItem } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import type { MainTabParamList, RootStackParamList } from "../navigation/types";
import { colors, radii, spacing } from "../theme";
import { formatRelativeDate } from "../utils/format";
import { openFile } from "../utils/openFile";

type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, "Shared">,
  NativeStackScreenProps<RootStackParamList>
>;

export function SharedScreen({ navigation }: Props) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState<SharedItem[]>([]);

  const load = useCallback(async () => {
    setError("");
    try {
      const list = await api.sharedWithMe();
      setItems(list);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onPress = (item: SharedItem) => {
    if (item.item_type === "folder" || item.share?.folder_id) {
      navigation.navigate("Files", {
        screen: "Folder",
        params: {
          folderId: item.item_id || String(item.share.folder_id),
          title: item.item_name || "Shared folder",
        },
      });
      return;
    }
    // Shared files: fetch metadata then open
    if (item.item_id) {
      api
        .getFile(item.item_id)
        .then((file) => openFile(file, navigation))
        .catch((err) =>
          Alert.alert("Cannot open", err instanceof Error ? err.message : String(err)),
        );
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Shared</Text>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.accent} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item, index) => String(item.share?.id || item.item_id || index)}
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => onPress(item)}>
              <View style={styles.icon}>
                <Icon
                  name={item.item_type === "folder" || item.share?.folder_id ? "folder" : "doc"}
                  size={22}
                  color={colors.folder}
                />
              </View>
              <View style={styles.meta}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.item_name || "Shared item"}
                </Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {item.owner_email || item.owner_name || "Shared with you"}
                  {item.share?.created_at
                    ? ` · ${formatRelativeDate(item.share.created_at)}`
                    : ""}
                </Text>
              </View>
            </Pressable>
          )}
          contentContainerStyle={items.length === 0 ? styles.emptyContainer : undefined}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load();
              }}
              tintColor={colors.accent}
            />
          }
          ListEmptyComponent={
            <EmptyState
              title="Nothing shared with you"
              subtitle="Files and folders shared with your account will appear here"
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: "700",
  },
  error: {
    color: colors.danger,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
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
  glyph: { fontSize: 20 },
  meta: { flex: 1, minWidth: 0 },
  name: { color: colors.text, fontSize: 16, fontWeight: "500" },
  sub: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  emptyContainer: { flexGrow: 1 },
});
