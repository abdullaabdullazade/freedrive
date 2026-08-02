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
} from "../types";

export const api = {
  getAuthState: () => invoke<AuthState>("get_auth_state"),
  login: (server_url: string, email: string, password: string) =>
    invoke<LoginResult>("login", {
      req: { server_url, email, password },
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
  openSyncLogFolder: () => invoke<void>("open_sync_log_folder"),
  pauseSync: () => invoke<void>("pause_sync"),
  resumeSync: () => invoke<void>("resume_sync"),
  openDriveFolder: () => invoke<void>("open_drive_folder"),
  getExplorerIntegrationStatus: () =>
    invoke<ExplorerIntegrationStatus>("get_explorer_integration_status"),
  getProfile: () => invoke<User>("get_profile"),
  getStorageInfo: () => invoke<StorageInfo>("get_storage_info"),
  getSharedWithMe: () => invoke<SharedItem[]>("get_shared_with_me"),
  openServerUrl: (path?: string) => invoke<void>("open_server_url", { path }),
  openProjectUrl: () => invoke<void>("open_project_url"),
  openPathInExplorer: (path: string) =>
    invoke<void>("open_path_in_explorer", { path }),
  importEncryptionKeys: () =>
    invoke<ImportEncryptionKeysResult>("import_encryption_keys"),
  exportEncryptionKeys: () =>
    invoke<ExportEncryptionKeysResult>("export_encryption_keys"),
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
