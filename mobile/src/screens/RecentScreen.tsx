import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../api/client";
import type { FileItem } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import { FileRow } from "../components/FileRow";
import type { RootStackParamList } from "../navigation/types";
import { colors, spacing } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Recent">;

export function RecentScreen({ navigation }: Props) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [files, setFiles] = useState<FileItem[]>([]);

  useEffect(() => {
    navigation.setOptions({
      title: "Recent",
      headerStyle: { backgroundColor: colors.bg },
      headerTintColor: colors.text,
      headerTitleStyle: { fontWeight: "600" },
      headerShadowVisible: false,
    });
  }, [navigation]);

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await api.listFiles({ sort: "updated_at", dir: "desc", page_size: 100 });
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
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.accent} />
      ) : (
        <FlatList
          data={files}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <FileRow file={item} />}
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
            <EmptyState title="No recent files" subtitle="Recently modified files appear here" />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  error: {
    color: colors.danger,
    paddingHorizontal: spacing.lg,
    marginVertical: spacing.sm,
  },
  emptyContainer: { flexGrow: 1 },
});
