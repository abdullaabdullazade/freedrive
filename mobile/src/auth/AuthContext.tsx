import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, setUnauthorizedHandler } from "../api/client";
import type { LoginResult, User } from "../api/types";
import { is2FAChallenge, isLoginApprovalChallenge } from "../api/types";
import {
  clearSession,
  getServerUrl,
  getUser,
  hasSession,
  setServerUrl,
  setTokens,
  setUser,
} from "../auth/storage";
import { lockAndClearDevice, tryRestoreUnlock, unlockWithPassword } from "../crypto";

interface AuthContextValue {
  booting: boolean;
  user: User | null;
  serverUrl: string | null;
  signedIn: boolean;
  login: (serverUrl: string, email: string, password: string) => Promise<LoginResult>;
  verify2FA: (challengeId: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Held only until 2FA completes so we can unlock crypto with the same password. */
let pendingLoginPassword: string | null = null;

async function cacheUser(user: User): Promise<void> {
  try {
    await setUser(user);
  } catch {
    // Cache write must never log the user out (avatar data-URLs can be large).
  }
}

async function unlockCryptoSafe(password: string, userId: string): Promise<void> {
  try {
    await unlockWithPassword(password, userId);
  } catch (err) {
    console.warn("Crypto unlock failed:", err);
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [booting, setBooting] = useState(true);
  const [user, setUserState] = useState<User | null>(null);
  const [serverUrl, setServerUrlState] = useState<string | null>(null);

  const logout = useCallback(async () => {
    const uid = user?.id ?? null;
    try {
      const { unregisterPushNotifications } = await import("../notifications/push");
      await unregisterPushNotifications();
    } catch {
      /* ignore */
    }
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    await lockAndClearDevice(uid);
    pendingLoginPassword = null;
    await clearSession();
    setUserState(null);
  }, [user?.id]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUserState(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const url = await getServerUrl();
        setServerUrlState(url);
        if (await hasSession()) {
          const cached = await getUser();
          if (cached) {
            setUserState(cached);
            void tryRestoreUnlock(cached.id);
          }
        }
      } finally {
        setBooting(false);
      }

      if (await hasSession()) {
        try {
          const me = await api.me();
          setUserState(me);
          await cacheUser(me);
          if (!pendingLoginPassword) {
            void tryRestoreUnlock(me.id);
          }
        } catch {
          // Network/timeout: keep cached session. 401 is handled by request()
        }
      }
    })();
  }, []);

  const login = useCallback(async (url: string, email: string, password: string) => {
    await setServerUrl(url);
    setServerUrlState(url.replace(/\/$/, ""));
    const result = await api.login(email.trim().toLowerCase(), password);
    if (is2FAChallenge(result) || isLoginApprovalChallenge(result)) {
      pendingLoginPassword = password;
      return result;
    }
    pendingLoginPassword = null;
    await setTokens(result.tokens);
    setUserState(result.user);
    await cacheUser(result.user);
    await unlockCryptoSafe(password, result.user.id);
    return result;
  }, []);

  const verify2FA = useCallback(async (challengeId: string, code: string) => {
    const result = await api.verify2FA(challengeId, code);
    await setTokens(result.tokens);
    setUserState(result.user);
    await cacheUser(result.user);
    const password = pendingLoginPassword;
    pendingLoginPassword = null;
    if (password) {
      await unlockCryptoSafe(password, result.user.id);
    } else {
      await tryRestoreUnlock(result.user.id);
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    const me = await api.me();
    setUserState(me);
    await cacheUser(me);
  }, []);

  const value = useMemo(
    () => ({
      booting,
      user,
      serverUrl,
      signedIn: Boolean(user),
      login,
      verify2FA,
      logout,
      refreshProfile,
    }),
    [booting, user, serverUrl, login, verify2FA, logout, refreshProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
