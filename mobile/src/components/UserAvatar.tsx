import React from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../auth/AuthContext";
import { initials } from "../utils/format";

// Renders the signed-in user's avatar (data:image URL stored on the server,
// same as desktop UserAvatar.tsx) or falls back to their initials.
interface UserAvatarProps {
  size?: number;
}

export function UserAvatar({ size = 36 }: UserAvatarProps) {
  const { user } = useAuth();
  const round = { width: size, height: size, borderRadius: size / 2 };
  const avatarUrl = user?.avatar_url;

  if (avatarUrl?.startsWith("data:image/")) {
    return <Image source={{ uri: avatarUrl }} style={round} />;
  }

  return (
    <View style={[styles.fallback, round]}>
      <Text style={[styles.fallbackText, { fontSize: size * 0.38 }]}>
        {initials(user?.username, user?.email)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: "#004A77",
    alignItems: "center",
    justifyContent: "center",
  },
  fallbackText: {
    color: "#FFFFFF",
    fontWeight: "500",
  },
});
