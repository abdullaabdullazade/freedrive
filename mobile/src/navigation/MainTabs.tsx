import React, { useCallback, useState } from "react";
import { View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { CreateActionsProvider, useCreateActions } from "../create/CreateActionsContext";
import { AppDrawer } from "../components/AppDrawer";
import { Icon, type IconName } from "../components/Icon";
import { ProfileMenu } from "../components/ProfileMenu";
import { SideNav } from "../components/SideNav";
import { useWideLayout } from "../hooks/useWideLayout";
import { FilesStack } from "./FilesStack";
import { HomeScreen } from "../screens/HomeScreen";
import { SharedScreen } from "../screens/SharedScreen";
import { StarredScreen } from "../screens/StarredScreen";
import { colors } from "../theme";
import type { MainTabParamList, RootStackParamList } from "./types";

const Tab = createBottomTabNavigator<MainTabParamList>();

const tabIcons: Record<keyof MainTabParamList, IconName> = {
  Home: "home",
  Starred: "star",
  Shared: "people",
  Files: "folder",
};

function TabIcon({ route, focused }: { route: keyof MainTabParamList; focused: boolean }) {
  return (
    <View
      style={{
        width: 56,
        height: 30,
        borderRadius: 15,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: focused ? colors.fab : "transparent",
      }}
    >
      <Icon
        name={tabIcons[route]}
        size={22}
        color={focused ? colors.text : colors.textSecondary}
      />
    </View>
  );
}

function MainTabsChrome() {
  const insets = useSafeAreaInsets();
  const isLandscape = useWideLayout();
  const { openCreateMenu } = useCreateActions();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.bg }}>
      {isLandscape ? (
        <>
          <SideNav
            onCreate={openCreateMenu}
            onMenuPress={() => setDrawerOpen(true)}
          />
          <AppDrawer
            visible={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            onNavigate={(route) => navigation.navigate(route)}
            onSettings={() => setProfileOpen(true)}
          />
          <ProfileMenu visible={profileOpen} onClose={() => setProfileOpen(false)} />
        </>
      ) : null}
      <View style={{ flex: 1 }}>
        <Tab.Navigator
          screenOptions={({ route }) => ({
            headerShown: false,
            tabBarStyle: isLandscape
              ? { display: "none", height: 0 }
              : {
                  backgroundColor: colors.bg,
                  borderTopColor: colors.border,
                  height: 64 + insets.bottom,
                  paddingBottom: insets.bottom + 8,
                  paddingTop: 6,
                },
            tabBarActiveTintColor: colors.text,
            tabBarInactiveTintColor: colors.textSecondary,
            tabBarIcon: ({ focused }) => <TabIcon route={route.name} focused={focused} />,
            tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
          })}
        >
          <Tab.Screen name="Home" component={HomeScreen} />
          <Tab.Screen name="Starred" component={StarredScreen} />
          <Tab.Screen name="Shared" component={SharedScreen} />
          <Tab.Screen name="Files" component={FilesStack} options={{ headerShown: false }} />
        </Tab.Navigator>
      </View>
    </View>
  );
}

export function MainTabs() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const onNeedFilesTab = useCallback(() => {
    navigation.navigate("Main", { screen: "Files" });
  }, [navigation]);

  return (
    <CreateActionsProvider onNeedFilesTab={onNeedFilesTab}>
      <MainTabsChrome />
    </CreateActionsProvider>
  );
}
