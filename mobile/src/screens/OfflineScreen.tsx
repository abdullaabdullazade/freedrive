import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { EmptyState } from "../components/EmptyState";
import { FileRow } from "../components/FileRow";
import type { RootStackParamList } from "../navigation/types";
import { listOfflineFiles, type OfflineFile } from "../offline/files";
import { colors, spacing } from "../theme";
import { formatBytes } from "../utils/format";
import { openLocalFile } from "../utils/openFile";

type Props = NativeStackScreenProps<RootStackParamList, "Offline">;

export function OfflineScreen({ navigation }: Props) {
  const [items, setItems] = useState<OfflineFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    navigation.setOptions({ title: "Offline", headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false });
  }, [navigation]);

  const load = useCallback(async () => {
    setError("");
    try {
      setItems(await listOfflineFiles());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? <ActivityIndicator style={{ marginTop: 40 }} color={colors.accent} /> : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.file.id}
          renderItem={({ item }) => (
            <FileRow
              file={item.file}
              subtitle={`Available offline • ${formatBytes(item.file.size)}`}
              onPress={() => void openLocalFile(item.file, item.uri, item.mime, navigation)}
            />
          )}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.accent} />}
          contentContainerStyle={items.length === 0 ? styles.empty : undefined}
          ListEmptyComponent={<EmptyState title="No offline files" subtitle="Choose Available offline from a file menu" />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  error: { color: colors.danger, padding: spacing.lg },
  empty: { flexGrow: 1 },
});
