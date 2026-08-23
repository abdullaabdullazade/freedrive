import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, ApiError } from "../api/client";
import type { TOTPSetup } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { Icon } from "../components/Icon";
import { UserAvatar } from "../components/UserAvatar";
import type { RootStackParamList } from "../navigation/types";
import { colors, radii, spacing } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Settings">;

function message(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : String(err);
}

export function SettingsScreen({ navigation }: Props) {
  const { user, refreshProfile } = useAuth();
  const [username, setUsername] = useState(user?.username || "");
  const [busy, setBusy] = useState(false);
  const [totp, setTotp] = useState<TOTPSetup | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [pendingEmail, setPendingEmail] = useState("");

  useEffect(() => {
    navigation.setOptions({
      title: "Settings",
      headerStyle: { backgroundColor: colors.bg },
      headerTintColor: colors.text,
      headerTitleStyle: { fontWeight: "600" },
      headerShadowVisible: false,
    });
    void api.emailChangeStatus().then((status) => {
      setPendingEmail(status.pending ? status.new_email_masked || "Pending confirmation" : "");
    }).catch(() => {});
  }, [navigation]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      Alert.alert("Could not save", message(err));
    } finally {
      setBusy(false);
    }
  };

  const updateProfile = async (body: Parameters<typeof api.updateMe>[0]) => {
    await api.updateMe(body);
    await refreshProfile();
  };

  const chooseAvatar = () => void run(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) throw new Error("Photo access is required to choose an avatar.");
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (result.canceled || !result.assets[0]) return;
    const resized = await ImageManipulator.manipulateAsync(
      result.assets[0].uri,
      [{ resize: { width: 384, height: 384 } }],
      { compress: 0.78, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    );
    if (!resized.base64) throw new Error("Could not read the selected image.");
    await updateProfile({ avatar_url: `data:image/jpeg;base64,${resized.base64}` });
  });

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.profileHeader}>
          <UserAvatar size={72} />
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{user?.username || "FreeDrive user"}</Text>
            <Text style={styles.secondary}>{user?.email}</Text>
          </View>
          <Pressable style={styles.smallButton} onPress={chooseAvatar} disabled={busy}>
            <Text style={styles.smallButtonText}>Change photo</Text>
          </Pressable>
        </View>

        {busy ? <ActivityIndicator color={colors.accent} /> : null}

        <Section title="Profile">
          <Text style={styles.label}>Display name</Text>
          <TextInput style={styles.input} value={username} onChangeText={setUsername} />
          <PrimaryButton
            label="Save profile"
            disabled={busy || !username.trim()}
            onPress={() => void run(async () => {
              await updateProfile({ username: username.trim() });
              Alert.alert("Profile saved");
            })}
          />
        </Section>

        <Section title="Security">
          <ToggleRow
            title="Email two-step verification"
            subtitle="Send a code to your email when signing in."
            value={Boolean(user?.email_2fa_enabled)}
            disabled={busy || (Boolean(user?.two_factor_required) && Boolean(user?.email_2fa_enabled))}
            onChange={(value) => void run(async () => updateProfile({ email_2fa_enabled: value }))}
          />
          <ToggleRow
            title="Approve sign-ins on mobile"
            subtitle="Review new browser sign-ins from this trusted device."
            value={Boolean(user?.login_approval_enabled)}
            disabled={busy}
            onChange={(value) => void run(async () => updateProfile({ login_approval_enabled: value }))}
          />

          {!user?.totp_enabled && !totp ? (
            <SecondaryButton
              label="Set up authenticator app"
              onPress={() => void run(async () => setTotp(await api.setupTOTP()))}
            />
          ) : null}

          {totp ? (
            <View style={styles.setupBox}>
              <Text style={styles.subtitle}>Scan this QR code in your authenticator app</Text>
              <Image source={{ uri: totp.qr }} style={styles.qr} />
              <Pressable onPress={() => void Clipboard.setStringAsync(totp.secret)}>
                <Text style={styles.codeText}>{totp.secret}</Text>
                <Text style={styles.link}>Copy setup key</Text>
              </Pressable>
              <TextInput
                style={styles.input}
                placeholder="6-digit code"
                placeholderTextColor={colors.textSecondary}
                keyboardType="number-pad"
                value={totpCode}
                onChangeText={setTotpCode}
                maxLength={8}
              />
              <PrimaryButton
                label="Confirm authenticator"
                disabled={busy || !totpCode.trim()}
                onPress={() => void run(async () => {
                  const result = await api.confirmTOTP(totpCode.trim());
                  await refreshProfile();
                  setTotp(null);
                  setTotpCode("");
                  Alert.alert(
                    "Save your backup codes",
                    result.backup_codes.join("\n"),
                    [{ text: "Copy", onPress: () => void Clipboard.setStringAsync(result.backup_codes.join("\n")) }],
                  );
                })}
              />
            </View>
          ) : null}

          {user?.totp_enabled ? (
            <View style={styles.setupBox}>
              <Text style={styles.subtitle}>Authenticator app is enabled</Text>
              <TextInput
                style={styles.input}
                placeholder="Authenticator code"
                placeholderTextColor={colors.textSecondary}
                value={disableCode}
                onChangeText={setDisableCode}
                keyboardType="number-pad"
              />
              <TextInput
                style={styles.input}
                placeholder="Current password"
                placeholderTextColor={colors.textSecondary}
                value={disablePassword}
                onChangeText={setDisablePassword}
                secureTextEntry
              />
              <DangerButton
                label="Disable authenticator"
                disabled={busy || (!disableCode.trim() && !disablePassword)}
                onPress={() => void run(async () => {
                  await api.disableTOTP(disableCode.trim(), disablePassword);
                  setDisableCode("");
                  setDisablePassword("");
                  await refreshProfile();
                })}
              />
            </View>
          ) : null}

          <NavRow
            icon="computer"
            title="Devices and sessions"
            subtitle="Review and revoke signed-in devices"
            onPress={() => navigation.navigate("Sessions")}
          />
        </Section>

        <Section title="Email address">
          {pendingEmail ? <Text style={styles.pending}>Confirmation pending: {pendingEmail}</Text> : null}
          <TextInput
            style={styles.input}
            placeholder="New email address"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            keyboardType="email-address"
            value={newEmail}
            onChangeText={setNewEmail}
          />
          <TextInput
            style={styles.input}
            placeholder="Current password"
            placeholderTextColor={colors.textSecondary}
            secureTextEntry
            value={emailPassword}
            onChangeText={setEmailPassword}
          />
          <PrimaryButton
            label="Send confirmation"
            disabled={busy || !newEmail.trim() || !emailPassword}
            onPress={() => void run(async () => {
              const status = await api.requestEmailChange(newEmail.trim().toLowerCase(), emailPassword);
              setPendingEmail(status.new_email_masked);
              setNewEmail("");
              setEmailPassword("");
              Alert.alert("Confirmation sent", "Open the message sent to your new email address.");
            })}
          />
        </Section>

        <Section title="FreeDrive">
          <NavRow icon="cloud" title="Manage storage" onPress={() => navigation.navigate("Storage")} />
          <NavRow icon="help" title="Help and feedback" onPress={() => navigation.navigate("Help")} />
          <NavRow icon="info" title="Privacy policy" onPress={() => navigation.navigate("Legal", { document: "privacy" })} />
          <NavRow icon="doc" title="Terms of service" onPress={() => navigation.navigate("Legal", { document: "terms" })} />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>;
}

