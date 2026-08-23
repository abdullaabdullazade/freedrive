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
import { ApiError } from "../api/client";
import { is2FAChallenge, isLoginApprovalChallenge } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { Logo } from "../components/Logo";
import type { RootStackParamList } from "../navigation/types";
import { colors, radii, spacing } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Login">;

export function LoginScreen({ navigation }: Props) {
  const { login, serverUrl } = useAuth();
  const [url, setUrl] = useState(serverUrl || "http://localhost:8080");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const onSubmit = async () => {
    setError("");
    if (!url.trim() || !email.trim() || !password) {
      setError("Server URL, email and password are required");
      return;
    }
    setLoading(true);
    try {
      const result = await login(url.trim(), email, password);
      if (is2FAChallenge(result)) {
        navigation.navigate("TwoFactor", {
          challengeId: result.challenge_id,
          emailMasked: result.email_masked,
          method: result.method,
          methodsAvailable: result.methods_available,
        });
      } else if (isLoginApprovalChallenge(result)) {
        setError("This sign-in must be approved from an already connected mobile device.");
      }
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
          <View style={styles.logo}>
            <Logo size={64} />
          </View>
          <Text style={styles.title}>FreeDrive</Text>
          <Text style={styles.subtitle}>Sign in to your self-hosted Drive</Text>

          <Text style={styles.label}>Server URL</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://drive.example.com"
            placeholderTextColor={colors.textSecondary}
          />

          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            placeholder="you@example.com"
            placeholderTextColor={colors.textSecondary}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="Password"
            placeholderTextColor={colors.textSecondary}
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
              <Text style={styles.buttonText}>Sign in</Text>
            )}
          </Pressable>
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
  logo: { alignItems: "center", marginBottom: spacing.lg },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: "700",
    textAlign: "center",
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: "center",
    marginBottom: spacing.xxl,
    marginTop: spacing.sm,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 13,
    marginBottom: spacing.xs,
    marginTop: spacing.md,
  },
  input: {
    backgroundColor: colors.inputBg,
    borderRadius: radii.md,
    color: colors.text,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    fontSize: 16,
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
});
