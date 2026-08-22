import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
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
import type { Computer, FileItem, FolderItem, SortDir, SortKey, ViewMode } from "../api/types";
import {
  LIST_CACHE_KEYS,
  readListCache,
  writeListCache,
  type ComputersCache,
  type FolderContentsCache,
} from "../cache/listCache";
import { AppDrawer } from "../components/AppDrawer";
import { CreateFab } from "../components/CreateFab";
import { EmptyState } from "../components/EmptyState";
import { FileGridTile, FileRow } from "../components/FileRow";
import { ComputerRow, FolderGridTile, FolderRow } from "../components/FolderRow";
import { ItemActionsSheet, type ItemTarget } from "../components/ItemActionsSheet";
import { NewFolderDialog } from "../components/NewFolderDialog";
import { ProfileMenu } from "../components/ProfileMenu";
import { SearchBar } from "../components/SearchBar";
import { SortHeader } from "../components/SortHeader";
import { useRegisterCreateHandlers } from "../create/CreateActionsContext";
import { useGridColumns } from "../hooks/useGridColumns";
import { useWideLayout } from "../hooks/useWideLayout";
import type { FilesStackParamList, MainTabParamList, RootStackParamList } from "../navigation/types";
import { colors, spacing } from "../theme";
import { openFile } from "../utils/openFile";
import {
  createEncryptedBinaryFile,
  createEncryptedTextFile,
  pickAndUploadFiles,
} from "../utils/uploadFiles";
import { emptyXlsxBytes, XLSX_MIME } from "../utils/sheetCodec";

type Props = CompositeScreenProps<
  NativeStackScreenProps<FilesStackParamList, "FilesHome">,
  CompositeScreenProps<
    BottomTabScreenProps<MainTabParamList, "Files">,
    NativeStackScreenProps<RootStackParamList>
  >
>;

type FilesTab = "my-drive" | "computers";

type ListEntry =
  | { kind: "folder"; item: FolderItem }
  | { kind: "file"; item: FileItem }
  | { kind: "computer"; item: Computer };

const VIEW_KEY = "fd_view_mode";

function sortMyDriveEntries(
  folders: FolderItem[],
  files: FileItem[],
  sort: SortKey,
  dir: SortDir,
): ListEntry[] {
  const compare = (a: string, b: string) =>
    dir === "asc" ? a.localeCompare(b) : b.localeCompare(a);
  const byDate = (a?: string, b?: string) => {
    const av = a ? new Date(a).getTime() : 0;
    const bv = b ? new Date(b).getTime() : 0;
    return dir === "asc" ? av - bv : bv - av;
  };
  const folderEntries = folders.map((item) => ({ kind: "folder" as const, item }));
  const fileEntries = files.map((item) => ({ kind: "file" as const, item }));
  const sortFolders = [...folderEntries].sort((a, b) =>
    sort === "name"
      ? compare(a.item.name, b.item.name)
      : byDate(a.item.updated_at, b.item.updated_at),
  );
  const sortFiles = [...fileEntries].sort((a, b) =>
    sort === "name"
      ? compare(a.item.name, b.item.name)
      : byDate(a.item.updated_at, b.item.updated_at),
  );
  return [...sortFolders, ...sortFiles];
}

