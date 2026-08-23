import * as Device from "expo-device";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
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

function resolveProjectId(): string | undefined {
  const easId = Constants.easConfig?.projectId;
  if (typeof easId === "string" && easId) return easId;
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  const fromExtra = extra?.eas?.projectId;
  if (typeof fromExtra === "string" && fromExtra) return fromExtra;
  return undefined;
}

export async function registerForPushNotifications(): Promise<string | null> {
  try {
    // Android remote push requires a Firebase google-services.json. Keep local
    // notifications available, but do not repeatedly attempt FCM registration
    // in self-hosted/dev builds that intentionally omit Firebase credentials.
    if (Platform.OS === "android" && !Constants.expoConfig?.android?.googleServicesFile) {
      return null;
    }
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
    const projectId = resolveProjectId();
    const tokenData = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
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

/** Re-register when the app returns to foreground (best-effort). */
export function startPushRegistrationRetries(): () => void {
  const onChange = (state: string) => {
    if (state === "active") {
      void registerForPushNotifications();
    }
  };
  const sub = AppState.addEventListener("change", onChange);
  return () => sub.remove();
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
