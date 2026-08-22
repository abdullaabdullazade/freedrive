import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { CompositeScreenProps } from "@react-navigation/native";
import type { BottomTabScreenProps } from "@react-navigation/bottom-tabs";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../api/client";
import type { ActivityLog, FileItem, ViewMode } from "../api/types";
import {
  LIST_CACHE_KEYS,
  readListCache,
  writeListCache,
  type HomeSuggestedCache,
} from "../cache/listCache";
import { AppDrawer } from "../components/AppDrawer";
import { EmptyState } from "../components/EmptyState";
import { FileGridTile, FileRow } from "../components/FileRow";
import { Icon } from "../components/Icon";
import { ItemActionsSheet, type ItemTarget } from "../components/ItemActionsSheet";
import { ProfileMenu } from "../components/ProfileMenu";
import { SearchBar } from "../components/SearchBar";
import { useGridColumns } from "../hooks/useGridColumns";
import { useWideLayout } from "../hooks/useWideLayout";
import type { MainTabParamList, RootStackParamList } from "../navigation/types";
import { colors, radii, spacing } from "../theme";
import { openFile } from "../utils/openFile";

type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, "Home">,
  NativeStackScreenProps<RootStackParamList>
>;

type HomeTab = "suggested" | "activity";

const HOME_VIEW_KEY = "fd_home_view_mode";
const ACTIVITY_CACHE_KEY = "fd_home_activity_cache";

function filterActivity(items: ActivityLog[]): ActivityLog[] {
  return items.filter((a) => a.target_type === "file" || a.target_type === "folder");
}

