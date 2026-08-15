import React, { useEffect, useRef } from "react";
import { ActivityIndicator, View } from "react-native";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { LinkingOptions } from "@react-navigation/native";
import { useAuth } from "../auth/AuthContext";
import { FilePreviewScreen } from "../screens/FilePreviewScreen";
import { LoginApprovalScreen } from "../screens/LoginApprovalScreen";
import { LoginScreen } from "../screens/LoginScreen";
import { RecentScreen } from "../screens/RecentScreen";
import { SearchScreen } from "../screens/SearchScreen";
import { TrashScreen } from "../screens/TrashScreen";
import { TwoFactorScreen } from "../screens/TwoFactorScreen";
import {
  getLoginApprovalIdFromNotification,
  Notifications,
  registerForPushNotifications,
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

export function RootNavigator() {
  const { booting, signedIn } = useAuth();
  const navRef = useRef<any>(null);

  useEffect(() => {
    if (!signedIn) return;
    void registerForPushNotifications();

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown>;
      const id = getLoginApprovalIdFromNotification(data);
      if (id && navRef.current?.isReady?.()) {
        navRef.current.navigate("LoginApproval", { challengeId: id });
      }
    });
    return () => sub.remove();
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
