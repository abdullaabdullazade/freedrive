import type { NativeStackScreenProps } from "@react-navigation/native-stack";
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
import { api, ApiError } from "../api/client";
import type { FileApproval } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { EmptyState } from "../components/EmptyState";
import type { RootStackParamList } from "../navigation/types";
import { colors, radii, spacing } from "../theme";
import { formatRelativeDate } from "../utils/format";

type Props = NativeStackScreenProps<RootStackParamList, "Approvals">;

export function ApprovalsScreen({ navigation }: Props) {
  const { user } = useAuth();
  const [items, setItems] = useState<FileApproval[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    navigation.setOptions({
      title: "Approvals",
      headerStyle: { backgroundColor: colors.bg },
      headerTintColor: colors.text,
      headerTitleStyle: { fontWeight: "600" },
      headerShadowVisible: false,
    });
  }, [navigation]);

  const load = useCallback(async () => {
    setError("");
    try {
      const approvals = await api.listApprovals();
      setItems(approvals);
      const uniqueIds = [...new Set(approvals.map((item) => item.file_id))];
      const results = await Promise.all(
        uniqueIds.map(async (id) => {
          try {
            return [id, (await api.getFile(id)).name] as const;
          } catch {
            return [id, "File"] as const;
          }
        }),
      );
      setNames(Object.fromEntries(results));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (approval: FileApproval, status: "approved" | "rejected") => {
    try {
      await api.updateApproval(approval.id, status);
      await load();
    } catch (err) {
      Alert.alert("Could not update approval", err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.accent} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={items.length === 0 ? styles.empty : styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load();
              }}
              tintColor={colors.accent}
            />
          }
          renderItem={({ item }) => {
            const canDecide = item.status === "pending" && item.approver_id === user?.id;
            return (
              <View style={styles.card}>
                <Text style={styles.title}>{names[item.file_id] || "File"}</Text>
                <Text style={styles.meta}>
                  {item.requested_by === user?.id ? "Requested by you" : "Needs your review"} · {formatRelativeDate(item.created_at)}
                </Text>
                <Text style={[styles.status, item.status === "rejected" && { color: colors.danger }]}>
                  {item.status.toUpperCase()}
                </Text>
                {canDecide ? (
                  <View style={styles.actions}>
                    <Pressable style={styles.reject} onPress={() => void decide(item, "rejected")}>
                      <Text style={styles.rejectText}>Reject</Text>
                    </Pressable>
                    <Pressable style={styles.approve} onPress={() => void decide(item, "approved")}>
                      <Text style={styles.approveText}>Approve</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            );
          }}
          ListEmptyComponent={<EmptyState title="No approvals" subtitle="Approval requests will appear here" />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md },
  empty: { flexGrow: 1 },
  error: { color: colors.danger, padding: spacing.lg },
  card: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.lg },
  title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  meta: { color: colors.textSecondary, fontSize: 13, marginTop: 5 },
  status: { color: colors.accent, fontSize: 12, fontWeight: "700", marginTop: spacing.sm },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm, marginTop: spacing.md },
  reject: { borderWidth: 1, borderColor: colors.danger, borderRadius: radii.pill, paddingHorizontal: 18, paddingVertical: 9 },
  rejectText: { color: colors.danger, fontWeight: "600" },
  approve: { backgroundColor: colors.accentSoft, borderRadius: radii.pill, paddingHorizontal: 18, paddingVertical: 9 },
  approveText: { color: "#0B1C2C", fontWeight: "600" },
});
