import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import type { FileItem } from "../api/types";
import { downloadAndDecrypt } from "../utils/openFile";

const STORAGE_KEY = "fd_offline_files_v1";

export interface OfflineFile {
  file: FileItem;
  uri: string;
  mime: string;
  saved_at: string;
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_") || "file";
}

async function readAll(): Promise<OfflineFile[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(items: OfflineFile[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

export async function listOfflineFiles(): Promise<OfflineFile[]> {
  const items = await readAll();
  const checked = await Promise.all(items.map(async (item) => ({ item, info: await FileSystem.getInfoAsync(item.uri) })));
  const valid = checked.filter(({ info }) => info.exists).map(({ item }) => item);
  if (valid.length !== items.length) await writeAll(valid);
  return valid;
}

export async function isFileOffline(fileId: string): Promise<boolean> {
  return (await listOfflineFiles()).some((entry) => entry.file.id === fileId);
}

export async function saveFileOffline(file: FileItem): Promise<OfflineFile> {
  if (!FileSystem.documentDirectory) {
    throw new Error("Persistent device storage is unavailable.");
  }
  const dir = `${FileSystem.documentDirectory}offline/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const downloaded = await downloadAndDecrypt(file);
  const target = `${dir}${file.id}_${safeName(file.name)}`;
  await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
  await FileSystem.copyAsync({ from: downloaded.uri, to: target });
  const entry: OfflineFile = {
    file,
    uri: target,
    mime: downloaded.mime || file.mime_type || "application/octet-stream",
    saved_at: new Date().toISOString(),
  };
  const items = (await readAll()).filter((current) => current.file.id !== file.id);
  items.unshift(entry);
  await writeAll(items);
  return entry;
}

export async function removeOfflineFile(fileId: string): Promise<void> {
  const items = await readAll();
  const target = items.find((entry) => entry.file.id === fileId);
  if (target) await FileSystem.deleteAsync(target.uri, { idempotent: true }).catch(() => {});
  await writeAll(items.filter((entry) => entry.file.id !== fileId));
}
