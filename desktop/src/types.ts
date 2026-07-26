export interface ImportEncryptionKeysResult {
  imported: number;
}

export interface HydrateFailedEvent {
  message: string;
  file_id: string;
}

export interface ExportEncryptionKeysResult {
  exported: number;
  path: string;
}

export interface CryptoStatus {
  unlocked: boolean;
  server_has_crypto: boolean;
  needs_recovery: boolean;
}

export interface CryptoSyncStats {
  pulled: number;
  pushed: number;
  pending_flushed: number;
}

export interface RotateCryptoKeyResult {
  recovery_code: string;
}

export interface ExplorerIntegrationStatus {
  connected: boolean;
  registered: boolean;
  finalized: boolean;
  sync_root_path: string;
  my_drive_path: string;
}

export type AppScreen =
  | "loading"
  | "signin"
  | "welcome"
  | "wizard"
  | "main";

export interface User {
  id: string;
  email: string;
  username: string;
  role: string;
  avatar_url?: string;
}

export interface AuthState {
  logged_in: boolean;
  server_url: string | null;
  user: User | null;
  onboarding_complete: boolean;
}

export type LoginResult =
  | { type: "success"; user: User }
  | {
      type: "two_factor";
      challenge_id: string;
      email_masked: string;
      method?: string;
      methods_available?: string[];
    };

export interface SystemFolder {
  label: string;
  path: string;
  suggested: boolean;
}

export interface SelectedFolder {
  path: string;
  label: string;
  checked?: boolean;
}

export type SyncStatusKind = "up_to_date" | "syncing" | "paused" | "offline" | "error";

export interface SyncStatus {
  status: SyncStatusKind;
  message: string;
  last_synced_at: string | null;
  paused: boolean;
}

export interface SyncProgress {
  phase: "scanning" | "syncing" | "done" | string;
  processed: number;
  total: number;
  uploaded: number;
  skipped: number;
  unchanged: number;
  errors: number;
  current: number;
  current_file: string;
  message: string;
  show_in_ui?: boolean;
}

export interface SyncFolder {
  id: number;
  local_path: string;
  remote_folder_id: string;
  label: string;
}

export type ActivityStatus = "synced" | "uploading" | "error" | "skipped" | "deleted";

export interface ActivityItem {
  id: number;
  name: string;
  detail: string;
  file_size: number;
  status: ActivityStatus | string;
  created_at: string;
  /** 0–1 upload fraction while status is uploading; undefined = indeterminate. */
  progress?: number;
}

export interface UploadProgressEvent {
  name: string;
  bytes_sent: number;
  bytes_total: number;
}

export type SyncMode = "stream" | "mirror";

export type PreferencesTab = "my-computer" | "freedrive";

export type MainView = "home" | "sync" | "notifications";

export interface StorageInfo {
  used_bytes: number;
  total_bytes: number;
  free_bytes?: number;
}

export type NotificationKind =
  | "storage_critical"
  | "storage_warning"
  | "sync_error"
  | "sync_paused"
  | "file_error";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  description: string;
  isNew?: boolean;
  actions?: { label: string; action: string }[];
}

export interface SharedItem {
  share: { id: string; created_at?: string };
  item_type: string;
  item_id: string;
  item_name: string;
  owner_name?: string;
}
