import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ActivityItem,
  AuthState,
  ExplorerIntegrationStatus,
  LoginResult,
  SelectedFolder,
  SharedItem,
  StorageInfo,
  SyncFolder,
  SyncMode,
  SyncProgress,
  SyncStatus,
  SystemFolder,
  User,
  ImportEncryptionKeysResult,
  ExportEncryptionKeysResult,
  CryptoStatus,
  CryptoSyncStats,
  RotateCryptoKeyResult,
  HydrateFailedEvent,
  UploadProgressEvent,
  DesktopSyncSettings,
  RemoteSyncFolder,
  DriveContents,
  DriveSearchResult,
  DriveFileVersion,
  DriveFolder,
  DriveShareResult,
  SyncConflict,
  DriveItemShares,
  DriveFilePreview,
  DriveFile,
  DriveUploadProgressEvent,
} from "../types";

const SESSION_EXPIRED_EVENT = "freedrive:session-expired";
let sessionCleanup: Promise<unknown> | null = null;

function isSessionExpired(error: unknown): boolean {
  return String(error).toLowerCase().includes("session expired");
}

export function expireSession(): void {
  if (!sessionCleanup) {
    sessionCleanup = tauriInvoke<void>("expire_session")
      .catch(() => undefined)
      .finally(() => {
        sessionCleanup = null;
        window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
      });
  }
}

async function invokeApi<T>(command: string, args?: InvokeArgs): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    if (command !== "logout" && isSessionExpired(error)) {
      expireSession();
    }
    throw error;
  }
}

export function onSessionExpired(callback: () => void): () => void {
  const handler = () => callback();
  window.addEventListener(SESSION_EXPIRED_EVENT, handler);
  return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handler);
}

