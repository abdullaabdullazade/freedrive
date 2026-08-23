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
import type { CompositeScreenProps } from "@react-navigation/native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../api/client";
import type { FileItem } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import { FileRow } from "../components/FileRow";
import { ItemActionsSheet, type ItemTarget } from "../components/ItemActionsSheet";
import type { MainTabParamList, RootStackParamList } from "../navigation/types";
import { colors, spacing } from "../theme";
import { openFile } from "../utils/openFile";

type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, "Starred">,
  NativeStackScreenProps<RootStackParamList>
>;

export function StarredScreen({ navigation }: Props) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [menuTarget, setMenuTarget] = useState<ItemTarget | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await api.listFiles({
        starred: true,
        page_size: 100,
        sort: "updated_at",
        dir: "desc",
      });
      setFiles(data.files);
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

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ItemActionsSheet
        target={menuTarget}
        onClose={() => setMenuTarget(null)}
        onChanged={load}
      />
      <View style={styles.header}>
        <Text style={styles.title}>Starred</Text>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.accent} />
      ) : (
        <FlatList
          data={files}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <FileRow
              file={item}
              onPress={() => openFile(item, navigation, { gallery: files })}
              onMenuPress={() => setMenuTarget({ kind: "file", item })}
            />
          )}
          contentContainerStyle={files.length === 0 ? styles.emptyContainer : undefined}
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
              title="No starred files"
              subtitle="Star files to see them here"
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
  emptyContainer: { flexGrow: 1 },
});
