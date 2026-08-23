import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Clipboard from "expo-clipboard";
import * as Device from "expo-device";
import React, { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../auth/AuthContext";
import type { RootStackParamList } from "../navigation/types";
import { colors, radii, spacing } from "../theme";

type Props = NativeStackScreenProps<RootStackParamList, "Help">;

const FAQ = [
  ["Why can’t an older encrypted file open?", "The device must have access to that file’s encryption key. Sign out and sign in again with your password to restore synchronized keys. Files whose original key was never uploaded cannot be recovered without the original device or file."],
  ["How do offline files work?", "Choose Available offline from a file menu. FreeDrive keeps a decrypted copy in this app’s private storage. Removing the offline copy does not delete the server file."],
  ["Where are downloaded files saved?", "On Android, Download saves to the shared Downloads collection. Available offline remains private to FreeDrive."],
  ["How do I manage storage?", "Open Storage from the drawer or Settings. Sort the largest files, then move unneeded items to the bin and empty it when ready."],
];

export function HelpScreen({ navigation }: Props) {
  const { serverUrl, user } = useAuth();
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    navigation.setOptions({
      title: "Help and feedback",
      headerStyle: { backgroundColor: colors.bg },
      headerTintColor: colors.text,
      headerShadowVisible: false,
    });
  }, [navigation]);

  const copyReport = async () => {
    const report = [
      feedback.trim(),
      "",
      "FreeDrive diagnostics",
      `Server: ${serverUrl || "not configured"}`,
      `Account: ${user?.email || "unknown"}`,
      `Device: ${Device.modelName || "unknown"}`,
      `OS: ${Device.osName || "Android"} ${Device.osVersion || ""}`,
    ].join("\n");
    await Clipboard.setStringAsync(report);
    Alert.alert("Feedback copied", "Paste it into the support channel used by your FreeDrive administrator.");
  };

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.hero}>FreeDrive help</Text>
        <Text style={styles.secondary}>Answers and diagnostics are available inside the mobile app—no browser required.</Text>
        {FAQ.map(([question, answer]) => (
          <View key={question} style={styles.card}>
            <Text style={styles.question}>{question}</Text>
            <Text style={styles.answer}>{answer}</Text>
          </View>
        ))}
        <View style={styles.card}>
          <Text style={styles.question}>Send feedback</Text>
          <Text style={styles.answer}>Describe the issue. FreeDrive will append device diagnostics and copy the report without exposing passwords or encryption keys.</Text>
          <TextInput
            style={styles.input}
            placeholder="What happened?"
            placeholderTextColor={colors.textSecondary}
            multiline
            value={feedback}
            onChangeText={setFeedback}
          />
          <Pressable style={styles.button} onPress={() => void copyReport()}>
            <Text style={styles.buttonText}>Copy feedback report</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: 40 },
  hero: { color: colors.text, fontSize: 24, fontWeight: "600" },
  secondary: { color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  card: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.lg, gap: spacing.sm },
  question: { color: colors.text, fontSize: 16, fontWeight: "600" },
  answer: { color: colors.textSecondary, fontSize: 14, lineHeight: 21 },
  input: { minHeight: 110, textAlignVertical: "top", backgroundColor: colors.inputBg, color: colors.text, borderRadius: radii.sm, padding: spacing.md },
  button: { backgroundColor: colors.accentSoft, borderRadius: radii.pill, alignItems: "center", paddingVertical: 12 },
  buttonText: { color: "#0B1C2C", fontWeight: "700" },
});
