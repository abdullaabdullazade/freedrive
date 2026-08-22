import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
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
import type { FileItem, FolderItem, SortDir, SortKey, ViewMode } from "../api/types";
import {
  LIST_CACHE_KEYS,
  readListCache,
  writeListCache,
  type FolderContentsCache,
} from "../cache/listCache";
import { CreateFab } from "../components/CreateFab";
import { EmptyState } from "../components/EmptyState";
import { FileGridTile, FileRow } from "../components/FileRow";
import { FolderGridTile, FolderRow } from "../components/FolderRow";
import { ItemActionsSheet, type ItemTarget } from "../components/ItemActionsSheet";
import { NewFolderDialog } from "../components/NewFolderDialog";
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
  NativeStackScreenProps<FilesStackParamList, "Folder">,
  CompositeScreenProps<
    BottomTabScreenProps<MainTabParamList>,
    NativeStackScreenProps<RootStackParamList>
  >
>;

type ListEntry =
  | { kind: "folder"; item: FolderItem }
  | { kind: "file"; item: FileItem };

const VIEW_KEY = "fd_view_mode";

export function FolderScreen({ route, navigation }: Props) {
  const { folderId, title } = route.params;
  const gridCols = useGridColumns();
  const isLandscape = useWideLayout();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [nextPageToken, setNextPageToken] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [sort, setSort] = useState<SortKey>("name");
  const [dir, setDir] = useState<SortDir>("asc");
  const [menuTarget, setMenuTarget] = useState<ItemTarget | null>(null);
  const [folderDialog, setFolderDialog] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadLabel, setUploadLabel] = useState("");

  useEffect(() => {
    navigation.setOptions({
      title: title || "Folder",
      headerStyle: { backgroundColor: colors.bg },
      headerTintColor: colors.text,
      headerTitleStyle: { fontWeight: "600" },
      headerShadowVisible: false,
    });
  }, [navigation, title]);

  useEffect(() => {
    AsyncStorage.getItem(VIEW_KEY).then((v) => {
      if (v === "list" || v === "grid") setViewMode(v);
    });
  }, []);

  const changeViewMode = async (mode: ViewMode) => {
    setViewMode(mode);
    await AsyncStorage.setItem(VIEW_KEY, mode);
  };

  const load = useCallback(
    async (opts?: { soft?: boolean }) => {
      if (!opts?.soft) setLoading(true);
      setError("");
      try {
        const contents = await api.folder(folderId, { page_size: 100 });
        setFolders(contents.folders);
        setFiles(contents.files);
        setNextPageToken(contents.next_page_token || "");
        const folderName = contents.folder?.name;
        if (folderName) {
          navigation.setOptions({ title: folderName });
        }
        await writeListCache<FolderContentsCache>(LIST_CACHE_KEYS.folder(folderId), {
          folders: contents.folders,
          files: contents.files,
          folderName,
        });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [folderId, navigation],
  );

  const loadMore = useCallback(async () => {
    if (loadingMore || !nextPageToken) return;
    setLoadingMore(true);
    try {
      const contents = await api.folder(folderId, {
        page_size: 100,
        page_token: nextPageToken,
      });
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.id));
        const extra = contents.files.filter((f) => !seen.has(f.id));
        return [...prev, ...extra];
      });
      setNextPageToken(contents.next_page_token || "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [folderId, loadingMore, nextPageToken]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cached = await readListCache<FolderContentsCache>(LIST_CACHE_KEYS.folder(folderId));
      if (!cancelled && (cached?.folders?.length || cached?.files?.length)) {
        setFolders(cached.folders);
        setFiles(cached.files);
        if (cached.folderName) {
          navigation.setOptions({ title: cached.folderName });
        }
        setLoading(false);
      }
      if (!cancelled) {
        await load({ soft: Boolean(cached?.folders?.length || cached?.files?.length) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [folderId, load, navigation]);

  const entries = useMemo((): ListEntry[] => {
    const compare = (a: string, b: string) =>
      dir === "asc" ? a.localeCompare(b) : b.localeCompare(a);
    const byDate = (a?: string, b?: string) => {
      const av = a ? new Date(a).getTime() : 0;
      const bv = b ? new Date(b).getTime() : 0;
      return dir === "asc" ? av - bv : bv - av;
    };
    const folderEntries = [...folders]
      .sort((a, b) =>
        sort === "name" ? compare(a.name, b.name) : byDate(a.updated_at, b.updated_at),
      )
      .map((item) => ({ kind: "folder" as const, item }));
    const fileEntries = [...files]
      .sort((a, b) =>
        sort === "name" ? compare(a.name, b.name) : byDate(a.updated_at, b.updated_at),
      )
      .map((item) => ({ kind: "file" as const, item }));
    return [...folderEntries, ...fileEntries];
  }, [folders, files, sort, dir]);

  const renderItem = ({ item }: { item: ListEntry }) => {
    if (item.kind === "folder") {
      if (viewMode === "grid") {
        return (
          <FolderGridTile
            folder={item.item}
            columns={gridCols}
            onPress={() =>
              navigation.push("Folder", { folderId: item.item.id, title: item.item.name })
            }
            onMenuPress={() => setMenuTarget({ kind: "folder", item: item.item })}
          />
        );
      }
      return (
        <FolderRow
          folder={item.item}
          onPress={() =>
            navigation.push("Folder", { folderId: item.item.id, title: item.item.name })
          }
          onMenuPress={() => setMenuTarget({ kind: "folder", item: item.item })}
        />
      );
    }
    return viewMode === "grid" ? (
      <FileGridTile
        file={item.item}
        columns={gridCols}
        onPress={() => openFile(item.item, navigation, { gallery: files })}
        onMenuPress={() => setMenuTarget({ kind: "file", item: item.item })}
      />
    ) : (
      <FileRow
        file={item.item}
        onPress={() => openFile(item.item, navigation, { gallery: files })}
        onMenuPress={() => setMenuTarget({ kind: "file", item: item.item })}
      />
    );
  };

  const showSpinner = loading && entries.length === 0;

  const handleUpload = useCallback(async () => {
    setUploading(true);
    setUploadLabel("Preparing…");
    try {
      const uploaded = await pickAndUploadFiles(folderId, (p) => {
        setUploadLabel(`Uploading ${p.current}/${p.total}: ${p.name}`);
      });
      if (uploaded.length > 0) {
        await load({ soft: true });
      }
    } finally {
      setUploading(false);
      setUploadLabel("");
    }
  }, [folderId, load]);

  const openFolderDialog = useCallback(() => setFolderDialog(true), []);

  const handleCreateDocument = useCallback(async () => {
    setUploading(true);
    setUploadLabel("Creating document…");
    try {
      const created = await createEncryptedTextFile({
        name: "Document.txt",
        mimeType: "text/plain",
        text: "",
        folderId,
      });
      await load({ soft: true });
      await openFile(created, navigation, { gallery: [created] });
    } catch (err) {
      console.error("create document failed:", err);
    } finally {
      setUploading(false);
      setUploadLabel("");
    }
  }, [folderId, load, navigation]);

  const handleCreateSpreadsheet = useCallback(async () => {
    setUploading(true);
    setUploadLabel("Creating spreadsheet…");
    try {
      const created = await createEncryptedBinaryFile({
        name: "Spreadsheet.xlsx",
        mimeType: XLSX_MIME,
        bytes: emptyXlsxBytes(),
        folderId,
      });
      await load({ soft: true });
      await openFile(created, navigation, { gallery: [created] });
    } catch (err) {
      console.error("create spreadsheet failed:", err);
    } finally {
      setUploading(false);
      setUploadLabel("");
    }
  }, [folderId, load, navigation]);

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
    <SafeAreaView style={styles.safe} edges={[]}>
      <ItemActionsSheet
        target={menuTarget}
        onClose={() => setMenuTarget(null)}
        onChanged={() => load({ soft: true })}
      />
      <NewFolderDialog
        visible={folderDialog}
        onCancel={() => setFolderDialog(false)}
        onCreate={async (name) => {
          await api.createFolder({ name, parent_id: folderId });
          setFolderDialog(false);
          await load({ soft: true });
        }}
      />
      <Modal visible={uploading} transparent animationType="fade">
        <View style={styles.uploadOverlay}>
          <ActivityIndicator color={colors.accent} size="large" />
          <Text style={styles.uploadText}>{uploadLabel || "Uploading…"}</Text>
        </View>
      </Modal>
      <SortHeader
        sort={sort}
        dir={dir}
        viewMode={viewMode}
        onToggleSort={() => {
          if (sort === "name") setDir((d) => (d === "asc" ? "desc" : "asc"));
          else {
            setSort("name");
            setDir("asc");
          }
        }}
        onChangeViewMode={changeViewMode}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {showSpinner ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.accent} />
      ) : (
        <FlatList
          key={`grid-${viewMode}-${gridCols}`}
          data={entries}
          keyExtractor={(item) => `${item.kind}-${item.item.id}`}
          renderItem={renderItem}
          numColumns={viewMode === "grid" ? gridCols : 1}
          columnWrapperStyle={viewMode === "grid" ? styles.gridRow : undefined}
          contentContainerStyle={entries.length === 0 ? styles.emptyContainer : undefined}
          onEndReached={() => {
            void loadMore();
          }}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator style={{ marginVertical: 16 }} color={colors.accent} />
            ) : null
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load({ soft: true });
              }}
              tintColor={colors.accent}
            />
          }
          ListEmptyComponent={
            <EmptyState title="This folder is empty" subtitle="No files or folders here yet" />
          }
        />
      )}
      {!isLandscape ? (
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
