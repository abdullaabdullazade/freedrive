import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../api/client";
import type { FileItem, StorageInfo } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import { FileRow } from "../components/FileRow";
import type { RootStackParamList } from "../navigation/types";
import { colors, radii, spacing } from "../theme";
import { formatBytes } from "../utils/format";
import { openFile } from "../utils/openFile";

type Props = NativeStackScreenProps<RootStackParamList, "Storage">;

export function StorageScreen({ navigation }: Props) {
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    navigation.setOptions({ title: "Storage", headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.text, headerShadowVisible: false });
  }, [navigation]);

  const load = useCallback(async () => {
    setError("");
    try {
      const [usage, result] = await Promise.all([api.myStorage(), api.listFiles({ page_size: 500 })]);
      setStorage(usage);
      setFiles([...result.files].sort((a, b) => (b.size || 0) - (a.size || 0)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const used = storage?.used_bytes ?? 0;
  const total = storage?.total_bytes ?? 0;
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <View style={styles.card}>
        <Text style={styles.heading}>{formatBytes(used)} used</Text>
        <Text style={styles.sub}>of {formatBytes(total)}</Text>
        <View style={styles.track}><View style={[styles.fill, { width: `${pct}%` }]} /></View>
      </View>
      <Text style={styles.section}>Largest files</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? <ActivityIndicator style={{ marginTop: 30 }} color={colors.accent} /> : (
        <FlatList
          data={files}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <FileRow file={item} subtitle={formatBytes(item.size)} onPress={() => void openFile(item, navigation, { gallery: files })} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.accent} />}
          contentContainerStyle={files.length === 0 ? { flexGrow: 1 } : undefined}
          ListEmptyComponent={<EmptyState title="No files" subtitle="Uploaded files appear here" />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  card: { margin: spacing.lg, padding: spacing.lg, borderRadius: radii.lg, backgroundColor: colors.surface },
  heading: { color: colors.text, fontSize: 22, fontWeight: "700" },
  sub: { color: colors.textSecondary, marginTop: 4 },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.surfaceElevated, overflow: "hidden", marginTop: spacing.lg },
  fill: { height: "100%", backgroundColor: "#F9AB00" },
  section: { color: colors.text, fontSize: 16, fontWeight: "600", marginHorizontal: spacing.lg, marginBottom: spacing.sm },
  error: { color: colors.danger, paddingHorizontal: spacing.lg },
});
