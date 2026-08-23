import * as Clipboard from "expo-clipboard";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Alert, NativeModules, PermissionsAndroid, Platform } from "react-native";
import { api } from "../api/client";
import type { FileItem } from "../api/types";
import {
  decryptDownloadedFile,
  encryptFileBytes,
  ensureFileKey,
  rawKeyToStandardBase64,
} from "../crypto";
import type { RootStackParamList } from "../navigation/types";
import { isSpreadsheetFile } from "./sheetCodec";

type DownloadsNativeModule = {
  beginDownload(fileName: string): Promise<number>;
  completeDownload(
    notificationId: number,
    fileName: string,
    mimeType: string,
    contentUri: string,
  ): Promise<void>;
  failDownload(notificationId: number, message: string): Promise<void>;
  saveBase64(fileName: string, mimeType: string, base64: string): Promise<string>;
  saveFromPath?(fileName: string, mimeType: string, sourcePath: string): Promise<string>;
  decryptAesGcmFile?(
    encryptedPath: string,
    outputPath: string,
    keyB64: string,
    ivB64: string,
    notificationId?: number,
    fileName?: string,
  ): Promise<string>;
  encryptAesGcmFile?(
    plainPath: string,
    outputPath: string,
    keyB64: string,
  ): Promise<{
    path: string;
    ivB64: string;
    originalSize: number;
    encryptedSize: number;
  }>;
  readFileSliceBase64?(path: string, offset: number, length: number): Promise<string>;
  downloadToFile?(
    url: string,
    destPath: string,
    headers: Record<string, string> | null,
    notificationId: number,
    fileName: string,
  ): Promise<{
    status: number;
    path: string;
    iv: string;
    mime: string;
    originalSize: number;
  }>;
  updateDownloadProgress?(
    notificationId: number,
    fileName: string,
    bytesWritten: number,
    bytesTotal: number,
    ): Promise<void>;
};

const downloadsModule = NativeModules.FreeDriveDownloads as DownloadsNativeModule | undefined;

/** Above this size, in-memory JS decrypt (ArrayBuffer + base64) will OOM on mobile. */
export const JS_DECRYPT_MAX_BYTES = 48 * 1024 * 1024;

/** Safe upper bound for in-app image/video preview on typical phones. Larger → Save/Share only. */
export const IN_APP_MEDIA_PREVIEW_MAX_BYTES = 100 * 1024 * 1024;

type PreviewNav = {
  navigate: (
    screen: "FilePreview",
    params: RootStackParamList["FilePreview"],
  ) => void;
};

export type OpenFileOptions = {
  /** Sibling files from the current list (images filtered for swipe gallery). */
  gallery?: FileItem[];
};

export type GalleryItem = {
  id: string;
  name: string;
  mime_type: string;
  iv: string;
  size?: number;
  encrypted_size?: number;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return globalThis.btoa(binary);
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_") || "file";
}

function fileSizeHint(
  file: Pick<FileItem, "size" | "encrypted_size"> | { size?: number; encrypted_size?: number },
): number {
  const size = typeof file.size === "number" ? file.size : 0;
  const enc = typeof file.encrypted_size === "number" ? file.encrypted_size : 0;
  return Math.max(size, enc);
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function canPrefetchMedia(file: { size?: number; encrypted_size?: number }): boolean {
  const size = fileSizeHint(file);
  if (size <= 0) return true;
  return size <= IN_APP_MEDIA_PREVIEW_MAX_BYTES;
}

export function isTooLargeForInAppPreview(
  file: Pick<FileItem, "size" | "encrypted_size"> | { size?: number; encrypted_size?: number },
): boolean {
  const size = fileSizeHint(file);
  return size > IN_APP_MEDIA_PREVIEW_MAX_BYTES;
}

function hasNativeDecrypt(): boolean {
  return Platform.OS === "android" && typeof downloadsModule?.decryptAesGcmFile === "function";
}

export function isImageFile(file: Pick<FileItem, "name" | "mime_type">): boolean {
  const mime = (file.mime_type || "").toLowerCase();
  if (mime.startsWith("image/")) return true;
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(file.name);
}

export function isVideoFile(file: Pick<FileItem, "name" | "mime_type">): boolean {
  const mime = (file.mime_type || "").toLowerCase();
  if (mime.startsWith("video/")) return true;
  return /\.(mp4|webm|mkv|mov|m4v|avi|3gp)$/i.test(file.name);
}

export function isAudioFile(file: Pick<FileItem, "name" | "mime_type">): boolean {
  const mime = (file.mime_type || "").toLowerCase();
  if (mime.startsWith("audio/")) return true;
  return /\.(mp3|m4a|aac|wav|flac|ogg|opus|oga|wma|amr)$/i.test(file.name);
}

function isImage(mime: string): boolean {
  return mime.toLowerCase().startsWith("image/");
}

function isVideo(mime: string): boolean {
  return mime.toLowerCase().startsWith("video/");
}

function isText(mime: string, name: string): boolean {
  if (isSpreadsheetFile(name, mime)) return false;
  const m = mime.toLowerCase();
  const n = name.toLowerCase();
  return (
    m.startsWith("text/") ||
    m.includes("json") ||
    /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|env|log|csv|tsv|xml|html?|css|scss|sass|less|js|jsx|mjs|cjs|ts|tsx|py|pyw|rb|php|go|rs|java|kt|kts|swift|c|h|cc|cpp|cxx|hpp|cs|fs|fsx|sh|bash|zsh|fish|ps1|sql|graphql|gql|vue|svelte|dart|lua|r|dockerfile|gitignore|gitattributes)$/i.test(n) ||
    /(^|\/)(dockerfile|makefile|license|readme)$/i.test(n)
  );
}