function ToggleRow(props: { title: string; subtitle: string; value: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return (
    <View style={styles.toggleRow}>
      <View style={{ flex: 1 }}><Text style={styles.subtitle}>{props.title}</Text><Text style={styles.secondary}>{props.subtitle}</Text></View>
      <Switch value={props.value} disabled={props.disabled} onValueChange={props.onChange} trackColor={{ true: colors.accent }} />
    </View>
  );
}

function NavRow({ icon, title, subtitle, onPress }: { icon: "computer" | "cloud" | "help" | "info" | "doc"; title: string; subtitle?: string; onPress: () => void }) {
  return (
    <Pressable style={styles.navRow} onPress={onPress}>
      <Icon name={icon} size={21} color={colors.textSecondary} />
      <View style={{ flex: 1 }}><Text style={styles.subtitle}>{title}</Text>{subtitle ? <Text style={styles.secondary}>{subtitle}</Text> : null}</View>
      <Icon name="chevron_right" size={20} color={colors.textSecondary} />
    </Pressable>
  );
}

function PrimaryButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable style={[styles.primaryButton, disabled && styles.disabled]} onPress={onPress} disabled={disabled}><Text style={styles.primaryText}>{label}</Text></Pressable>;
}
function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable style={styles.secondaryButton} onPress={onPress}><Text style={styles.link}>{label}</Text></Pressable>;
}
function DangerButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable style={[styles.dangerButton, disabled && styles.disabled]} onPress={onPress} disabled={disabled}><Text style={styles.dangerText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 48 },
  profileHeader: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  title: { color: colors.text, fontSize: 20, fontWeight: "600" },
  section: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.lg, gap: spacing.md },
  sectionTitle: { color: colors.accent, fontSize: 13, fontWeight: "700", textTransform: "uppercase" },
  label: { color: colors.textSecondary, fontSize: 13 },
  subtitle: { color: colors.text, fontSize: 16, fontWeight: "500" },
  secondary: { color: colors.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 2 },
  input: { backgroundColor: colors.inputBg, color: colors.text, borderRadius: radii.sm, paddingHorizontal: spacing.md, paddingVertical: 12 },
  smallButton: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, paddingHorizontal: 12, paddingVertical: 8 },
  smallButtonText: { color: colors.accent, fontWeight: "600", fontSize: 12 },
  primaryButton: { backgroundColor: colors.accentSoft, borderRadius: radii.pill, alignItems: "center", paddingVertical: 12 },
  primaryText: { color: "#0B1C2C", fontWeight: "700" },
  secondaryButton: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.pill, alignItems: "center", paddingVertical: 11 },
  link: { color: colors.accent, fontWeight: "600" },
  dangerButton: { borderWidth: 1, borderColor: colors.danger, borderRadius: radii.pill, alignItems: "center", paddingVertical: 11 },
  dangerText: { color: colors.danger, fontWeight: "600" },
  disabled: { opacity: 0.45 },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.xs },
  navRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm },
  setupBox: { backgroundColor: colors.inputBg, borderRadius: radii.sm, padding: spacing.md, gap: spacing.md },
  qr: { width: 220, height: 220, alignSelf: "center", borderRadius: radii.sm },
  codeText: { color: colors.text, fontFamily: "monospace", textAlign: "center", marginBottom: 4 },
  pending: { color: colors.accent, fontSize: 13 },
});
