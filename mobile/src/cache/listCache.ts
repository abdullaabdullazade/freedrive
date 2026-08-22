import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Computer, FileItem, FolderItem } from "../api/types";

const PREFIX = "fd_cache_";

export const LIST_CACHE_KEYS = {
  homeSuggested: `${PREFIX}home_suggested`,
  folderRoot: `${PREFIX}folder_root`,
  computers: `${PREFIX}computers`,
  folder: (id: string) => `${PREFIX}folder_${id}`,
} as const;

export type HomeSuggestedCache = { files: FileItem[] };

export type FolderContentsCache = {
  folders: FolderItem[];
  files: FileItem[];
  folderName?: string;
};

export type ComputersCache = { computers: Computer[] };

export async function readListCache<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeListCache<T>(key: string, data: T): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

export async function clearListCaches(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const listKeys = keys.filter((k) => k.startsWith(PREFIX));
    if (listKeys.length) await AsyncStorage.multiRemove(listKeys);
  } catch {
    /* ignore */
  }
}
