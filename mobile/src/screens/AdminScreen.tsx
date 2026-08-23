import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, ApiError } from "../api/client";
import type { ActivityLog, AdminStats, AdminStorageBucket, User } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import type { RootStackParamList } from "../navigation/types";
import { colors, radii, spacing } from "../theme";
import { formatBytes, formatRelativeDate } from "../utils/format";

type Props = NativeStackScreenProps<RootStackParamList, "Admin">;

export function AdminScreen({ navigation }: Props) {
  const { user } = useAuth();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [activity, setActivity] = useState<ActivityLog[]>([]);
  const [breakdown, setBreakdown] = useState<Record<string, AdminStorageBucket>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    navigation.setOptions({
      title: "Admin panel",
      headerStyle: { backgroundColor: colors.bg },
      headerTintColor: colors.text,
      headerTitleStyle: { fontWeight: "600" },
      headerShadowVisible: false,
    });
  }, [navigation]);

  const load = useCallback(async () => {
    if (user?.role !== "admin") {
      setError("Administrator access is required.");
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setError("");
    try {
      const [nextStats, nextUsers, nextActivity, nextBreakdown] = await Promise.all([
        api.adminStats(),
        api.adminUsers(),
        api.adminActivity(),
        api.adminStorageBreakdown(),
      ]);
      setStats(nextStats);
      setUsers(nextUsers);
      setActivity(nextActivity);
      setBreakdown(nextBreakdown);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.role]);

  useEffect(() => { void load(); }, [load]);

  const storageRows = useMemo(
    () => Object.entries(breakdown).sort((a, b) => b[1].size - a[1].size),
    [breakdown],
  );

  const manageUser = (target: User) => {
    if (target.id === user?.id) {
      Alert.alert("Current administrator", "Your own account cannot be suspended from this screen.");
      return;
    }
    Alert.alert(target.username || target.email, target.email, [
      { text: "Cancel", style: "cancel" },
      {
        text: target.suspended ? "Activate account" : "Suspend account",
        style: target.suspended ? "default" : "destructive",
        onPress: () => void api.adminUpdateUser(target.id, { suspended: !target.suspended })
          .then(load)
          .catch((err) => Alert.alert("Update failed", String(err))),
      },
      {
        text: "Sign out devices",
        onPress: () => void api.adminRevokeUserSessions(target.id)
          .then(() => Alert.alert("Sessions revoked"))
          .catch((err) => Alert.alert("Revoke failed", String(err))),
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      {loading ? <ActivityIndicator style={{ marginTop: 48 }} color={colors.accent} size="large" /> : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.accent} />}
        >
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {stats ? (
            <>
              <Text style={styles.heading}>Workspace overview</Text>
              <View style={styles.statsGrid}>
                <StatCard icon="people" label="Users" value={String(stats.total_users)} />
                <StatCard icon="cloud" label="Storage used" value={formatBytes(stats.total_used)} />
                <StatCard icon="file" label="Total quota" value={formatBytes(stats.total_quota)} />
              </View>
            </>
          ) : null}

          <Section title="Storage breakdown">
            {storageRows.length === 0 ? <Text style={styles.secondary}>No stored files.</Text> : storageRows.map(([name, bucket]) => (
              <View key={name} style={styles.dataRow}>
                <Text style={styles.rowName}>{name[0]?.toUpperCase()}{name.slice(1)}</Text>
                <Text style={styles.secondary}>{bucket.count} files · {formatBytes(bucket.size)}</Text>
              </View>
            ))}
          </Section>

          <Section title="Users">
            {users.map((item) => (
              <Pressable key={item.id} style={styles.userRow} onPress={() => manageUser(item)}>
                <View style={[styles.avatar, item.suspended && { backgroundColor: colors.danger }]}>
                  <Text style={styles.avatarText}>{(item.username || item.email || "U").slice(0, 1).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowName}>{item.username || "User"}{item.id === user?.id ? " · You" : ""}</Text>
                  <Text style={styles.secondary}>{item.email} · {item.role}{item.suspended ? " · Suspended" : ""}</Text>
                </View>
                <Icon name="more" size={20} color={colors.textSecondary} />
              </Pressable>
            ))}
          </Section>

          <Section title="Recent authentication activity">
            {activity.length === 0 ? <Text style={styles.secondary}>No recent activity.</Text> : activity.map((item) => (
              <View key={item.id} style={styles.dataRow}>
                <Text style={styles.rowName}>{item.username || item.target_name || "Account"}</Text>
                <Text style={styles.secondary}>{item.action.replace(/_/g, " ")} · {formatRelativeDate(item.created_at)}</Text>
              </View>
            ))}
          </Section>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function StatCard({ icon, label, value }: { icon: "people" | "cloud" | "file"; label: string; value: string }) {
  return <View style={styles.statCard}><Icon name={icon} size={22} color={colors.accent} /><Text style={styles.statValue}>{value}</Text><Text style={styles.secondary}>{label}</Text></View>;
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 48 },
  heading: { color: colors.text, fontSize: 22, fontWeight: "600" },
  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  statCard: { minWidth: "31%", flexGrow: 1, backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, gap: 4 },
  statValue: { color: colors.text, fontSize: 18, fontWeight: "600" },
  secondary: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  section: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.lg, gap: spacing.sm },
  sectionTitle: { color: colors.accent, fontSize: 13, fontWeight: "700", textTransform: "uppercase", marginBottom: spacing.xs },
  dataRow: { paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowName: { color: colors.text, fontSize: 15, fontWeight: "500" },
  userRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm },
  avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: "#004A77", alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#FFF", fontWeight: "700" },
  error: { color: colors.danger, backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md },
});