function isPdf(mime: string, name: string): boolean {
  return mime.toLowerCase().includes("pdf") || name.toLowerCase().endsWith(".pdf");
}

async function downloadAndDecryptViaNative(
  file: Pick<FileItem, "id" | "name" | "iv" | "mime_type"> & {
    size?: number;
    encrypted_size?: number;
  },
  opts?: { progressNotificationId?: number },
): Promise<{ uri: string; mime: string; bytes: Uint8Array }> {
  const decrypt = downloadsModule?.decryptAesGcmFile;
  if (!decrypt) throw new Error("Native decrypt is unavailable");

  const dir = FileSystem.cacheDirectory;
  if (!dir) throw new Error("Cache directory unavailable");

  const encPath = `${dir}fd_enc_${file.id}.bin`;
  const plainPath = `${dir}fd_${file.id}_${safeFileName(file.name)}`;

  try {
    const downloaded = await api.downloadEncryptedToFile(file.id, encPath, {
      progressNotificationId: opts?.progressNotificationId,
      fileName: file.name,
    });
    const iv = downloaded.iv || file.iv;
    const mime = downloaded.mime || file.mime_type || "application/octet-stream";

    if (!iv) {
      // Legacy unencrypted: move ciphertext path to plaintext path.
      await FileSystem.deleteAsync(plainPath, { idempotent: true }).catch(() => {});
      await FileSystem.moveAsync({ from: downloaded.uri || encPath, to: plainPath });
      return { uri: plainPath, mime, bytes: new Uint8Array(0) };
    }

    const key = await ensureFileKey(file.id);
    await FileSystem.deleteAsync(plainPath, { idempotent: true }).catch(() => {});
    const encForDecrypt = downloaded.uri || encPath;
    await decrypt(
      encForDecrypt,
      plainPath,
      rawKeyToStandardBase64(key),
      iv,
      opts?.progressNotificationId ?? -1,
      file.name,
    );
    return { uri: plainPath, mime, bytes: new Uint8Array(0) };
  } finally {
    await FileSystem.deleteAsync(encPath, { idempotent: true }).catch(() => {});
  }
}

async function downloadAndDecryptInMemory(
  file: Pick<FileItem, "id" | "name" | "iv" | "mime_type">,
  needBytes: boolean,
): Promise<{ uri: string; mime: string; bytes: Uint8Array }> {
  const downloaded = await api.downloadEncrypted(file.id);
  const plain = await decryptDownloadedFile(file.id, downloaded.iv || file.iv, downloaded.data);
  const mime = downloaded.mime || file.mime_type || "application/octet-stream";
  const dir = FileSystem.cacheDirectory;
  if (!dir) throw new Error("Cache directory unavailable");
  const path = `${dir}fd_${file.id}_${safeFileName(file.name)}`;
  await FileSystem.writeAsStringAsync(path, bytesToBase64(plain), {
    encoding: FileSystem.EncodingType.Base64,
  });
  return { uri: path, mime, bytes: needBytes ? plain : new Uint8Array(0) };
}