export const api = {
  getAuthState: () => invokeApi<AuthState>("get_auth_state"),
  login: (server_url: string, email: string, password: string) =>
    invokeApi<LoginResult>("login", {
      req: { server_url, email, password },
    }),
  register: (
    server_url: string,
    email: string,
    username: string,
    password: string,
    invite_code: string,
  ) => invokeApi<User>("register", {
    req: { server_url, email, username, password, invite_code },
  }),
  pollLoginApproval: (
    server_url: string,
    challenge_id: string,
    challenge_token: string,
    password: string,
  ) =>
    invokeApi<LoginResult>("poll_login_approval", {
      req: { server_url, challenge_id, challenge_token, password },
    }),
  verify2FA: (server_url: string, challenge_id: string, code: string, password: string) =>
    invokeApi<User>("verify_2fa", {
      req: { server_url, challenge_id, code, password },
    }),
  send2FAEmail: (server_url: string, challenge_id: string) =>
    invokeApi<LoginResult>("send_2fa_email", {
      req: { server_url, challenge_id },
    }),
  logout: () => invokeApi<void>("logout"),
  getSystemFolders: () => invokeApi<SystemFolder[]>("get_system_folders"),
  pickFolder: () => invokeApi<string | null>("pick_folder"),
  saveSyncConfig: (folders: SelectedFolder[]) =>
    invokeApi<void>("save_sync_config", { req: { folders } }),
  completeOnboarding: () => invokeApi<void>("complete_onboarding"),
  getSyncStatus: () => invokeApi<SyncStatus>("get_sync_status"),
  getSyncActivity: () => invokeApi<ActivityItem[]>("get_sync_activity"),
  getSyncFolders: () => invokeApi<SyncFolder[]>("get_sync_folders"),
  addSyncFolder: (path: string) => invokeApi<string>("add_sync_folder", { path }),
  removeSyncFolder: (folder_id: number) =>
    invokeApi<void>("remove_sync_folder", { folderId: folder_id }),
  openPreferencesWindow: () => invokeApi<void>("open_preferences_window"),
  quitApp: () => invokeApi<void>("quit_app"),
  getSyncMode: () => invokeApi<SyncMode>("get_sync_mode"),
  setSyncMode: (mode: SyncMode) => invokeApi<void>("set_sync_mode", { mode }),
  getLaunchOnLogin: () => invokeApi<boolean>("get_launch_on_login"),
  setLaunchOnLogin: (enabled: boolean) =>
    invokeApi<void>("set_launch_on_login", { enabled }),
  getStartMinimized: () => invokeApi<boolean>("get_start_minimized"),
  setStartMinimized: (enabled: boolean) =>
    invokeApi<void>("set_start_minimized", { enabled }),
  getDesktopSyncSettings: () =>
    invokeApi<DesktopSyncSettings>("get_desktop_sync_settings"),
  setDesktopSyncSettings: (settings: DesktopSyncSettings) =>
    invokeApi<DesktopSyncSettings>("set_desktop_sync_settings", { settings }),
  getRemoteSyncFolders: () =>
    invokeApi<RemoteSyncFolder[]>("get_remote_sync_folders"),
  browseDrive: (folder_id?: string) =>
    invokeApi<DriveContents>("browse_drive", { folderId: folder_id }),
  searchDrive: (query: string) =>
    invokeApi<DriveSearchResult>("search_drive", { query }),
  getDriveCollection: (kind: "recent" | "starred" | "trash") =>
    invokeApi<DriveContents>("get_drive_collection", { kind }),
  restoreDriveItem: (item_type: "file" | "folder", item_id: string) =>
    invokeApi<void>("restore_drive_item", { itemType: item_type, itemId: item_id }),
  permanentlyDeleteDriveItem: (item_type: "file" | "folder", item_id: string) =>
    invokeApi<void>("permanently_delete_drive_item", { itemType: item_type, itemId: item_id }),
  emptyDriveTrash: () => invokeApi<void>("empty_drive_trash"),
  createDriveFolder: (name: string, parent_id?: string) =>
    invokeApi<void>("create_drive_folder", { name, parentId: parent_id }),
  uploadDriveFiles: (folder_id?: string) =>
    invokeApi<DriveFile[]>("upload_drive_files", { folderId: folder_id }),
  trashDriveItem: (item_type: "file" | "folder", item_id: string) =>
    invokeApi<void>("trash_drive_item", { itemType: item_type, itemId: item_id }),
  listDriveFolders: () => invokeApi<DriveFolder[]>("list_drive_folders"),
  updateDriveItem: (
    item_type: "file" | "folder",
    item_id: string,
    changes: { name?: string; parent_id?: string | null; starred?: boolean; move_requested?: boolean },
  ) => invokeApi<void>("update_drive_item", {
    itemType: item_type,
    itemId: item_id,
    name: changes.name,
    parentId: changes.parent_id,
    moveRequested: changes.move_requested ?? false,
    starred: changes.starred,
  }),
  downloadDriveFile: (file_id: string, file_name: string) =>
    invokeApi<string>("download_drive_file", { fileId: file_id, fileName: file_name }),
  previewDriveFile: (file_id: string) =>
    invokeApi<DriveFilePreview>("preview_drive_file", { fileId: file_id }),
  getDriveFileVersions: (file_id: string) =>
    invokeApi<DriveFileVersion[]>("get_drive_file_versions", { fileId: file_id }),
  restoreDriveFileVersion: (file_id: string, version: number) =>
    invokeApi<void>("restore_drive_file_version", { fileId: file_id, version }),
  shareDriveItemWithUser: (
    item_type: "file" | "folder",
    item_id: string,
    email: string,
    permission: "read" | "write",
  ) => invokeApi<DriveShareResult>("share_drive_item_with_user", {
    itemType: item_type, itemId: item_id, email, permission,
  }),
  createDriveShareLink: (item_type: "file" | "folder", item_id: string, password = "") =>
    invokeApi<DriveShareResult>("create_drive_share_link", {
      itemType: item_type, itemId: item_id, password,
    }),
  getDriveItemShares: (item_type: "file" | "folder", item_id: string) =>
    invokeApi<DriveItemShares>("get_drive_item_shares", { itemType: item_type, itemId: item_id }),
  updateDriveUserShare: (share_id: string, permission: "read" | "write") =>
    invokeApi<void>("update_drive_user_share", { shareId: share_id, permission }),
  revokeDriveUserShare: (share_id: string) =>
    invokeApi<void>("revoke_drive_user_share", { shareId: share_id }),
  revokeDriveShareLink: (link_id: string) =>
    invokeApi<void>("revoke_drive_share_link", { linkId: link_id }),
  getSyncConflicts: () => invokeApi<SyncConflict[]>("get_sync_conflicts"),
  resolveSyncConflict: (
    path: string,
    resolution: "keep_local" | "use_cloud" | "keep_both",
  ) => invokeApi<void>("resolve_sync_conflict", { path, resolution }),
  openSyncLogFolder: () => invokeApi<void>("open_sync_log_folder"),
  pauseSync: () => invokeApi<void>("pause_sync"),
  resumeSync: () => invokeApi<void>("resume_sync"),
  openDriveFolder: () => invokeApi<void>("open_drive_folder"),
  getExplorerIntegrationStatus: () =>
    invokeApi<ExplorerIntegrationStatus>("get_explorer_integration_status"),
  getProfile: () => invokeApi<User>("get_profile"),
  getStorageInfo: () => invokeApi<StorageInfo>("get_storage_info"),
  getSharedWithMe: () => invokeApi<SharedItem[]>("get_shared_with_me"),
  openPathInExplorer: (path: string) =>
    invokeApi<void>("open_path_in_explorer", { path }),
  importEncryptionKeys: (password: string) =>
    invokeApi<ImportEncryptionKeysResult>("import_encryption_keys", { password }),
  exportEncryptionKeys: (password: string) =>
    invokeApi<ExportEncryptionKeysResult>("export_encryption_keys", { password }),
  getCryptoStatus: () => invokeApi<CryptoStatus>("get_crypto_status"),
  unlockCryptoRecovery: (recovery_code: string) =>
    invokeApi<CryptoSyncStats>("unlock_crypto_recovery", {
      req: { recovery_code },
    }),
  rotateCryptoKey: (password: string) =>
    invokeApi<RotateCryptoKeyResult>("rotate_crypto_key", {
      req: { password },
    }),
};

