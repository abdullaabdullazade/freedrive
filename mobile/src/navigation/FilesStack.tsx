import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { FolderScreen } from "../screens/FolderScreen";
import { FilesScreen } from "../screens/FilesScreen";
import { colors } from "../theme";
import type { FilesStackParamList } from "./types";

const Stack = createNativeStackNavigator<FilesStackParamList>();

export function FilesStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        contentStyle: { backgroundColor: colors.bg },
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: "600" },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen
        name="FilesHome"
        component={FilesScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="Folder"
        component={FolderScreen}
        options={{ headerShown: true, title: "Folder" }}
      />
    </Stack.Navigator>
  );
}