export async function downloadAndDecrypt(
  file: Pick<FileItem, "id" | "name" | "iv" | "mime_type"> & {
    size?: number;
    encrypted_size?: number;
  },
  opts?: { needBytes?: boolean; progressNotificationId?: number },
): Promise<{
  uri: string;
  mime: string;
  bytes: Uint8Array;
}> {
  const needBytes = opts?.needBytes === true;
  const size = fileSizeHint(file);
  const nativeOk = hasNativeDecrypt();

  if (size > JS_DECRYPT_MAX_BYTES && !nativeOk) {
    throw new Error(
      `This file is too large to open in the app (${formatBytes(size)}). ` +
        "Please open it on desktop, or update FreeDrive to a build with large-file support.",
    );
  }

  if (needBytes && size > JS_DECRYPT_MAX_BYTES) {
    throw new Error(
      `This file is too large to edit or preview as text (${formatBytes(size)}).`,
    );
  }

  // Prefer disk + native AES for anything above the JS-safe limit, and for all
  // video (even smaller) so gallery / open never spikes the Hermes heap.
  const preferNative =
    nativeOk && (size > JS_DECRYPT_MAX_BYTES || isVideoFile(file) || (!needBytes && size > 8 * 1024 * 1024));

  if (preferNative) {
    return downloadAndDecryptViaNative(file, {
      progressNotificationId: opts?.progressNotificationId,
    });
  }

  return downloadAndDecryptInMemory(file, needBytes);
}

/** Encrypt plaintext and POST as the new content for an existing file. */
export async function saveEncryptedContent(opts: {
  fileId: string;
  name: string;
  mimeType: string;
  plaintext: Uint8Array;
}): Promise<FileItem> {
  const key = await ensureFileKey(opts.fileId);
  const { ciphertext, ivB64 } = await encryptFileBytes(opts.plaintext, key);
  const dir = FileSystem.cacheDirectory;
  if (!dir) throw new Error("Cache directory unavailable");
  const encPath = `${dir}fd_upload_${opts.fileId}_${Date.now()}.bin`;
  await FileSystem.writeAsStringAsync(encPath, bytesToBase64(ciphertext), {
    encoding: FileSystem.EncodingType.Base64,
  });
  try {
    return await api.updateFileContent(opts.fileId, {
      name: opts.name,
      mimeType: opts.mimeType,
      iv: ivB64,
      originalSize: opts.plaintext.length,
      encryptedUri: encPath,
    });
  } finally {
    await FileSystem.deleteAsync(encPath, { idempotent: true }).catch(() => {});
  }
}

export async function writePlainCache(
  fileId: string,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) throw new Error("Cache directory unavailable");
  const path = `${dir}fd_${fileId}_${safeFileName(name)}`;
  await FileSystem.writeAsStringAsync(path, bytesToBase64(bytes), {
    encoding: FileSystem.EncodingType.Base64,
  });
  return path;
}

function toGalleryItem(f: FileItem): GalleryItem {
  return {
    id: f.id,
    name: f.name,
    mime_type: f.mime_type,
    iv: f.iv,
    size: f.size,
    encrypted_size: f.encrypted_size,
  };
}

