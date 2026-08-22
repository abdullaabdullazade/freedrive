import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation, useNavigationState } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MainTabParamList, RootStackParamList } from "../navigation/types";
import { colors, spacing } from "../theme";
import { Icon, type IconName } from "./Icon";

const RAIL_WIDTH = 80;

export { RAIL_WIDTH };

type TabName = keyof MainTabParamList;

const primaryItems: { name: TabName; label: string; icon: IconName }[] = [
  { name: "Home", label: "Home", icon: "home" },
  { name: "Starred", label: "Starred", icon: "star" },
  { name: "Shared", label: "Shared", icon: "people" },
  { name: "Files", label: "Files", icon: "folder" },
];

type Props = {
  onCreate: () => void;
  onMenuPress: () => void;
};

function focusedTabName(rootState: {
  routes: Array<{ name: string; state?: { index?: number; routes: Array<{ name: string }> } }>;
} | undefined): TabName {
  const main = rootState?.routes?.find((r) => r.name === "Main");
  const tabState = main?.state;
  if (tabState && typeof tabState.index === "number" && tabState.routes?.[tabState.index]) {
    return tabState.routes[tabState.index].name as TabName;
  }
  return "Home";
}

export function SideNav({ onCreate, onMenuPress }: Props) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const activeTab = useNavigationState((state) =>
    focusedTabName(state as Parameters<typeof focusedTabName>[0]),
  );

  const goTab = (name: TabName) => {
    navigation.navigate("Main", { screen: name });
  };

  return (
    <View
      style={[
        styles.rail,
        {
          width: RAIL_WIDTH,
          paddingTop: insets.top + spacing.sm,
          paddingBottom: insets.bottom + spacing.sm,
        },
      ]}
    >
      <Pressable style={styles.menuBtn} onPress={onMenuPress} accessibilityLabel="Menu" hitSlop={8}>
        <Icon name="menu" size={24} color={colors.text} />
      </Pressable>

      <Pressable
        style={({ pressed }) => [styles.createBtn, pressed && styles.createPressed]}
        onPress={onCreate}
        accessibilityLabel="Create"
      >
        <Icon name="plus" size={26} color={colors.text} />
      </Pressable>

      <View style={styles.section}>
        {primaryItems.map((item) => {
          const active = activeTab === item.name;
          return (
            <Pressable
              key={item.name}
              style={styles.item}
              onPress={() => goTab(item.name)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <View style={[styles.iconWrap, active && styles.iconWrapActive]}>
                <Icon name={item.icon} size={22} color={colors.text} />
              </View>
              <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    alignSelf: "stretch",
    backgroundColor: colors.bg,
    alignItems: "center",
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
  },
  menuBtn: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  createBtn: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: colors.fab,
    alignItems: "center",
    justifyContent: "center",
  },
  createPressed: {
    opacity: 0.85,
  },
  section: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.md,
    width: "100%",
  },
  item: {
    alignItems: "center",
    width: "100%",
    paddingHorizontal: 4,
  },
  iconWrap: {
    width: 56,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  iconWrapActive: {
    backgroundColor: colors.fab,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "500",
    marginTop: 4,
    textAlign: "center",
  },
  labelActive: {
    color: colors.text,
    fontWeight: "600",
  },
});