export function onSyncStatusChanged(cb: (status: SyncStatus) => void) {
  return listen<SyncStatus>("sync-status-changed", (e) => cb(e.payload));
}

export function onSyncActivity(cb: (item: Partial<ActivityItem>) => void) {
  return listen<Partial<ActivityItem>>("sync-activity", (e) => cb(e.payload));
}

export function onSyncProgress(cb: (progress: SyncProgress) => void) {
  return listen<SyncProgress>("sync-progress", (e) => cb(e.payload));
}

export function onUploadProgress(cb: (progress: UploadProgressEvent) => void) {
  return listen<UploadProgressEvent>("upload-progress", (e) => cb(e.payload));
}

export function onDriveUploadProgress(cb: (progress: DriveUploadProgressEvent) => void) {
  return listen<DriveUploadProgressEvent>("drive-upload-progress", (e) => cb(e.payload));
}

export function onMyDriveHydrateFailed(cb: (event: HydrateFailedEvent) => void) {
  return listen<HydrateFailedEvent>("my-drive-hydrate-failed", (e) => cb(e.payload));
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function onCryptoRecoverySetup(cb: (code: string) => void) {
  return listen<string>("crypto-recovery-setup", (e) => cb(e.payload));
}

export function onCryptoKeysSynced(cb: (stats: CryptoSyncStats) => void) {
  return listen<CryptoSyncStats>("crypto-keys-synced", (e) => cb(e.payload));
}

export function onCryptoKeyQueued(cb: (message: string) => void) {
  return listen<string>("crypto-key-queued", (e) => cb(e.payload));
}

export function onCryptoUnlocked(cb: () => void) {
  return listen<void>("crypto-unlocked", () => cb());
}

export function onCryptoUnlockFailed(cb: (message: string) => void) {
  return listen<string>("crypto-unlock-failed", (e) => cb(e.payload));
}

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "less than a minute ago";
  if (mins < 60) return `${mins} minute${mins > 1 ? "s" : ""} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  return new Date(iso).toLocaleDateString();
}
