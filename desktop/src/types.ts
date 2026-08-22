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
  platform: string;
  native_streaming_supported: boolean;
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
    }
  | {
      type: "login_approval";
      challenge_id: string;
      challenge_token: string;
      expires_at?: string;
      pending_device_name?: string;
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

export type ActivityStatus = "synced" | "uploading" | "error" | "skipped" | "deleted" | "conflict";

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

export type MainView = "home" | "drive" | "sync" | "notifications";

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
  | "file_error"
  | "sync_conflict";

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

export interface DesktopSyncSettings {
  proxy_url: string;
  proxy_username: string;
  proxy_password: string;
  upload_limit_kbps: number;
  download_limit_kbps: number;
  excluded_patterns: string[];
  excluded_remote_folder_ids: string[];
}

export interface RemoteSyncFolder {
  id: string;
  name: string;
  parent_id?: string | null;
  is_trashed?: boolean;
}

export interface DriveFolder {
  id: string;
  name: string;
  parent_id?: string | null;
  is_trashed?: boolean;
  is_starred?: boolean;
}

export interface DriveFile {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  folder_id?: string | null;
  updated_at: string;
  version?: number;
  is_starred?: boolean;
}

export interface DriveContents {
  folder?: DriveFolder | null;
  folders: DriveFolder[];
  files: DriveFile[];
  total_files?: number | null;
}

export interface DriveSearchResult {
  folders: DriveFolder[];
  files: DriveFile[];
  total: number;
  page: number;
}

export interface DriveFileVersion {
  id: string;
  file_id: string;
  version: number;
  size: number;
  created_at: string;
  created_by: string;
}

export interface DriveShareResult {
  id: string;
  url?: string | null;
}

export interface DriveManagedUserShare {
  share: {
    id: string;
    shared_with: string;
    permission: "read" | "write" | string;
    created_at?: string;
  };
  item_type: string;
  item_id: string;
  item_name: string;
}

export interface DriveManagedLink {
  id: string;
  token: string;
  permission: string;
  has_password: boolean;
  expires_at?: string | null;
  max_downloads?: number | null;
  download_count: number;
  is_active: boolean;
  created_at: string;
}

export interface DriveItemShares {
  user_shares: DriveManagedUserShare[];
  links: DriveManagedLink[];
}

export interface SyncConflict {
  path: string;
  original_path: string;
  name: string;
  modified_at?: string | null;
}