export function FilesScreen({ navigation }: Props) {
  const [tab, setTab] = useState<FilesTab>("my-drive");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [myDriveFolders, setMyDriveFolders] = useState<FolderItem[]>([]);
  const [myDriveFiles, setMyDriveFiles] = useState<FileItem[]>([]);
  const [myDriveNextToken, setMyDriveNextToken] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [computers, setComputers] = useState<Computer[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [sort, setSort] = useState<SortKey>("name");
  const [dir, setDir] = useState<SortDir>("asc");
  const isWide = useWideLayout();
  const gridCols = useGridColumns();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [menuTarget, setMenuTarget] = useState<ItemTarget | null>(null);
  const [folderDialog, setFolderDialog] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadLabel, setUploadLabel] = useState("");
  const myDriveLoaded = useRef(false);
  const computersLoaded = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(VIEW_KEY).then((v) => {
      if (v === "list" || v === "grid") setViewMode(v);
    });
  }, []);

  const changeViewMode = async (mode: ViewMode) => {
    setViewMode(mode);
    await AsyncStorage.setItem(VIEW_KEY, mode);
  };

  const loadMyDrive = useCallback(async (opts?: { soft?: boolean }) => {
    if (!opts?.soft) setLoading(true);
    setError("");
    try {
      const contents = await api.folderRoot({ page_size: 100 });
      setMyDriveFolders(contents.folders);
      setMyDriveFiles(contents.files);
      setMyDriveNextToken(contents.next_page_token || "");
      await writeListCache<FolderContentsCache>(LIST_CACHE_KEYS.folderRoot, {
        folders: contents.folders,
        files: contents.files,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadMoreMyDrive = useCallback(async () => {
    if (tab !== "my-drive" || loadingMore || !myDriveNextToken) return;
    setLoadingMore(true);
    try {
      const contents = await api.folderRoot({
        page_size: 100,
        page_token: myDriveNextToken,
      });
      setMyDriveFiles((prev) => {
        const seen = new Set(prev.map((f) => f.id));
        const extra = contents.files.filter((f) => !seen.has(f.id));
        return [...prev, ...extra];
      });
      setMyDriveNextToken(contents.next_page_token || "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [tab, loadingMore, myDriveNextToken]);

  const loadComputers = useCallback(async (opts?: { soft?: boolean }) => {
    if (!opts?.soft) setLoading(true);
    setError("");
    try {
      const list = await api.computers();
      setComputers(list);
      await writeListCache<ComputersCache>(LIST_CACHE_KEYS.computers, { computers: list });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const refreshTab = useCallback(
    (opts?: { soft?: boolean }) => {
      if (tab === "computers") return loadComputers(opts);
      return loadMyDrive(opts);
    },
    [tab, loadComputers, loadMyDrive],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (tab === "computers") {
        if (computersLoaded.current) {
          setLoading(false);
          await loadComputers({ soft: true });
          return;
        }
        const cached = await readListCache<ComputersCache>(LIST_CACHE_KEYS.computers);
        if (!cancelled && cached?.computers?.length) {
          setComputers(cached.computers);
          setLoading(false);
        }
        if (!cancelled) {
          await loadComputers({ soft: Boolean(cached?.computers?.length) });
          computersLoaded.current = true;
        }
      } else {
        if (myDriveLoaded.current) {
          setLoading(false);
          await loadMyDrive({ soft: true });
          return;
        }
        const cached = await readListCache<FolderContentsCache>(LIST_CACHE_KEYS.folderRoot);
        if (!cancelled && (cached?.folders?.length || cached?.files?.length)) {
          setMyDriveFolders(cached.folders);
          setMyDriveFiles(cached.files);
          setLoading(false);
        }
        if (!cancelled) {
          await loadMyDrive({
            soft: Boolean(cached?.folders?.length || cached?.files?.length),
          });
          myDriveLoaded.current = true;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, loadComputers, loadMyDrive]);

  const onRefresh = () => {
    setRefreshing(true);
    void refreshTab({ soft: true });
  };

  const entries = useMemo((): ListEntry[] => {
    if (tab === "computers") {
      return computers.map((item) => ({ kind: "computer" as const, item }));
    }
    return sortMyDriveEntries(myDriveFolders, myDriveFiles, sort, dir);
  }, [tab, computers, myDriveFolders, myDriveFiles, sort, dir]);

  const openFolder = (id: string, title: string) => {
    navigation.push("Folder", { folderId: id, title });
  };

  const renderItem = ({ item }: { item: ListEntry }) => {
    if (item.kind === "computer") {
      return (
        <ComputerRow
          computer={item.item}
          onPress={() =>
            openFolder(item.item.root_folder_id, item.item.name || item.item.hostname || "Computer")
          }
        />
      );
    }
    if (item.kind === "folder") {
      if (viewMode === "grid") {
        return (
          <FolderGridTile
            folder={item.item}
            columns={gridCols}
            onPress={() => openFolder(item.item.id, item.item.name)}
            onMenuPress={() => setMenuTarget({ kind: "folder", item: item.item })}
          />
        );
      }
      return (
        <FolderRow
          folder={item.item}
          onPress={() => openFolder(item.item.id, item.item.name)}
          onMenuPress={() => setMenuTarget({ kind: "folder", item: item.item })}
        />
      );
    }
    if (viewMode === "grid") {
      return (
        <FileGridTile
          file={item.item}
          columns={gridCols}
          onPress={() => openFile(item.item, navigation, { gallery: myDriveFiles })}
          onMenuPress={() => setMenuTarget({ kind: "file", item: item.item })}
        />
      );
    }
    return (
      <FileRow
        file={item.item}
        onPress={() => openFile(item.item, navigation, { gallery: myDriveFiles })}
        onMenuPress={() => setMenuTarget({ kind: "file", item: item.item })}
      />
    );
  };

  const showSpinner = loading && entries.length === 0;

  const handleUpload = useCallback(async () => {
    setUploading(true);
    setUploadLabel("Preparing…");
    try {
      const uploaded = await pickAndUploadFiles(null, (p) => {
        setUploadLabel(`Uploading ${p.current}/${p.total}: ${p.name}`);
      });
      if (uploaded.length > 0) {
        await refreshTab({ soft: true });
      }
    } finally {
      setUploading(false);
      setUploadLabel("");
    }
  }, [refreshTab]);

  const openFolderDialog = useCallback(() => setFolderDialog(true), []);

  const handleCreateDocument = useCallback(async () => {
    setUploading(true);
    setUploadLabel("Creating document…");
    try {
      const created = await createEncryptedTextFile({
        name: "Document.txt",
        mimeType: "text/plain",
        text: "",
        folderId: null,
      });
      await refreshTab({ soft: true });
      await openFile(created, navigation, { gallery: [created] });
    } catch (err) {
      console.error("create document failed:", err);
    } finally {
      setUploading(false);
      setUploadLabel("");
    }
  }, [navigation, refreshTab]);

  const handleCreateSpreadsheet = useCallback(async () => {
    setUploading(true);
    setUploadLabel("Creating spreadsheet…");
    try {
      const created = await createEncryptedBinaryFile({
        name: "Spreadsheet.xlsx",
        mimeType: XLSX_MIME,
        bytes: emptyXlsxBytes(),
        folderId: null,
      });
      await refreshTab({ soft: true });
      await openFile(created, navigation, { gallery: [created] });
    } catch (err) {
      console.error("create spreadsheet failed:", err);
    } finally {
      setUploading(false);
      setUploadLabel("");
    }
  }, [navigation, refreshTab]);

  useRegisterCreateHandlers({
    onUpload: () => {
      void handleUpload();
    },
    onFolder: openFolderDialog,
    onDocument: () => {
      void handleCreateDocument();
    },
    onSpreadsheet: () => {
      void handleCreateSpreadsheet();
    },
  });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {!isWide ? (
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
        onChanged={() => refreshTab({ soft: true })}
      />
      <NewFolderDialog
        visible={folderDialog}
        onCancel={() => setFolderDialog(false)}
        onCreate={async (name) => {
          await api.createFolder({ name, parent_id: null });
          setFolderDialog(false);
          await refreshTab({ soft: true });
        }}
      />
      <Modal visible={uploading} transparent animationType="fade">
        <View style={styles.uploadOverlay}>
          <ActivityIndicator color={colors.accent} size="large" />
          <Text style={styles.uploadText}>{uploadLabel || "Uploading…"}</Text>
        </View>
      </Modal>
      <SearchBar
        value={search}
        onChangeText={setSearch}
        onSubmit={() => {
          if (search.trim()) navigation.navigate("Search", { query: search.trim() });
        }}
        onAvatarPress={() => setProfileOpen(true)}
        onMenuPress={isWide ? undefined : () => setDrawerOpen(true)}
      />

      <View style={styles.tabs}>
        <Pressable
          style={[styles.tab, tab === "my-drive" && styles.tabActive]}
          onPress={() => setTab("my-drive")}
        >
          <Text style={[styles.tabText, tab === "my-drive" && styles.tabTextActive]}>My Drive</Text>
        </Pressable>
        <Pressable
          style={[styles.tab, tab === "computers" && styles.tabActive]}
          onPress={() => setTab("computers")}
        >
          <Text style={[styles.tabText, tab === "computers" && styles.tabTextActive]}>
            Computers
          </Text>
        </Pressable>
      </View>

      {tab === "computers" ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            Changes to your files will automatically sync between FreeDrive and your computer
          </Text>
        </View>
      ) : null}

      {tab === "my-drive" ? (
        <SortHeader
          sort={sort}
          dir={dir}
          viewMode={viewMode}
          onToggleSort={() => {
            if (sort === "name") {
              setDir((d) => (d === "asc" ? "desc" : "asc"));
            } else {
              setSort("name");
              setDir("asc");
            }
          }}
          onChangeViewMode={changeViewMode}
        />
      ) : (
        <SortHeader
          sort={sort}
          dir={dir}
          viewMode="list"
          onToggleSort={() => setDir((d) => (d === "asc" ? "desc" : "asc"))}
          onChangeViewMode={() => undefined}
        />
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {showSpinner ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.accent} />
      ) : (
        <FlatList
          key={viewMode === "grid" && tab === "my-drive" ? `grid-${gridCols}` : "list"}
          data={entries}
          keyExtractor={(item) => `${item.kind}-${item.item.id}`}
          renderItem={renderItem}
          numColumns={viewMode === "grid" && tab === "my-drive" ? gridCols : 1}
          columnWrapperStyle={
            viewMode === "grid" && tab === "my-drive" ? styles.gridRow : undefined
          }
          contentContainerStyle={entries.length === 0 ? styles.emptyContainer : undefined}
          onEndReached={() => {
            void loadMoreMyDrive();
          }}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore && tab === "my-drive" ? (
              <ActivityIndicator style={{ marginVertical: 16 }} color={colors.accent} />
            ) : null
          }
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
          }
          ListEmptyComponent={
            <EmptyState
              title={tab === "computers" ? "No computers" : "No files yet"}
              subtitle={
                tab === "computers"
                  ? "Register a computer with the FreeDrive desktop app"
                  : "Folders and files from My Drive will appear here"
              }
            />
          }
        />
      )}

      {tab === "my-drive" && !isWide ? (
        <CreateFab
          onUpload={() => void handleUpload()}
          onFolder={() => setFolderDialog(true)}
          onDocument={() => void handleCreateDocument()}
          onSpreadsheet={() => void handleCreateSpreadsheet()}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  tabs: {
    flexDirection: "row",
    paddingHorizontal: spacing.lg,
    gap: spacing.xl,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  tab: {
    paddingVertical: spacing.md,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: { borderBottomColor: colors.accent },
  tabText: { color: colors.textSecondary, fontSize: 15, fontWeight: "500" },
  tabTextActive: { color: colors.text },
  banner: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
  },
  bannerText: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  error: {
    color: colors.danger,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  gridRow: {
    paddingHorizontal: spacing.lg,
    flexDirection: "row",
  },
  emptyContainer: { flexGrow: 1 },
  uploadOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  uploadText: {
    color: colors.text,
    textAlign: "center",
    fontSize: 14,
  },
});
