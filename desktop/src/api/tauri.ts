import { invoke } from "@tauri-apps/api/core";
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
} from "../types";

export const api = {
  getAuthState: () => invoke<AuthState>("get_auth_state"),
  login: (server_url: string, email: string, password: string) =>
    invoke<LoginResult>("login", {
      req: { server_url, email, password },
    }),
  register: (
    server_url: string,
    email: string,
    username: string,
    password: string,
    invite_code: string,
  ) => invoke<User>("register", {
    req: { server_url, email, username, password, invite_code },
  }),
  pollLoginApproval: (
    server_url: string,
    challenge_id: string,
    challenge_token: string,
    password: string,
  ) =>
    invoke<LoginResult>("poll_login_approval", {
      req: { server_url, challenge_id, challenge_token, password },
    }),
  verify2FA: (server_url: string, challenge_id: string, code: string, password: string) =>
    invoke<User>("verify_2fa", {
      req: { server_url, challenge_id, code, password },
    }),
  send2FAEmail: (server_url: string, challenge_id: string) =>
    invoke<LoginResult>("send_2fa_email", {
      req: { server_url, challenge_id },
    }),
  logout: () => invoke<void>("logout"),
  getSystemFolders: () => invoke<SystemFolder[]>("get_system_folders"),
  pickFolder: () => invoke<string | null>("pick_folder"),
  saveSyncConfig: (folders: SelectedFolder[]) =>
    invoke<void>("save_sync_config", { req: { folders } }),
  completeOnboarding: () => invoke<void>("complete_onboarding"),
  getSyncStatus: () => invoke<SyncStatus>("get_sync_status"),
  getSyncActivity: () => invoke<ActivityItem[]>("get_sync_activity"),
  getSyncFolders: () => invoke<SyncFolder[]>("get_sync_folders"),
  addSyncFolder: (path: string) => invoke<string>("add_sync_folder", { path }),
  removeSyncFolder: (folder_id: number) =>
    invoke<void>("remove_sync_folder", { folderId: folder_id }),
  openPreferencesWindow: () => invoke<void>("open_preferences_window"),
  quitApp: () => invoke<void>("quit_app"),
  getSyncMode: () => invoke<SyncMode>("get_sync_mode"),
  setSyncMode: (mode: SyncMode) => invoke<void>("set_sync_mode", { mode }),
  getLaunchOnLogin: () => invoke<boolean>("get_launch_on_login"),
  setLaunchOnLogin: (enabled: boolean) =>
    invoke<void>("set_launch_on_login", { enabled }),
  getStartMinimized: () => invoke<boolean>("get_start_minimized"),
  setStartMinimized: (enabled: boolean) =>
    invoke<void>("set_start_minimized", { enabled }),
  getDesktopSyncSettings: () =>
    invoke<DesktopSyncSettings>("get_desktop_sync_settings"),
  setDesktopSyncSettings: (settings: DesktopSyncSettings) =>
    invoke<DesktopSyncSettings>("set_desktop_sync_settings", { settings }),
  getRemoteSyncFolders: () =>
    invoke<RemoteSyncFolder[]>("get_remote_sync_folders"),
  browseDrive: (folder_id?: string) =>
    invoke<DriveContents>("browse_drive", { folderId: folder_id }),
  searchDrive: (query: string) =>
    invoke<DriveSearchResult>("search_drive", { query }),
  createDriveFolder: (name: string, parent_id?: string) =>
    invoke<void>("create_drive_folder", { name, parentId: parent_id }),
  trashDriveItem: (item_type: "file" | "folder", item_id: string) =>
    invoke<void>("trash_drive_item", { itemType: item_type, itemId: item_id }),
  listDriveFolders: () => invoke<DriveFolder[]>("list_drive_folders"),
  updateDriveItem: (
    item_type: "file" | "folder",
    item_id: string,
    changes: { name?: string; parent_id?: string | null; starred?: boolean; move_requested?: boolean },
  ) => invoke<void>("update_drive_item", {
    itemType: item_type,
    itemId: item_id,
    name: changes.name,
    parentId: changes.parent_id,
    moveRequested: changes.move_requested ?? false,
    starred: changes.starred,
  }),
  downloadDriveFile: (file_id: string, file_name: string) =>
    invoke<string>("download_drive_file", { fileId: file_id, fileName: file_name }),
  previewDriveFile: (file_id: string) =>
    invoke<DriveFilePreview>("preview_drive_file", { fileId: file_id }),
  getDriveFileVersions: (file_id: string) =>
    invoke<DriveFileVersion[]>("get_drive_file_versions", { fileId: file_id }),
  restoreDriveFileVersion: (file_id: string, version: number) =>
    invoke<void>("restore_drive_file_version", { fileId: file_id, version }),
  shareDriveItemWithUser: (
    item_type: "file" | "folder",
    item_id: string,
    email: string,
    permission: "read" | "write",
  ) => invoke<DriveShareResult>("share_drive_item_with_user", {
    itemType: item_type, itemId: item_id, email, permission,
  }),
  createDriveShareLink: (item_type: "file" | "folder", item_id: string, password = "") =>
    invoke<DriveShareResult>("create_drive_share_link", {
      itemType: item_type, itemId: item_id, password,
    }),
  getDriveItemShares: (item_type: "file" | "folder", item_id: string) =>
    invoke<DriveItemShares>("get_drive_item_shares", { itemType: item_type, itemId: item_id }),
  updateDriveUserShare: (share_id: string, permission: "read" | "write") =>
    invoke<void>("update_drive_user_share", { shareId: share_id, permission }),
  revokeDriveUserShare: (share_id: string) =>
    invoke<void>("revoke_drive_user_share", { shareId: share_id }),
  revokeDriveShareLink: (link_id: string) =>
    invoke<void>("revoke_drive_share_link", { linkId: link_id }),
  getSyncConflicts: () => invoke<SyncConflict[]>("get_sync_conflicts"),
  resolveSyncConflict: (
    path: string,
    resolution: "keep_local" | "use_cloud" | "keep_both",
  ) => invoke<void>("resolve_sync_conflict", { path, resolution }),
  openSyncLogFolder: () => invoke<void>("open_sync_log_folder"),
  pauseSync: () => invoke<void>("pause_sync"),
  resumeSync: () => invoke<void>("resume_sync"),
  openDriveFolder: () => invoke<void>("open_drive_folder"),
  getExplorerIntegrationStatus: () =>
    invoke<ExplorerIntegrationStatus>("get_explorer_integration_status"),
  getProfile: () => invoke<User>("get_profile"),
  getStorageInfo: () => invoke<StorageInfo>("get_storage_info"),
  getSharedWithMe: () => invoke<SharedItem[]>("get_shared_with_me"),
  openPathInExplorer: (path: string) =>
    invoke<void>("open_path_in_explorer", { path }),
  importEncryptionKeys: (password: string) =>
    invoke<ImportEncryptionKeysResult>("import_encryption_keys", { password }),
  exportEncryptionKeys: (password: string) =>
    invoke<ExportEncryptionKeysResult>("export_encryption_keys", { password }),
  getCryptoStatus: () => invoke<CryptoStatus>("get_crypto_status"),
  unlockCryptoRecovery: (recovery_code: string) =>
    invoke<CryptoSyncStats>("unlock_crypto_recovery", {
      req: { recovery_code },
    }),
  rotateCryptoKey: (password: string) =>
    invoke<RotateCryptoKeyResult>("rotate_crypto_key", {
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