async function readActivityCache(): Promise<ActivityLog[]> {
  try {
    const raw = await AsyncStorage.getItem(ACTIVITY_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ActivityLog[];
    return Array.isArray(parsed) ? filterActivity(parsed) : [];
  } catch {
    return [];
  }
}

async function writeActivityCache(items: ActivityLog[]): Promise<void> {
  try {
    await AsyncStorage.setItem(ACTIVITY_CACHE_KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

function formatWhen(iso?: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

// Same rule as the web Home (formatHomeReason in filemanager.js).
function suggestionReason(file: FileItem): string {
  const created = new Date(file.created_at).getTime();
  const updated = new Date(file.updated_at).getTime();
  const edited = Number.isFinite(updated) && Number.isFinite(created) && updated > created;
  return `You ${edited ? "edited" : "created"} · ${formatWhen(file.updated_at || file.created_at)}`;
}

const ACTIVITY_LABELS: Record<string, string> = {
  upload: "You uploaded",
  download: "You downloaded",
  delete: "You deleted",
  rename: "You renamed",
  move: "You moved",
  copy: "You copied",
  share: "You shared",
  unshare: "You unshared",
  restore: "You restored",
  comment: "You commented",
  create: "You created",
};

function activityLabel(action: string): string {
  return ACTIVITY_LABELS[action] || action.charAt(0).toUpperCase() + action.slice(1);
}

export function HomeScreen({ navigation }: Props) {
  const isLandscape = useWideLayout();
  const gridCols = useGridColumns();
  const [tab, setTab] = useState<HomeTab>("suggested");
  const [search, setSearch] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [menuTarget, setMenuTarget] = useState<ItemTarget | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [loading, setLoading] = useState(true);
  const [activityLoading, setActivityLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filesError, setFilesError] = useState("");
  const [activityError, setActivityError] = useState("");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [activityLoaded, setActivityLoaded] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(HOME_VIEW_KEY).then((v) => {
      if (v === "list" || v === "grid") setViewMode(v);
    });
    readActivityCache().then((cached) => {
      if (cached.length) setActivities(cached);
    });
  }, []);

  const changeViewMode = async (mode: ViewMode) => {
    setViewMode(mode);
    await AsyncStorage.setItem(HOME_VIEW_KEY, mode);
  };

  const loadSuggested = useCallback(async (opts?: { soft?: boolean }) => {
    if (!opts?.soft) setLoading(true);
    setFilesError("");
    try {
      const data = await api.listFiles({ sort: "updated_at", dir: "desc", page_size: 30 });
      setFiles(data.files);
      await writeListCache<HomeSuggestedCache>(LIST_CACHE_KEYS.homeSuggested, {
        files: data.files,
      });
    } catch (err) {
      setFilesError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadActivity = useCallback(async (opts?: { soft?: boolean }) => {
    if (!opts?.soft) setActivityLoading(true);
    setActivityError("");
    try {
      const items = filterActivity(await api.myActivity(50));
      setActivities(items);
      await writeActivityCache(items);
      setActivityLoaded(true);
    } catch (err) {
      // Keep cached rows visible when the network times out.
      setActivityError(err instanceof ApiError ? err.message : String(err));
      setActivityLoaded(true);
    } finally {
      setActivityLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cached = await readListCache<HomeSuggestedCache>(LIST_CACHE_KEYS.homeSuggested);
      if (!cancelled && cached?.files?.length) {
        setFiles(cached.files);
        setLoading(false);
      }
      if (!cancelled) {
        await loadSuggested({ soft: Boolean(cached?.files?.length) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadSuggested]);

  useEffect(() => {
    if (tab !== "activity") return;
    if (activityLoaded || activityLoading) return;
    void loadActivity();
  }, [tab, activityLoaded, activityLoading, loadActivity]);

  const onRefresh = () => {
    setRefreshing(true);
    if (tab === "activity") {
      void loadActivity({ soft: true });
    } else {
      void loadSuggested({ soft: true });
    }
  };

  const onChanged = () => {
    void loadSuggested({ soft: true });
    if (activityLoaded) void loadActivity({ soft: true });
  };

  const error = tab === "suggested" ? filesError : activityError;
  const showSpinner =
    (tab === "suggested" && loading && files.length === 0) ||
    (tab === "activity" && activityLoading && activities.length === 0);

  const suggestedHeader = (
    <View style={styles.cardHeader}>
      <Text style={styles.cardHeaderTitle}>Files</Text>
      <View style={styles.toggle}>
        <Pressable
          style={[styles.toggleBtn, viewMode === "list" && styles.toggleActive]}
          onPress={() => changeViewMode("list")}
        >
          <Icon name="list" size={16} color={viewMode === "list" ? "#0B1C2C" : colors.text} />
        </Pressable>
        <Pressable
          style={[styles.toggleBtn, viewMode === "grid" && styles.toggleActive]}
          onPress={() => changeViewMode("grid")}
        >
          <Icon name="grid" size={16} color={viewMode === "grid" ? "#0B1C2C" : colors.text} />
        </Pressable>
      </View>
    </View>
  );

  const refreshControl = (
    <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {!isLandscape ? (
        <AppDrawer
          visible={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onNavigate={(route) => navigation.navigate(route)}
          onSettings={() => setProfileOpen(true)}
        />
      ) : null}
      <ProfileMenu visible={profileOpen} onClose={() => setProfileOpen(false)} />
      <ItemActionsSheet
        target={menuTarget}
        onClose={() => setMenuTarget(null)}
        onChanged={onChanged}
      />
      <SearchBar
        value={search}
        onChangeText={setSearch}
        onSubmit={() => {
          if (search.trim()) navigation.navigate("Search", { query: search.trim() });
        }}
        onAvatarPress={() => setProfileOpen(true)}
        onMenuPress={isLandscape ? undefined : () => setDrawerOpen(true)}
      />

      <View style={styles.tabs}>
        <Pressable
          style={[styles.tab, tab === "suggested" && styles.tabActive]}
          onPress={() => setTab("suggested")}
        >
          <Text style={[styles.tabText, tab === "suggested" && styles.tabTextActive]}>
            Suggested
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tab, tab === "activity" && styles.tabActive]}
          onPress={() => setTab("activity")}
        >
          <Text style={[styles.tabText, tab === "activity" && styles.tabTextActive]}>
            Activity
          </Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {showSpinner ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={colors.accent} />
        ) : tab === "suggested" ? (
          <FlatList
            key={`grid-${viewMode}-${gridCols}`}
            data={files}
            keyExtractor={(item) => item.id}
            ListHeaderComponent={suggestedHeader}
            renderItem={({ item }) =>
              viewMode === "grid" ? (
                <FileGridTile
                  file={item}
                  columns={gridCols}
                  subtitle={suggestionReason(item)}
                  onPress={() => openFile(item, navigation, { gallery: files })}
                  onMenuPress={() => setMenuTarget({ kind: "file", item })}
                />
              ) : (
                <FileRow
                  file={item}
                  subtitle={suggestionReason(item)}
                  onPress={() => openFile(item, navigation, { gallery: files })}
                  onMenuPress={() => setMenuTarget({ kind: "file", item })}
                />
              )
            }
            numColumns={viewMode === "grid" ? gridCols : 1}
            columnWrapperStyle={viewMode === "grid" ? styles.gridRow : undefined}
            contentContainerStyle={files.length === 0 ? styles.emptyContainer : styles.listBottom}
            refreshControl={refreshControl}
            ListEmptyComponent={
              <EmptyState
                title="No suggestions yet"
                subtitle="Files you work with will show up here"
              />
            }
          />
        ) : (
          <FlatList
            data={activities}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <View style={styles.activityRow}>
                <View style={styles.activityIcon}>
                  <Icon
                    name={item.target_type === "folder" ? "folder" : "doc"}
                    size={22}
                    color={colors.folder}
                  />
                </View>
                <View style={styles.activityMeta}>
                  <Text style={styles.activityName} numberOfLines={1}>
                    {item.target_name || (item.target_type === "folder" ? "Folder" : "File")}
                  </Text>
                  <Text style={styles.activitySub} numberOfLines={1}>
                    {activityLabel(item.action)} · {formatWhen(item.created_at)}
                  </Text>
                </View>
              </View>
            )}
            contentContainerStyle={
              activities.length === 0 ? styles.emptyContainer : styles.listBottom
            }
            refreshControl={refreshControl}
            ListEmptyComponent={
              <EmptyState
                title="You're all caught up"
                subtitle="Files with recent comments or other activity that needs your attention will appear here"
              />
            }
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  tabs: {
    flexDirection: "row",
    paddingHorizontal: spacing.lg,
    gap: spacing.xl,
  },
  tab: {
    paddingVertical: spacing.md,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: { borderBottomColor: colors.accent },
  tabText: { color: colors.textSecondary, fontSize: 15, fontWeight: "500" },
  tabTextActive: { color: colors.accent },
  card: {
    flex: 1,
    backgroundColor: "#0E0E0F",
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    marginHorizontal: spacing.xs,
    overflow: "hidden",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  cardHeaderTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "500",
  },
  toggle: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    padding: 2,
  },
  toggleBtn: {
    width: 40,
    height: 32,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  toggleActive: {
    backgroundColor: colors.accentSoft,
  },
  error: {
    color: colors.danger,
    paddingHorizontal: spacing.lg,
    marginVertical: spacing.sm,
  },
  gridRow: {
    paddingHorizontal: spacing.lg,
    flexDirection: "row",
  },
  listBottom: { paddingBottom: spacing.lg },
  emptyContainer: { flexGrow: 1 },
  activityRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  activityIcon: {
    width: 40,
    height: 40,
    borderRadius: radii.sm,
    backgroundColor: colors.surfaceElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  activityMeta: { flex: 1, minWidth: 0 },
  activityName: { color: colors.text, fontSize: 16, fontWeight: "500" },
  activitySub: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
});
