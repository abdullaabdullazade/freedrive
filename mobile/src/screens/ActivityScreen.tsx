import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../api/client";
import type { ActivityLog } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import type { RootStackParamList } from "../navigation/types";
import { colors, radii, spacing } from "../theme";
import { formatRelativeDate } from "../utils/format";

type Props = NativeStackScreenProps<RootStackParamList, "Activity">;

function actionLabel(item: ActivityLog): string {
  const action = (item.action || "activity").replaceAll("_", " ");
  return item.target_name ? `${action}: ${item.target_name}` : action;
}

export function ActivityScreen({ navigation }: Props) {
  const [items, setItems] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    navigation.setOptions({
      title: "Activity",
      headerStyle: { backgroundColor: colors.bg },
      headerTintColor: colors.text,
      headerShadowVisible: false,
    });
  }, [navigation]);

  const load = useCallback(async () => {
    setError("");
    try {
      setItems(await api.myActivity(100));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? <ActivityIndicator style={styles.loader} color={colors.accent} /> : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.accent} />}
          contentContainerStyle={items.length === 0 ? styles.empty : undefined}
          ListEmptyComponent={<EmptyState title="No activity" subtitle="Changes to your Drive appear here" />}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={styles.dot} />
              <View style={styles.meta}>
                <Text style={styles.title}>{actionLabel(item)}</Text>
                <Text style={styles.sub}>{item.username || "You"} • {formatRelativeDate(item.created_at)}</Text>
              </View>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  loader: { marginTop: 40 },
  error: { color: colors.danger, padding: spacing.lg },
  empty: { flexGrow: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginHorizontal: spacing.lg, padding: spacing.md, borderRadius: radii.md },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  meta: { flex: 1 },
  title: { color: colors.text, fontSize: 15, textTransform: "capitalize" },
  sub: { color: colors.textSecondary, fontSize: 12, marginTop: 3 },
});
