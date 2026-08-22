import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import type { TokenPair, User } from "../api/types";
import { clearListCaches } from "../cache/listCache";

const KEYS = {
  serverUrl: "fd_server_url",
  accessToken: "fd_access_token",
  refreshToken: "fd_refresh_token",
  userCache: "fd_user_cache",
  avatarCache: "fd_user_avatar",
  userLegacy: "fd_user",
} as const;

const AVATAR_INLINE_MAX = 500;

let cachedServerUrl: string | null | undefined;
let cachedTokens: TokenPair | null | undefined;

function invalidateSessionCache(): void {
  cachedServerUrl = undefined;
  cachedTokens = undefined;
}

export async function getServerUrl(): Promise<string | null> {
  if (cachedServerUrl !== undefined) return cachedServerUrl;
  cachedServerUrl = await SecureStore.getItemAsync(KEYS.serverUrl);
  return cachedServerUrl;
}

export async function setServerUrl(url: string): Promise<void> {
  const normalized = url.replace(/\/$/, "");
  cachedServerUrl = normalized;
  await SecureStore.setItemAsync(KEYS.serverUrl, normalized);
}

export async function getTokens(): Promise<TokenPair | null> {
  if (cachedTokens !== undefined) return cachedTokens;
  const access = await SecureStore.getItemAsync(KEYS.accessToken);
  const refresh = await SecureStore.getItemAsync(KEYS.refreshToken);
  if (!access || !refresh) {
    cachedTokens = null;
    return null;
  }
  cachedTokens = { access_token: access, refresh_token: refresh, expires_in: 0 };
  return cachedTokens;
}

export async function setTokens(tokens: TokenPair): Promise<void> {
  cachedTokens = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: 0 };
  await SecureStore.setItemAsync(KEYS.accessToken, tokens.access_token);
  await SecureStore.setItemAsync(KEYS.refreshToken, tokens.refresh_token);
}

export async function getUser(): Promise<User | null> {
  const raw = await AsyncStorage.getItem(KEYS.userCache);
  if (!raw) return null;
  try {
    const user = JSON.parse(raw) as User & { has_avatar?: boolean };
    if (user.has_avatar) {
      const avatar = await AsyncStorage.getItem(KEYS.avatarCache);
      if (avatar) {
        const { has_avatar: _drop, ...rest } = user;
        return { ...rest, avatar_url: avatar };
      }
    }
    return user;
  } catch {
    return null;
  }
}

export async function setUser(user: User): Promise<void> {
  const avatar = user.avatar_url;
  if (avatar && avatar.length > AVATAR_INLINE_MAX) {
    await AsyncStorage.setItem(KEYS.avatarCache, avatar);
    const { avatar_url: _drop, ...rest } = user;
    await AsyncStorage.setItem(KEYS.userCache, JSON.stringify({ ...rest, has_avatar: true }));
    return;
  }
  await AsyncStorage.removeItem(KEYS.avatarCache);
  await AsyncStorage.setItem(KEYS.userCache, JSON.stringify(user));
}

export async function clearSession(): Promise<void> {
  invalidateSessionCache();
  await SecureStore.deleteItemAsync(KEYS.accessToken);
  await SecureStore.deleteItemAsync(KEYS.refreshToken);
  try {
    await SecureStore.deleteItemAsync(KEYS.userLegacy);
  } catch {
    /* ignore legacy cleanup errors */
  }
  await AsyncStorage.multiRemove([KEYS.userCache, KEYS.avatarCache]);
  await clearListCaches();
}

export async function hasSession(): Promise<boolean> {
  const tokens = await getTokens();
  return Boolean(tokens?.access_token && tokens?.refresh_token);
}
