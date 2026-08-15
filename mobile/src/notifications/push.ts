import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { api } from "../api/client";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

let lastRegisteredToken: string | null = null;

export async function registerForPushNotifications(): Promise<string | null> {
  try {
    if (!Device.isDevice && Platform.OS === "ios") {
      return null;
    }
    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== "granted") {
      return null;
    }
    const tokenData = await Notifications.getExpoPushTokenAsync();
    const token = tokenData.data;
    if (!token) return null;
    await api.registerPushToken(token, Platform.OS === "ios" ? "ios" : "android");
    lastRegisteredToken = token;
    return token;
  } catch (err) {
    console.warn("push registration failed:", err);
    return null;
  }
}

export async function unregisterPushNotifications(): Promise<void> {
  try {
    await api.unregisterPushToken(lastRegisteredToken || undefined);
  } catch {
    /* ignore */
  }
  lastRegisteredToken = null;
}

export function getLoginApprovalIdFromNotification(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  if (data.type !== "login_approval") return null;
  const id = data.challenge_id;
  return typeof id === "string" && id ? id : null;
}

export { Notifications };
