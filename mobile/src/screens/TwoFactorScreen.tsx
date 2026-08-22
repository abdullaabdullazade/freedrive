import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ApiError, api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { RootStackParamList } from "../navigation/types";
import { colors, radii, spacing } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "TwoFactor">;

export function TwoFactorScreen({ route, navigation }: Props) {
  const { verify2FA } = useAuth();
  const { challengeId, emailMasked, method: initialMethod, methodsAvailable } = route.params;
  const [challenge, setChallenge] = useState(challengeId);
  const [method, setMethod] = useState(initialMethod || "email");
  const [masked, setMasked] = useState(emailMasked || "");
  const [available, setAvailable] = useState(methodsAvailable || []);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const isTotp = method === "totp";
  const canEmailFallback = isTotp && available.includes("email");

  const onSubmit = async () => {
    setError("");
    if (code.trim().length < 6) {
      setError(isTotp ? "Enter an authenticator or backup code" : "Enter the 6-digit code from your email");
      return;
    }
    setLoading(true);
    try {
      await verify2FA(challenge, code.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const onSendEmail = async () => {
    setError("");
    setLoading(true);
    try {
      const result = await api.send2FAEmail(challenge);
      setChallenge(result.challenge_id);
      setMethod(result.method || "email");
      setMasked(result.email_masked || "");
      setAvailable(result.methods_available || ["email"]);
      setCode("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.container}>
          <Pressable onPress={() => navigation.goBack()}>
            <Text style={styles.back}>← Back</Text>
          </Pressable>
          <Text style={styles.title}>Two-factor authentication</Text>
          <Text style={styles.subtitle}>
            {isTotp
              ? "Enter the 6-digit code from your authenticator app (or a backup code)."
              : `Enter the 6-digit code sent to ${masked || "your email"}`}
          </Text>
          <TextInput
            style={styles.input}
            value={code}
            onChangeText={setCode}
            keyboardType={isTotp ? "default" : "number-pad"}
            maxLength={16}
            placeholder={isTotp ? "Code" : "000000"}
            placeholderTextColor={colors.textSecondary}
            autoFocus
            autoCapitalize="characters"
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={onSubmit}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#0B1C2C" />
            ) : (
              <Text style={styles.buttonText}>Verify</Text>
            )}
          </Pressable>
          {canEmailFallback ? (
            <Pressable
              style={[styles.linkBtn, loading && styles.buttonDisabled]}
              onPress={onSendEmail}
              disabled={loading}
            >
              <Text style={styles.linkText}>Send code by email</Text>
            </Pressable>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  container: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    justifyContent: "center",
  },
  back: {
    color: colors.accent,
    marginBottom: spacing.xl,
    fontSize: 16,
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "700",
    marginBottom: spacing.sm,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: spacing.xl,
  },
  input: {
    backgroundColor: colors.inputBg,
    borderRadius: radii.md,
    color: colors.text,
    paddingHorizontal: spacing.lg,
    paddingVertical: 16,
    fontSize: 24,
    letterSpacing: 8,
    textAlign: "center",
  },
  error: {
    color: colors.danger,
    marginTop: spacing.md,
    fontSize: 14,
  },
  button: {
    marginTop: spacing.xl,
    backgroundColor: colors.accentMuted,
    borderRadius: radii.pill,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: { opacity: 0.7 },
  buttonText: {
    color: "#0B1C2C",
    fontWeight: "700",
    fontSize: 16,
  },
  linkBtn: {
    marginTop: spacing.lg,
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  linkText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
});
