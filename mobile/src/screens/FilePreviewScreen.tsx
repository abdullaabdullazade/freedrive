import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewToken,
} from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import * as Sharing from "expo-sharing";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useVideoPlayer, VideoView } from "expo-video";
import type { RootStackParamList } from "../navigation/types";
import { colors, spacing } from "../theme";
import { SheetEditorView, loadAndSerializeSheet } from "../components/SheetEditorView";
import {
  canPrefetchMedia,
  downloadAndDecrypt,
  isTooLargeForInAppPreview,
  saveEncryptedContent,
  writePlainCache,
  type GalleryItem,
} from "../utils/openFile";
import type { ParsedSpreadsheet } from "../utils/sheetCodec";

type Props = NativeStackScreenProps<RootStackParamList, "FilePreview">;

type UriCache = Record<string, string>;

function VideoPreview({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.play();
  });

  useEffect(() => {
    return () => {
      try {
        player.pause();
      } catch {
        // Player may already be released.
      }
    };
  }, [player]);

  return (
    <VideoView
      style={styles.video}
      player={player}
      nativeControls
      contentFit="contain"
      fullscreenOptions={{ enable: true }}
    />
  );
}

export function FilePreviewScreen({ route, navigation }: Props) {
  const {
    title: initialTitle,
    uri: initialUri,
    mime: initialMime,
    mode,
    text: initialText,
    fileId: initialFileId,
    gallery: galleryParam,
    index: initialIndex = 0,
  } = route.params;

  const gallery = useMemo(
    () => galleryParam ?? [],
    [galleryParam],
  );
  const paging = (mode === "image" || mode === "video") && gallery.length > 1;
  const pageWidth = Dimensions.get("window").width;
  const insets = useSafeAreaInsets();

  const [pageIndex, setPageIndex] = useState(
    Math.min(Math.max(initialIndex, 0), Math.max(gallery.length - 1, 0)),
  );
  const [uriById, setUriById] = useState<UriCache>(() => {
    const id = initialFileId || gallery[initialIndex]?.id;
    return id ? { [id]: initialUri } : {};
  });
  const [loadingIds, setLoadingIds] = useState<Record<string, boolean>>({});
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  const [dirtyRotate, setDirtyRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [savingImage, setSavingImage] = useState(false);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialText ?? "");
  const [savedText, setSavedText] = useState(initialText ?? "");
  const [savingText, setSavingText] = useState(false);

  const [sheetEditing, setSheetEditing] = useState(false);
  const [sheetEdits, setSheetEdits] = useState<Map<string, string>>(() => new Map());
  const [sheetParsed, setSheetParsed] = useState<ParsedSpreadsheet | null>(null);
  const [sheetActiveIdx, setSheetActiveIdx] = useState(0);
  const [sheetLoadError, setSheetLoadError] = useState<string | null>(null);
  const [savingSheet, setSavingSheet] = useState(false);
  const [sheetUri, setSheetUri] = useState(initialUri);

  const listRef = useRef<FlatList<GalleryItem>>(null);
  const loadingRef = useRef<Set<string>>(new Set());

  const current = paging
    ? gallery[pageIndex]
    : gallery[0] ||
      (initialFileId
        ? {
            id: initialFileId,
            name: initialTitle,
            mime_type: initialMime,
            iv: "",
          }
        : null);

  const currentUri =
    (current && uriById[current.id]) ||
    (!paging ? initialUri : undefined);
  const currentMime = current?.mime_type || initialMime;
  const currentTitle = current?.name || initialTitle;
  const currentFileId = current?.id || initialFileId;

  const ensureLoaded = useCallback(
    async (item: GalleryItem) => {
      if (uriById[item.id] || loadingRef.current.has(item.id)) return;
      if (isTooLargeForInAppPreview(item)) {
        setErrorById((prev) => ({
          ...prev,
          [item.id]: "File too large to preview in the app. Use Save or Share from the file list.",
        }));
        return;
      }
      loadingRef.current.add(item.id);
      setLoadingIds((prev) => ({ ...prev, [item.id]: true }));
      try {
        const { uri } = await downloadAndDecrypt(item);
        setUriById((prev) => ({ ...prev, [item.id]: uri }));
        setErrorById((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
      } catch (err) {
        setErrorById((prev) => ({
          ...prev,
          [item.id]: err instanceof Error ? err.message : String(err),
        }));
      } finally {
        loadingRef.current.delete(item.id);
        setLoadingIds((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
      }
    },
    [uriById],
  );

  const prefetchNeighbors = useCallback(
    (index: number) => {
      if (!paging) return;
      // Only load the current page for large media; neighbor prefetch of multi-hundred-MB
      // videos can OOM or saturate disk/network while the user is still watching one clip.
      const indexes =
        mode === "video"
          ? [index]
          : [index - 1, index, index + 1];
      for (const i of indexes) {
        const item = gallery[i];
        if (!item) continue;
        if (i !== index && !canPrefetchMedia(item)) continue;
        void ensureLoaded(item);
      }
    },
    [ensureLoaded, gallery, mode, paging],
  );

  useEffect(() => {
    prefetchNeighbors(pageIndex);
  }, [pageIndex, prefetchNeighbors]);

  useEffect(() => {
    setDirtyRotate(false);
  }, [pageIndex]);

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems[0];
      if (first?.index != null) setPageIndex(first.index);
    },
  ).current;

  const viewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 60 }).current;

  const onMomentumScrollEnd = (
    e: NativeSyntheticEvent<NativeScrollEvent>,
  ) => {
    const next = Math.round(e.nativeEvent.contentOffset.x / pageWidth);
    if (next !== pageIndex && next >= 0 && next < gallery.length) {
      setPageIndex(next);
    }
  };

  const shareCurrent = async () => {
    const uri = mode === "sheet" ? sheetUri : currentUri;
    if (!uri) return;
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, {
        mimeType: currentMime,
        dialogTitle: currentTitle,
      });
    }
  };

  const rotateCurrent = async () => {
    if (!currentUri || !currentFileId) return;
    setRotating(true);
    try {
      const format = currentMime.toLowerCase().includes("png")
        ? ImageManipulator.SaveFormat.PNG
        : ImageManipulator.SaveFormat.JPEG;
      const result = await ImageManipulator.manipulateAsync(
        currentUri,
        [{ rotate: 90 }],
        { compress: 1, format },
      );
      setUriById((prev) => ({ ...prev, [currentFileId]: result.uri }));
      setDirtyRotate(true);
    } catch (err) {
      Alert.alert("Rotate failed", err instanceof Error ? err.message : String(err));
    } finally {
      setRotating(false);
    }
  };

  const saveRotated = async () => {
    if (!currentUri || !currentFileId || !current) return;
    setSavingImage(true);
    try {
      const b64 = await FileSystem.readAsStringAsync(currentUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const binary = globalThis.atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const mime = currentMime.toLowerCase().includes("png")
        ? "image/png"
        : currentMime.startsWith("image/")
          ? currentMime
          : "image/jpeg";
      await saveEncryptedContent({
        fileId: currentFileId,
        name: current.name,
        mimeType: mime,
        plaintext: bytes,
      });
      const cached = await writePlainCache(currentFileId, current.name, bytes);
      setUriById((prev) => ({ ...prev, [currentFileId]: cached }));
      setDirtyRotate(false);
      Alert.alert("Saved", "Image updated on FreeDrive.");
    } catch (err) {
      Alert.alert("Save failed", err instanceof Error ? err.message : String(err));
    } finally {
      setSavingImage(false);
    }
  };

  const saveText = async () => {
    if (!initialFileId) return;
    setSavingText(true);
    try {
      const plaintext = new TextEncoder().encode(draft);
      await saveEncryptedContent({
        fileId: initialFileId,
        name: initialTitle,
        mimeType: initialMime || "text/plain",
        plaintext,
      });
      await writePlainCache(initialFileId, initialTitle, plaintext);
      setSavedText(draft);
      setEditing(false);
      Alert.alert("Saved", "File updated on FreeDrive.");
    } catch (err) {
      Alert.alert("Save failed", err instanceof Error ? err.message : String(err));
    } finally {
      setSavingText(false);
    }
  };

  const saveSheet = async () => {
    if (!initialFileId) return;
    setSavingSheet(true);
    try {
      const { bytes, mimeType, parsed } = await loadAndSerializeSheet(
        sheetUri,
        initialTitle,
        initialMime,
        sheetEdits,
        sheetParsed,
      );
      await saveEncryptedContent({
        fileId: initialFileId,
        name: initialTitle,
        mimeType,
        plaintext: bytes,
      });
      const cached = await writePlainCache(initialFileId, initialTitle, bytes);
      setSheetUri(cached);
      setSheetParsed(parsed);
      setSheetEdits(new Map());
      setSheetEditing(false);
      Alert.alert("Saved", "Spreadsheet updated on FreeDrive.");
    } catch (err) {
      Alert.alert("Save failed", err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSheet(false);
    }
  };

  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerShown: true,
      title:
        mode === "image" || mode === "video"
          ? currentTitle
          : initialTitle || "Preview",
      headerStyle: { backgroundColor: colors.bg },
      headerTintColor: colors.text,
      headerRight: () => (
        <View style={styles.headerActions}>
          {mode === "image" && currentFileId ? (
            <>
              <Pressable
                onPress={() => void rotateCurrent()}
                disabled={rotating || !currentUri}
                style={styles.headerBtn}
              >
                <Text style={styles.headerBtnText}>
                  {rotating ? "…" : "Rotate"}
                </Text>
              </Pressable>
              {dirtyRotate ? (
                <Pressable
                  onPress={() => void saveRotated()}
                  disabled={savingImage}
                  style={styles.headerBtn}
                >
                  <Text style={styles.headerBtnText}>
                    {savingImage ? "…" : "Save"}
                  </Text>
                </Pressable>
              ) : null}
            </>
          ) : null}
          {mode === "text" && initialFileId ? (
            editing ? (
              <>
                <Pressable
                  onPress={() => {
                    setDraft(savedText);
                    setEditing(false);
                  }}
                  style={styles.headerBtn}
                >
                  <Text style={styles.headerBtnText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={() => void saveText()}
                  disabled={savingText}
                  style={styles.headerBtn}
                >
                  <Text style={styles.headerBtnText}>
                    {savingText ? "…" : "Save"}
                  </Text>
                </Pressable>
              </>
            ) : (
              <Pressable onPress={() => setEditing(true)} style={styles.headerBtn}>
                <Text style={styles.headerBtnText}>Edit</Text>
              </Pressable>
            )
          ) : null}
          {mode === "sheet" && initialFileId ? (
            sheetEditing ? (
              <>
                <Pressable
                  onPress={() => {
                    setSheetEdits(new Map());
                    setSheetEditing(false);
                  }}
                  style={styles.headerBtn}
                >
                  <Text style={styles.headerBtnText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={() => void saveSheet()}
                  disabled={savingSheet}
                  style={styles.headerBtn}
                >
                  <Text style={styles.headerBtnText}>
                    {savingSheet ? "…" : "Save"}
                  </Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                onPress={() => setSheetEditing(true)}
                style={styles.headerBtn}
              >
                <Text style={styles.headerBtnText}>Edit</Text>
              </Pressable>
            )
          ) : null}
          <Pressable onPress={() => void shareCurrent()} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>Share</Text>
          </Pressable>
        </View>
      ),
    });
  }, [
    navigation,
    mode,
    currentTitle,
    initialTitle,
    currentFileId,
    currentUri,
    rotating,
    dirtyRotate,
    savingImage,
    editing,
    savingText,
    savedText,
    draft,
    initialFileId,
    initialMime,
    sheetEditing,
    savingSheet,
    sheetEdits,
    sheetParsed,
    sheetUri,
  ]);

  if (mode === "image" && paging) {
    return (
      <View style={styles.center}>
        <FlatList
          ref={listRef}
          data={gallery}
          keyExtractor={(item) => item.id}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={Math.min(initialIndex, gallery.length - 1)}
          getItemLayout={(_, index) => ({
            length: pageWidth,
            offset: pageWidth * index,
            index,
          })}
          onMomentumScrollEnd={onMomentumScrollEnd}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          renderItem={({ item }) => {
            const uri = uriById[item.id];
            const loading = !!loadingIds[item.id];
            const error = errorById[item.id];
            return (
              <View
                style={[
                  styles.page,
                  { width: pageWidth, paddingBottom: insets.bottom },
                ]}
              >
                {uri ? (
                  <Image source={{ uri }} style={styles.image} resizeMode="contain" />
                ) : loading ? (
                  <ActivityIndicator color={colors.accent} />
                ) : error ? (
                  <Text style={styles.hint}>{error}</Text>
                ) : (
                  <ActivityIndicator color={colors.accent} />
                )}
              </View>
            );
          }}
        />
        <Text style={[styles.counter, { bottom: spacing.lg + insets.bottom }]}>
          {pageIndex + 1} / {gallery.length}
        </Text>
      </View>
    );
  }

  if (mode === "image") {
    return (
      <View style={[styles.center, { paddingBottom: insets.bottom, width: "100%" }]}>
        {currentUri ? (
          <Image source={{ uri: currentUri }} style={styles.image} resizeMode="contain" />
        ) : (
          <ActivityIndicator color={colors.accent} />
        )}
      </View>
    );
  }

  if (mode === "video" && paging) {
    return (
      <View style={[styles.center, styles.videoSafe]}>
        <FlatList
          ref={listRef}
          data={gallery}
          keyExtractor={(item) => item.id}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={Math.min(initialIndex, gallery.length - 1)}
          getItemLayout={(_, index) => ({
            length: pageWidth,
            offset: pageWidth * index,
            index,
          })}
          onMomentumScrollEnd={onMomentumScrollEnd}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          renderItem={({ item, index }) => {
            const uri = uriById[item.id];
            const loading = !!loadingIds[item.id];
            const error = errorById[item.id];
            const active = index === pageIndex;
            return (
              <View
                style={[
                  styles.page,
                  styles.videoSafe,
                  { width: pageWidth, paddingBottom: insets.bottom },
                ]}
              >
                {uri && active ? (
                  <VideoPreview uri={uri} />
                ) : uri ? (
                  <View style={styles.video} />
                ) : loading ? (
                  <ActivityIndicator color={colors.accent} />
                ) : error ? (
                  <Text style={styles.hint}>{error}</Text>
                ) : (
                  <ActivityIndicator color={colors.accent} />
                )}
              </View>
            );
          }}
        />
        <Text style={[styles.counter, { bottom: spacing.lg + insets.bottom }]}>
          {pageIndex + 1} / {gallery.length}
        </Text>
      </View>
    );
  }

  if (mode === "video") {
    const videoUri = currentUri || initialUri;
    if (!videoUri) {
      return (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      );
    }
    return (
      <View
        style={[
          styles.center,
          styles.videoSafe,
          { paddingBottom: insets.bottom, width: "100%" },
        ]}
      >
        <VideoPreview uri={videoUri} />
      </View>
    );
  }

  if (mode === "text") {
    const textBottomPad = {
      paddingBottom: spacing.lg + insets.bottom,
    };
    if (editing) {
      return (
        <TextInput
          style={[styles.safe, styles.textPad, styles.editor, textBottomPad]}
          value={draft}
          onChangeText={setDraft}
          multiline
          textAlignVertical="top"
          autoFocus
        />
      );
    }
    return (
      <ScrollView
        style={styles.safe}
        contentContainerStyle={[styles.textPad, textBottomPad]}
      >
        <Text style={styles.text}>{savedText}</Text>
      </ScrollView>
    );
  }

  if (mode === "sheet") {
    return (
      <SheetEditorView
        uri={sheetUri}
        fileName={initialTitle}
        mime={initialMime}
        editing={sheetEditing}
        edits={sheetEdits}
        onEditsChange={setSheetEdits}
        activeSheetIdx={sheetActiveIdx}
        onActiveSheetIdxChange={setSheetActiveIdx}
        parsed={sheetParsed}
        onParsed={setSheetParsed}
        loadError={sheetLoadError}
        onLoadError={setSheetLoadError}
      />
    );
  }

  return (
    <View style={[styles.center, { paddingBottom: insets.bottom }]}>
      <Text style={styles.hint}>PDF preview uses your device apps.</Text>
      <Pressable
        style={styles.btn}
        onPress={async () => {
          if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(initialUri, {
              mimeType: initialMime || "application/pdf",
              dialogTitle: initialTitle,
            });
          }
        }}
      >
        <Text style={styles.btnText}>Open with…</Text>
      </Pressable>
      <ActivityIndicator style={{ marginTop: 24 }} color={colors.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  center: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  page: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  image: { width: "100%", height: "100%" },
  videoSafe: { backgroundColor: "#000", width: "100%" },
  video: { width: "100%", flex: 1, backgroundColor: "#000" },
  textPad: { padding: spacing.lg, flexGrow: 1 },
  text: { color: colors.text, fontSize: 14, lineHeight: 20, fontFamily: "monospace" },
  editor: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: "monospace",
  },
  hint: { color: colors.textSecondary, marginBottom: spacing.lg, textAlign: "center", paddingHorizontal: spacing.lg },
  btn: {
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: 999,
  },
  btnText: { color: "#0B1C2C", fontWeight: "600" },
  headerActions: { flexDirection: "row", alignItems: "center" },
  headerBtn: { paddingHorizontal: 10 },
  headerBtnText: { color: colors.accent, fontWeight: "600" },
  counter: {
    position: "absolute",
    bottom: spacing.lg,
    color: colors.textSecondary,
    fontSize: 13,
  },
});
