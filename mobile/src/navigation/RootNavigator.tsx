import React, { useEffect, useRef } from "react";
import { ActivityIndicator, AppState, View } from "react-native";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { LinkingOptions } from "@react-navigation/native";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { FilePreviewScreen } from "../screens/FilePreviewScreen";
import { LoginApprovalScreen } from "../screens/LoginApprovalScreen";
import { LoginScreen } from "../screens/LoginScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { SessionsScreen } from "../screens/SessionsScreen";
import { HelpScreen } from "../screens/HelpScreen";
import { LegalScreen } from "../screens/LegalScreen";
import { RecentScreen } from "../screens/RecentScreen";
import { ActivityScreen } from "../screens/ActivityScreen";
import { ApprovalsScreen } from "../screens/ApprovalsScreen";
import { OfflineScreen } from "../screens/OfflineScreen";
import { StorageScreen } from "../screens/StorageScreen";
import { SearchScreen } from "../screens/SearchScreen";
import { TrashScreen } from "../screens/TrashScreen";
import { TwoFactorScreen } from "../screens/TwoFactorScreen";
import {
  getLoginApprovalIdFromNotification,
  Notifications,
  registerForPushNotifications,
  startPushRegistrationRetries,
} from "../notifications/push";
import { colors } from "../theme";
import { MainTabs } from "./MainTabs";
import type { RootStackParamList } from "./types";

const Stack = createNativeStackNavigator<RootStackParamList>();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.bg,
    text: colors.text,
    border: colors.border,
    primary: colors.accent,
  },
};

const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ["freedrive://"],
  config: {
    screens: {
      LoginApproval: "login-approval/:challengeId",
      Main: {
        screens: {
          Home: "home",
          Files: "files",
        },
      },
    },
  },
};

const PENDING_POLL_MS = 2500;

export function RootNavigator() {
  const { booting, signedIn } = useAuth();
  const navRef = useRef<any>(null);
  const shownChallengeRef = useRef<string | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    void registerForPushNotifications();
    const stopRetry = startPushRegistrationRetries();

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown>;
      const id = getLoginApprovalIdFromNotification(data);
      if (id && navRef.current?.isReady?.()) {
        shownChallengeRef.current = id;
        navRef.current.navigate("LoginApproval", { challengeId: id });
      }
    });
    return () => {
      sub.remove();
      stopRetry();
    };
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn) {
      shownChallengeRef.current = null;
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const openPending = (id: string) => {
      if (!navRef.current?.isReady?.()) return;
      const route = navRef.current.getCurrentRoute?.();
      if (route?.name === "LoginApproval" && route?.params?.challengeId === id) {
        return;
      }
      shownChallengeRef.current = id;
      navRef.current.navigate("LoginApproval", { challengeId: id });
    };

    const pollOnce = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const list = await api.listPendingLoginApprovals();
        const first = list[0];
        if (first?.id) {
          openPending(first.id);
        } else {
          shownChallengeRef.current = null;
        }
      } catch {
        /* ignore transient poll errors */
      } finally {
        inFlight = false;
      }
    };

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(() => {
        void pollOnce().finally(() => schedule());
      }, PENDING_POLL_MS);
    };

    void pollOnce().finally(() => schedule());

    const onAppState = (state: string) => {
      if (state === "active") {
        void pollOnce();
      }
    };
    const appSub = AppState.addEventListener("change", onAppState);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      appSub.remove();
    };
  }, [signedIn]);

  if (booting) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer ref={navRef} theme={navTheme} linking={signedIn ? linking : undefined}>
      <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        {!signedIn ? (
          <>
            <Stack.Screen name="Login" component={LoginScreen} />
            <Stack.Screen name="TwoFactor" component={TwoFactorScreen} />
          </>
        ) : (
          <>
            <Stack.Screen name="Main" component={MainTabs} />
            <Stack.Screen
              name="LoginApproval"
              component={LoginApprovalScreen}
              options={{ headerShown: true, title: "Sign-in request" }}
            />
            <Stack.Screen
              name="Search"
              component={SearchScreen}
              options={{ headerShown: true }}
            />
            <Stack.Screen
              name="Recent"
              component={RecentScreen}
              options={{ headerShown: true }}
            />
            <Stack.Screen name="Activity" component={ActivityScreen} options={{ headerShown: true }} />
            <Stack.Screen name="Storage" component={StorageScreen} options={{ headerShown: true }} />
            <Stack.Screen name="Offline" component={OfflineScreen} options={{ headerShown: true }} />
            <Stack.Screen name="Approvals" component={ApprovalsScreen} options={{ headerShown: true }} />
            <Stack.Screen name="Settings" component={SettingsScreen} options={{ headerShown: true }} />
            <Stack.Screen name="Sessions" component={SessionsScreen} options={{ headerShown: true }} />
            <Stack.Screen name="Help" component={HelpScreen} options={{ headerShown: true }} />
            <Stack.Screen name="Legal" component={LegalScreen} options={{ headerShown: true }} />
            <Stack.Screen
              name="Trash"
              component={TrashScreen}
              options={{ headerShown: true }}
            />
            <Stack.Screen
              name="FilePreview"
              component={FilePreviewScreen}
              options={{ headerShown: true }}
            />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
