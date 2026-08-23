import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import React, { useEffect } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { RootStackParamList } from "../navigation/types";
import { colors, radii, spacing } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Legal">;

const privacy = [
  ["Your server, your data", "FreeDrive Mobile connects only to the server URL you configure. Account data, file metadata, encrypted content, sharing records, and activity are processed by that self-hosted server."],
  ["Encryption", "New uploads are encrypted on the device before transfer. Encryption keys may be synchronized through your server in wrapped form so your trusted devices can open files."],
  ["Data on this device", "Authentication tokens are stored in secure device storage. Profile cache and app preferences use local application storage. Files marked Available offline are kept as decrypted copies in FreeDrive’s private app directory until you remove them or uninstall the app."],
  ["Permissions", "Camera and photo access are requested only when you choose the related action. Notification permission is used for download progress and sign-in approval alerts. Microphone recording is disabled."],
  ["Sharing", "Public links and user shares are created on your configured server. Anyone with an active public link may access it according to the permission and restrictions you selected."],
  ["Control", "You can remove offline copies, revoke sessions, delete public links, move files to the bin, and permanently empty the bin from the mobile app."],
];

const terms = [
  ["Self-hosted service", "FreeDrive Mobile is a client for a server controlled by you or your organization. Server availability, retention, quotas, acceptable-use rules, and support are determined by that server’s administrator."],
  ["Account responsibility", "Keep your password, authenticator codes, backup codes, recovery information, and trusted devices secure. Actions performed with your active session are treated as account actions."],
  ["Content and sharing", "Only upload and share content you are authorized to store or distribute. Review recipients and public links before sharing sensitive files."],
  ["Encrypted-file recovery", "Keep recovery information and original copies where appropriate. A file cannot be decrypted if all valid copies of its encryption key are lost."],
  ["Permanent deletion", "Emptying the bin and choosing Delete forever are irreversible. Confirm the selected files and folders before continuing."],
  ["Software behavior", "Preview and editing support varies by file format and device capability. Unsupported native formats can be downloaded or opened with a compatible installed application."],
];

export function LegalScreen({ route, navigation }: Props) {
  const isPrivacy = route.params.document === "privacy";
  const sections = isPrivacy ? privacy : terms;
  const title = isPrivacy ? "Privacy policy" : "Terms of service";

  useEffect(() => {
    navigation.setOptions({
      title,
      headerStyle: { backgroundColor: colors.bg },
      headerTintColor: colors.text,
      headerShadowVisible: false,
    });
  }, [navigation, title]);

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.updated}>Mobile notice · Updated August 23, 2026</Text>
        <Text style={styles.intro}>This notice describes the FreeDrive mobile client. Your server administrator may provide additional organization-specific policies.</Text>
        {sections.map(([heading, body]) => (
          <View key={heading} style={styles.card}>
            <Text style={styles.heading}>{heading}</Text>
            <Text style={styles.body}>{body}</Text>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: 48 },
  title: { color: colors.text, fontSize: 26, fontWeight: "600" },
  updated: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  intro: { color: colors.textSecondary, fontSize: 14, lineHeight: 21 },
  card: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.lg, gap: spacing.sm },
  heading: { color: colors.text, fontSize: 17, fontWeight: "600" },
  body: { color: colors.textSecondary, fontSize: 14, lineHeight: 22 },
});