export async function openFile(
  file: FileItem,
  navigation?: PreviewNav,
  opts?: OpenFileOptions,
): Promise<void> {
  try {
    if (
      (isVideoFile(file) || isImageFile(file)) &&
      isTooLargeForInAppPreview(file)
    ) {
      const sizeLabel = formatBytes(fileSizeHint(file));
      Alert.alert(
        "File too large to preview",
        `This file is ${sizeLabel}. Save it to your device or share it instead of opening it in the app.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Share",
            onPress: () => {
              void downloadFileToShare(file);
            },
          },
          {
            text: "Save",
            onPress: () => {
              void downloadFileToDevice(file);
            },
          },
        ],
      );
      return;
    }

    const wantsText = isText(file.mime_type, file.name);
    const { uri, mime, bytes } = await downloadAndDecrypt(file, {
      needBytes: wantsText,
    });

    if (navigation && (isImage(mime) || isImageFile(file))) {
      const gallerySrc = (opts?.gallery ?? []).filter(isImageFile);
      const gallery: GalleryItem[] =
        gallerySrc.length > 0
          ? gallerySrc.map(toGalleryItem)
          : [toGalleryItem(file)];
      let index = gallery.findIndex((g) => g.id === file.id);
      if (index < 0) {
        gallery.unshift(toGalleryItem(file));
        index = 0;
      }
      navigation.navigate("FilePreview", {
        title: file.name,
        uri,
        mime,
        mode: "image",
        fileId: file.id,
        gallery,
        index,
      });
      return;
    }

    if (navigation && (isVideo(mime) || isVideoFile(file))) {
      const gallerySrc = (opts?.gallery ?? []).filter(isVideoFile);
      const gallery: GalleryItem[] =
        gallerySrc.length > 0
          ? gallerySrc.map(toGalleryItem)
          : [toGalleryItem(file)];
      let index = gallery.findIndex((g) => g.id === file.id);
      if (index < 0) {
        gallery.unshift(toGalleryItem(file));
        index = 0;
      }
      navigation.navigate("FilePreview", {
        title: file.name,
        uri,
        mime,
        mode: "video",
        fileId: file.id,
        gallery,
        index,
      });
      return;
    }

    if (navigation && isAudioFile(file)) {
      navigation.navigate("FilePreview", {
        title: file.name,
        uri,
        mime,
        mode: "audio",
        fileId: file.id,
      });
      return;
    }

    if (navigation && isSpreadsheetFile(file.name, mime)) {
      navigation.navigate("FilePreview", {
        title: file.name,
        uri,
        mime,
        mode: "sheet",
        fileId: file.id,
      });
      return;
    }

    if (navigation && wantsText) {
      const text = new TextDecoder().decode(bytes);
      navigation.navigate("FilePreview", {
        title: file.name,
        uri,
        mime,
        mode: "text",
        text,
        fileId: file.id,
      });
      return;
    }

    if (navigation && isPdf(mime, file.name)) {
      navigation.navigate("FilePreview", {
        title: file.name,
        uri,
        mime,
        mode: "pdf",
        fileId: file.id,
      });
      return;
    }

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, { mimeType: mime, dialogTitle: file.name });
    } else {
      Alert.alert("Downloaded", `Saved to cache as ${file.name}`);
    }
  } catch (err) {
    Alert.alert("Cannot open file", err instanceof Error ? err.message : String(err));
  }
}

/** Open an already-decrypted persistent local file without contacting the server. */
export async function openLocalFile(
  file: FileItem,
  uri: string,
  mime: string,
  navigation: PreviewNav,
): Promise<void> {
  if (isImage(mime) || isImageFile(file)) {
    navigation.navigate("FilePreview", { title: file.name, uri, mime, mode: "image", fileId: file.id });
    return;
  }
  if (isVideo(mime) || isVideoFile(file)) {
    navigation.navigate("FilePreview", { title: file.name, uri, mime, mode: "video", fileId: file.id });
    return;
  }
  if (isAudioFile(file)) {
    navigation.navigate("FilePreview", { title: file.name, uri, mime, mode: "audio", fileId: file.id });
    return;
  }
  if (isSpreadsheetFile(file.name, mime)) {
    navigation.navigate("FilePreview", { title: file.name, uri, mime, mode: "sheet", fileId: file.id });
    return;
  }
  if (isText(mime, file.name)) {
    const text = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
    navigation.navigate("FilePreview", { title: file.name, uri, mime, mode: "text", text, fileId: file.id });
    return;
  }
  if (isPdf(mime, file.name)) {
    navigation.navigate("FilePreview", { title: file.name, uri, mime, mode: "pdf", fileId: file.id });
    return;
  }
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType: mime, dialogTitle: file.name });
  }
}

/** Decrypt and open the system share sheet (send a copy). */
export async function downloadFileToShare(file: FileItem): Promise<void> {
  try {
    const { uri, mime } = await downloadAndDecrypt(file);
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, { mimeType: mime, dialogTitle: file.name });
    } else {
      Alert.alert("Ready", file.name);
    }
  } catch (err) {
    Alert.alert("Share failed", err instanceof Error ? err.message : String(err));
  }
}

async function requestNotificationPermissionIfNeeded(): Promise<void> {
  if (Platform.OS !== "android" || Platform.Version < 33) return;
  try {
    await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
  } catch {
    // Denial must not block saving the file.
  }
}

/** Decrypt and save into Android's shared Downloads collection. */
export async function downloadFileToDevice(file: FileItem): Promise<void> {
  let notificationId: number | undefined;
  try {
    if (Platform.OS !== "android") {
      const { uri, mime } = await downloadAndDecrypt(file);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: mime, dialogTitle: `Save ${file.name}` });
      } else {
        Alert.alert("Downloaded", file.name);
      }
      return;
    }

    if (!downloadsModule) {
      const { uri, mime } = await downloadAndDecrypt(file);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: mime,
          dialogTitle: `Save ${file.name}`,
        });
        return;
      }
      throw new Error("Android download service is unavailable");
    }

    await requestNotificationPermissionIfNeeded();
    notificationId = await downloadsModule.beginDownload(file.name);

    const { uri, mime } = await downloadAndDecrypt(file, {
      progressNotificationId: notificationId,
    });
    let savedUri: string;
    if (typeof downloadsModule.saveFromPath === "function") {
      savedUri = await downloadsModule.saveFromPath(file.name, mime, uri);
    } else {
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      savedUri = await downloadsModule.saveBase64(file.name, mime, b64);
    }
    await downloadsModule.completeDownload(notificationId, file.name, mime, savedUri);
    notificationId = undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (notificationId != null && downloadsModule) {
      try {
        await downloadsModule.failDownload(notificationId, message);
      } catch {
        // Notification failure must not hide the download error.
      }
    }
    Alert.alert("Download failed", message);
  }
}

export async function copyText(text: string): Promise<void> {
  await Clipboard.setStringAsync(text);
}
