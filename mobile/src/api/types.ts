export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface User {
  id: string;
  email: string;
  username: string;
  role: string;
  quota_bytes: number;
  used_bytes: number;
  avatar_url?: string;
  suspended: boolean;
  email_2fa_enabled: boolean;
  totp_enabled?: boolean;
  totp_enrolled_at?: string;
  login_approval_enabled?: boolean;
  two_factor_required?: boolean;
  created_at: string;
  updated_at: string;
  last_login_at?: string;
}

export interface AuthSession {
  id: string;
  device_name: string;
  device_type: string;
  ip_address: string;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

export interface TOTPSetup {
  secret: string;
  otpauth_url: string;
  qr: string;
}

export interface TOTPConfirmation {
  backup_codes: string[];
}

/** Authoritative quota/usage from GET /me/storage (reconciled from files). */
export interface StorageInfo {
  used_bytes: number;
  total_bytes: number;
  free_bytes?: number;
}

export interface LoginSuccess {
  tokens: TokenPair;
  user: User;
}

export interface Login2FAChallenge {
  requires_2fa: true;
  challenge_id: string;
  email_masked: string;
  method?: string;
  methods_available?: string[];
}

export interface LoginApprovalChallenge {
  requires_login_approval: true;
  challenge_id: string;
  challenge_token: string;
  expires_at?: string;
  pending_device_name?: string;
}

export type LoginResult = LoginSuccess | Login2FAChallenge | LoginApprovalChallenge;

export function is2FAChallenge(result: LoginResult): result is Login2FAChallenge {
  return "requires_2fa" in result && result.requires_2fa === true;
}

export function isLoginApprovalChallenge(result: LoginResult): result is LoginApprovalChallenge {
  return "requires_login_approval" in result && result.requires_login_approval === true;
}

export interface LoginApprovalDetails {
  id: string;
  status: string;
  pending_device_name: string;
  pending_device_type?: string;
  ip_address?: string;
  expires_at?: string;
  created_at?: string;
}

export type LoginApprovalPendingItem = LoginApprovalDetails;

export interface FolderItem {
  id: string;
  name: string;
  parent_id?: string | null;
  owner_id: string;
  color?: string;
  is_starred: boolean;
  is_trashed: boolean;
  trashed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface FileItem {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  encrypted_size: number;
  folder_id?: string | null;
  owner_id: string;
  iv: string;
  version: number;
  is_starred: boolean;
  is_trashed: boolean;
  trashed_at?: string | null;
  created_at: string;
  updated_at: string;
  accessed_at?: string;
}

export interface FolderContents {
  folder: FolderItem | null;
  folders: FolderItem[];
  files: FileItem[];
  next_page_token?: string;
  total_files?: number;
}

export interface Computer {
  id: string;
  owner_id: string;
  name: string;
  hostname?: string;
  root_folder_id: string;
  last_seen_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface BreadcrumbItem {
  id: string;
  name: string;
}

export interface FilesListResponse {
  files: FileItem[] | null;
  total: number;
  page: number;
}

export interface SharedItem {
  share: {
    id: string;
    file_id?: string | null;
    folder_id?: string | null;
    shared_by: string;
    shared_with: string;
    permission: string;
    created_at: string;
  };
  item_type: "file" | "folder" | string;
  item_id: string;
  item_name: string;
  owner_id?: string;
  owner_name?: string;
  owner_email?: string;
}

export interface ActivityLog {
  id: string;
  user_id: string;
  username?: string;
  action: string;
  target_type: string;
  target_id: string;
  target_name?: string;
  metadata?: string;
  created_at: string;
}

export interface ShareLink {
  id: string;
  file_id?: string | null;
  folder_id?: string | null;
  created_by: string;
  token: string;
  permission: string;
  has_password: boolean;
  expires_at?: string | null;
  max_downloads?: number | null;
  download_count: number;
  is_active: boolean;
  created_at: string;
}

export interface UserShare {
  id: string;
  file_id?: string | null;
  folder_id?: string | null;
  shared_by: string;
  shared_with: string;
  permission: string;
  created_at: string;
}

export interface FileComment {
  id: string;
  file_id: string;
  user_id: string;
  username?: string;
  content: string;
  parent_id?: string | null;
  assigned_to?: string | null;
  assigned_to_username?: string;
  created_at: string;
  updated_at: string;
}

export interface FileVersion {
  id: string;
  file_id: string;
  version: number;
  size: number;
  iv: string;
  created_at: string;
  created_by: string;
}

export interface FileApproval {
  id: string;
  file_id: string;
  requested_by: string;
  approver_id: string;
  status: "pending" | "approved" | "rejected" | string;
  created_at: string;
}

export interface CryptoAccount {
  has_crypto: boolean;
  has_recovery?: boolean;
  key_salt?: number[] | string;
  wrapped_uek?: string;
  wrapped_uek_recovery?: string;
}

export interface EncryptionKeyEntry {
  file_id: string;
  wrapped_file_key: string;
  updated_at?: string;
}

export type ViewMode = "list" | "grid";
export type SortKey = "name" | "updated_at";
export type SortDir = "asc" | "desc";
