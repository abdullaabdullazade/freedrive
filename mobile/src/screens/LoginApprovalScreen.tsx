import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api } from "../api/client";
import type { LoginApprovalDetails } from "../api/types";
import type { RootStackParamList } from "../navigation/types";
import { colors } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "LoginApproval">;

export function LoginApprovalScreen({ route, navigation }: Props) {
  const { challengeId } = route.params;
  const [details, setDetails] = useState<LoginApprovalDetails | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.getLoginApproval(challengeId);
      setDetails(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [challengeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onApprove = async () => {
    setBusy(true);
    setError("");
    try {
      await api.approveLoginApproval(challengeId);
      navigation.goBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDeny = async () => {
    setBusy(true);
    setError("");
    try {
      await api.denyLoginApproval(challengeId);
      navigation.goBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  const pending = details?.status === "pending";

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Is this you signing in?</Text>
      <Text style={styles.subtitle}>
        Someone is trying to access your FreeDrive account. Confirm only if this is you.
      </Text>

      {details ? (
        <View style={styles.card}>
          <Text style={styles.label}>Device</Text>
          <Text style={styles.value}>{details.pending_device_name || "Unknown device"}</Text>
          {details.ip_address ? (
            <>
              <Text style={styles.label}>IP address</Text>
              <Text style={styles.value}>{details.ip_address}</Text>
            </>
          ) : null}
          <Text style={styles.label}>Status</Text>
          <Text style={styles.value}>{details.status}</Text>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {pending ? (
        <View style={styles.actions}>
          <Pressable
            style={[styles.btn, styles.approve, busy && styles.disabled]}
            disabled={busy}
            onPress={() => void onApprove()}
          >
            <Text style={styles.btnText}>Yes, it's me</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, styles.deny, busy && styles.disabled]}
            disabled={busy}
            onPress={() => void onDeny()}
          >
            <Text style={styles.btnText}>No, it's not me</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable style={[styles.btn, styles.approve]} onPress={() => navigation.goBack()}>
          <Text style={styles.btnText}>Done</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: 24,
    paddingTop: 64,
  },
  center: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "700",
    marginBottom: 8,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 24,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 20,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 12,
    textTransform: "uppercase",
    marginTop: 8,
  },
  value: {
    color: colors.text,
    fontSize: 16,
    marginTop: 2,
  },
  error: {
    color: colors.danger || "#f87171",
    marginBottom: 12,
  },
  actions: {
    gap: 12,
  },
  btn: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  approve: {
    backgroundColor: colors.accent,
  },
  deny: {
    backgroundColor: "#b91c1c",
  },
  disabled: {
    opacity: 0.6,
  },
  btnText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
  },
});
