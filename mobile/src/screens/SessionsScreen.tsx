import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, ApiError } from "../api/client";
import type { AuthSession } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import type { RootStackParamList } from "../navigation/types";
import { colors, radii, spacing } from "../theme";
import { formatRelativeDate } from "../utils/format";

type Props = NativeStackScreenProps<RootStackParamList, "Sessions">;

export function SessionsScreen({ navigation }: Props) {
  const [sessions, setSessions] = useState<AuthSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try { setSessions(await api.listSessions()); }
    catch (err) { setError(err instanceof ApiError ? err.message : String(err)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    navigation.setOptions({
      title: "Devices and sessions",
      headerStyle: { backgroundColor: colors.bg },
      headerTintColor: colors.text,
      headerShadowVisible: false,
    });
    void load();
  }, [load, navigation]);

  const revoke = (item: AuthSession) => Alert.alert("Sign this device out?", item.device_name, [
    { text: "Cancel", style: "cancel" },
    { text: "Sign out", style: "destructive", onPress: () => void api.revokeSession(item.id).then(load).catch((err) => Alert.alert("Error", String(err))) },
  ]);

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <View style={styles.top}>
        <Text style={styles.secondary}>Devices currently signed in to your FreeDrive account.</Text>
        <Pressable style={styles.revokeAll} onPress={() => Alert.alert("Sign out other devices?", "Your current mobile session will stay active.", [
          { text: "Cancel", style: "cancel" },
          { text: "Sign out others", style: "destructive", onPress: () => void api.revokeOtherSessions().then(load).catch((err) => Alert.alert("Error", String(err))) },
        ])}><Text style={styles.revokeText}>Sign out all other devices</Text></Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? <ActivityIndicator style={{ marginTop: 40 }} color={colors.accent} /> : (
        <FlatList
          data={sessions}
          keyExtractor={(item) => item.id}
          contentContainerStyle={sessions.length ? styles.list : styles.empty}
          ListEmptyComponent={<EmptyState title="No active sessions" subtitle="Signed-in devices will appear here" />}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Icon name={item.device_type === "mobile" ? "file" : "computer"} size={24} color={colors.accent} />
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{item.device_name || "Unknown device"}{item.current ? " · This device" : ""}</Text>
                <Text style={styles.secondary}>{item.ip_address || "Unknown IP"} · {formatRelativeDate(item.last_seen_at)}</Text>
              </View>
              {!item.current ? <Pressable onPress={() => revoke(item)}><Text style={styles.revokeText}>Sign out</Text></Pressable> : null}
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  top: { padding: spacing.lg, gap: spacing.md },
  list: { paddingHorizontal: spacing.lg, gap: spacing.md, paddingBottom: 32 },
  empty: { flexGrow: 1 },
  card: { flexDirection: "row", alignItems: "center", gap: spacing.md, backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.lg },
  name: { color: colors.text, fontSize: 15, fontWeight: "600" },
  secondary: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  revokeAll: { alignSelf: "flex-start", borderWidth: 1, borderColor: colors.danger, borderRadius: radii.pill, paddingHorizontal: 14, paddingVertical: 9 },
  revokeText: { color: colors.danger, fontWeight: "600", fontSize: 13 },
  error: { color: colors.danger, paddingHorizontal: spacing.lg },
});
