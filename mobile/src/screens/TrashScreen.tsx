import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../api/client";
import type { FileItem, FolderItem } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import { FileRow } from "../components/FileRow";
import { FolderRow } from "../components/FolderRow";
import type { RootStackParamList } from "../navigation/types";
import { colors, radii, spacing } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Trash">;

type ListEntry =
  | { kind: "folder"; item: FolderItem }
  | { kind: "file"; item: FileItem };

export function TrashScreen({ navigation }: Props) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);

  useEffect(() => {
    navigation.setOptions({
      title: "Bin",
      headerStyle: { backgroundColor: colors.bg },
      headerTintColor: colors.text,
      headerTitleStyle: { fontWeight: "600" },
      headerShadowVisible: false,
    });
  }, [navigation]);

  const load = useCallback(async () => {
    setError("");
    try {
      const [trashedFolders, trashedFiles] = await Promise.all([
        api.trashedFolders(),
        api.trashedFiles(),
      ]);
      setFolders(trashedFolders);
      setFiles(trashedFiles);
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

  const entries: ListEntry[] = [
    ...folders.map((item) => ({ kind: "folder" as const, item })),
    ...files.map((item) => ({ kind: "file" as const, item })),
  ];

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <View style={styles.banner}>
        <Text style={styles.bannerText}>
          Items in the bin will be deleted forever after 30 days
        </Text>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.accent} />
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => `${item.kind}-${item.item.id}`}
          renderItem={({ item }) =>
            item.kind === "folder" ? (
              <FolderRow folder={item.item} onPress={() => undefined} />
            ) : (
              <FileRow file={item.item} />
            )
          }
          contentContainerStyle={entries.length === 0 ? styles.emptyContainer : undefined}
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
            <EmptyState title="Bin is empty" subtitle="Items you delete will appear here" />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  banner: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  bannerText: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  error: {
    color: colors.danger,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  emptyContainer: { flexGrow: 1 },
});
