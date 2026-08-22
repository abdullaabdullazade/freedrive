import * as Device from "expo-device";
import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { NativeModules, Platform } from "react-native";
import {
  clearSession,
  getServerUrl,
  getTokens,
  setTokens,
} from "../auth/storage";
import type {
  ActivityLog,
  Computer,
  CryptoAccount,
  EncryptionKeyEntry,
  FileApproval,
  FileComment,
  FileItem,
  FileVersion,
  FilesListResponse,
  FolderContents,
  FolderItem,
  LoginResult,
  LoginSuccess,
  Login2FAChallenge,
  LoginApprovalDetails,
  LoginApprovalPendingItem,
  SharedItem,
  ShareLink,
  SortDir,
  SortKey,
  StorageInfo,
  TokenPair,
  User,
  UserShare,
} from "./types";

type NativeDownloadModule = {
  downloadToFile(
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
  readFileSliceBase64?(path: string, offset: number, length: number): Promise<string>;
};

function nativeDownloads(): NativeDownloadModule | undefined {
  if (Platform.OS !== "android") return undefined;
  const mod = NativeModules.FreeDriveDownloads as NativeDownloadModule | undefined;
  if (!mod || typeof mod.downloadToFile !== "function") return undefined;
  return mod;
}

function nativeReadSlice():
  | NonNullable<NativeDownloadModule["readFileSliceBase64"]>
  | undefined {
  if (Platform.OS !== "android") return undefined;
  const mod = NativeModules.FreeDriveDownloads as NativeDownloadModule | undefined;
  if (!mod || typeof mod.readFileSliceBase64 !== "function") return undefined;
  return mod.readFileSliceBase64.bind(mod);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type AuthListener = () => void;
let onUnauthorized: AuthListener | null = null;

export function setUnauthorizedHandler(handler: AuthListener | null) {
  onUnauthorized = handler;
}

const DEVICE_ID_KEY = "fd_device_id";
let cachedDeviceId: string | null = null;

function deviceName(): string {
  const model = Device.modelName || Device.deviceName || "Phone";
  return `Mobile (${model})`;
}

function newDeviceId(): string {
  // React Native / Expo may not expose crypto.randomUUID on all runtimes.
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `mob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = newDeviceId();
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  cachedDeviceId = id;
  return id;
}

async function deviceHeaders(): Promise<Record<string, string>> {
  return {
    "X-Device-Type": "mobile",
    "X-Device-Name": deviceName(),
    "X-Device-ID": await getDeviceId(),
  };
}

async function baseUrl(): Promise<string> {
  const url = await getServerUrl();
  if (!url) throw new ApiError("Server URL is not configured", 0);
  return url.replace(/\/$/, "");
}

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (data?.error) return String(data.error);
  } catch {
    /* ignore */
  }
  return `Request failed (${res.status})`;
}

const GET_TIMEOUT_MS = 45_000;
const MUTATION_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 20_000;

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  // Expo WinterCG fetch wraps aborts as FetchError: "fetch failed: Fetch request has been canceled"
  const msg = err.message.toLowerCase();
  return msg.includes("cancel") || msg.includes("abort");
}

async function fetchWithTimeout(
  input: string,
  init?: RequestInit,
  timeoutMs = GET_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (isAbortError(err)) {
      throw new ApiError("Request timed out — check your connection", 0);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

type RefreshResult = "ok" | "invalid" | "transient";

let refreshInFlight: Promise<RefreshResult> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryRefreshOnce(): Promise<RefreshResult> {
  const tokens = await getTokens();
  if (!tokens?.refresh_token) return "invalid";
  const url = await baseUrl();
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${url}/api/v1/auth/refresh`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await deviceHeaders()),
        },
        body: JSON.stringify({ refresh_token: tokens.refresh_token }),
      },
      REFRESH_TIMEOUT_MS,
    );
  } catch {
    return "transient";
  }
  if (res.status === 401 || res.status === 403) return "invalid";
  if (!res.ok) return "transient";
  try {
    const data = (await res.json()) as { tokens: TokenPair };
    if (!data?.tokens?.access_token) return "invalid";
    await setTokens(data.tokens);
    return "ok";
  } catch {
    return "transient";
  }
}

async function tryRefresh(): Promise<RefreshResult> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const first = await tryRefreshOnce();
      if (first === "ok" || first === "invalid") return first;
      await sleep(1000);
      return await tryRefreshOnce();
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { auth?: boolean; retry?: boolean },
): Promise<T> {
  const auth = opts?.auth !== false;
  const retry = opts?.retry !== false;
  const url = await baseUrl();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(await deviceHeaders()),
  };
  if (auth) {
    const tokens = await getTokens();
    if (tokens?.access_token) {
      headers.Authorization = `Bearer ${tokens.access_token}`;
    }
  }

  const timeoutMs =
    method === "GET" || method === "HEAD" ? GET_TIMEOUT_MS : MUTATION_TIMEOUT_MS;

  const res = await fetchWithTimeout(
    `${url}/api/v1${path}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    timeoutMs,
  );

  if (res.status === 401 && auth && retry) {
    const refreshed = await tryRefresh();
    if (refreshed === "ok") {
      return request<T>(method, path, body, { auth, retry: false });
    }
    if (refreshed === "transient") {
      throw new ApiError("Request timed out — check your connection", 0);
    }
    await clearSession();
    onUnauthorized?.();
    throw new ApiError("Session expired", 401);
  }

  if (!res.ok) {
    throw new ApiError(await parseError(res), res.status);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Native multipart upload — avoids Hermes Blob / FormDataPart limitations. */
async function multipartUploadFromFile(
  path: string,
  fileUri: string,
  parameters: Record<string, string>,
  retry = true,
): Promise<FileItem> {
  const url = await baseUrl();
  const headers: Record<string, string> = { ...(await deviceHeaders()) };
  const tokens = await getTokens();
  if (tokens?.access_token) {
    headers.Authorization = `Bearer ${tokens.access_token}`;
  }

  const result = await FileSystem.uploadAsync(`${url}/api/v1${path}`, fileUri, {
    httpMethod: "POST",
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: "file",
    mimeType: "application/octet-stream",
    parameters,
    headers,
    sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
  });

  if (result.status === 401 && retry) {
    const refreshed = await tryRefresh();
    if (refreshed === "ok") {
      return multipartUploadFromFile(path, fileUri, parameters, false);
    }
    if (refreshed === "transient") {
      throw new ApiError("Request timed out — check your connection", 0);
    }
    await clearSession();
    onUnauthorized?.();
    throw new ApiError("Session expired", 401);
  }

  if (result.status < 200 || result.status >= 300) {
    let message = `Upload failed (${result.status})`;
    try {
      const data = JSON.parse(result.body) as { error?: string };
      if (data?.error) message = String(data.error);
    } catch {
      if (result.body) message = result.body.slice(0, 200);
    }
    throw new ApiError(message, result.status);
  }

  try {
    return JSON.parse(result.body) as FileItem;
  } catch {
    throw new ApiError("Invalid upload response", result.status);
  }
}

const RESUMABLE_THRESHOLD = 32 * 1024 * 1024;
const RESUMABLE_CHUNK = 8 * 1024 * 1024;

function base64ToBytesLocal(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function resumableUploadFromFile(opts: {
  encryptedUri: string;
  name: string;
  mimeType: string;
  iv: string;
  originalSize: number;
  folderId?: string | null;
  fileId?: string;
}): Promise<FileItem> {
  const info = await FileSystem.getInfoAsync(opts.encryptedUri);
  const size = info.exists && "size" in info ? Number(info.size || 0) : 0;

  const parameters: Record<string, string> = {
    name: opts.name,
    mime_type: opts.mimeType,
    iv: opts.iv,
    original_size: String(opts.originalSize),
  };
  if (opts.folderId) parameters.folder_id = opts.folderId;

  if (size > 0 && size <= RESUMABLE_THRESHOLD) {
    if (opts.fileId) {
      return multipartUploadFromFile(`/files/${opts.fileId}/content`, opts.encryptedUri, parameters);
    }
    return multipartUploadFromFile("/files/upload", opts.encryptedUri, parameters);
  }

  const encryptedSize = size;
  if (encryptedSize <= 0) {
    // Unknown size — try multipart (native uploadAsync streams from disk).
    if (opts.fileId) {
      return multipartUploadFromFile(`/files/${opts.fileId}/content`, opts.encryptedUri, parameters);
    }
    return multipartUploadFromFile("/files/upload", opts.encryptedUri, parameters);
  }

  const readSlice = nativeReadSlice();
  if (!readSlice) {
    throw new ApiError(
      "Large file upload requires the native Android build. Reinstall the FreeDrive APK.",
      0,
    );
  }

  const sessionBody: Record<string, unknown> = {
    name: opts.name,
    mime_type: opts.mimeType,
    iv: opts.iv,
    original_size: opts.originalSize,
    encrypted_size: encryptedSize,
  };
  if (opts.folderId) sessionBody.folder_id = opts.folderId;
  if (opts.fileId) sessionBody.file_id = opts.fileId;

  const session = await request<{ id: string }>("POST", "/uploads/sessions", sessionBody);
  let offset = 0;
  let last: FileItem | { complete?: boolean; id?: string } | null = null;
  const url = await baseUrl();
  const filePath = opts.encryptedUri;

  while (offset < encryptedSize) {
    const end = Math.min(offset + RESUMABLE_CHUNK, encryptedSize) - 1;
    const chunkLen = end - offset + 1;
    const b64 = await readSlice(filePath, offset, chunkLen);
    const chunk = base64ToBytesLocal(b64);
    const headers: Record<string, string> = {
      ...(await deviceHeaders()),
      "Content-Type": "application/octet-stream",
      "Content-Range": `bytes ${offset}-${end}/${encryptedSize}`,
    };
    const tokens = await getTokens();
    if (tokens?.access_token) {
      headers.Authorization = `Bearer ${tokens.access_token}`;
    }

    const res = await fetch(`${url}/api/v1/uploads/sessions/${session.id}`, {
      method: "PUT",
      headers,
      body: chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer,
    });
    if (!res.ok) {
      throw new ApiError(await parseError(res), res.status);
    }
    last = (await res.json()) as FileItem;
    offset = end + 1;
  }

  if (!last || !("name" in last)) {
    throw new ApiError("Invalid resumable upload response", 500);
  }
  return last as FileItem;
}

export const api = {
  login: async (email: string, password: string) => {
    return request<LoginResult>("POST", "/auth/login", { email, password }, { auth: false });
  },

  verify2FA: async (challenge_id: string, code: string) => {
    return request<LoginSuccess>(
      "POST",
      "/auth/verify-2fa",
      { challenge_id, code },
      { auth: false },
    );
  },

  send2FAEmail: async (challenge_id: string) => {
    return request<Login2FAChallenge>(
      "POST",
      "/auth/2fa/send-email",
      { challenge_id },
      { auth: false },
    );
  },

  logout: async () => {
    const tokens = await getTokens();
    if (!tokens?.refresh_token) return;
    try {
      await request("POST", "/auth/logout", { refresh_token: tokens.refresh_token }, { retry: false });
    } catch {
      /* ignore logout errors */
    }
  },

  registerPushToken: (expo_push_token: string, platform = "android") =>
    request("POST", "/me/push-token", { expo_push_token, platform }),

  unregisterPushToken: async (expo_push_token?: string) => {
    try {
      await request("DELETE", "/me/push-token", { expo_push_token: expo_push_token || "" });
    } catch {
      /* ignore */
    }
  },

  getLoginApproval: (id: string) =>
    request<LoginApprovalDetails>("GET", `/auth/login-approval/${id}/details`),

  listPendingLoginApprovals: async () => {
    const data = await request<{ approvals?: LoginApprovalPendingItem[] | null }>(
      "GET",
      "/me/login-approvals/pending",
    );
    return data.approvals ?? [];
  },

  approveLoginApproval: (id: string) =>
    request("POST", `/auth/login-approval/${id}/approve`),

  denyLoginApproval: (id: string) =>
    request("POST", `/auth/login-approval/${id}/deny`),

  me: () => request<User>("GET", "/me"),
  myStorage: () => request<StorageInfo>("GET", "/me/storage"),

  folderRoot: async (opts?: { page_size?: number; page_token?: string }) => {
    const q = new URLSearchParams();
    if (opts?.page_size) q.set("page_size", String(opts.page_size));
    if (opts?.page_token) q.set("page_token", opts.page_token);
    const qs = q.toString();
    const data = await request<FolderContents>("GET", `/folders/root${qs ? `?${qs}` : ""}`);
    return {
      folder: data.folder ?? null,
      folders: data.folders ?? [],
      files: data.files ?? [],
      next_page_token: data.next_page_token || "",
      total_files: data.total_files ?? 0,
    } satisfies FolderContents;
  },

  folder: async (id: string, opts?: { page_size?: number; page_token?: string }) => {
    const q = new URLSearchParams();
    if (opts?.page_size) q.set("page_size", String(opts.page_size));
    if (opts?.page_token) q.set("page_token", opts.page_token);
    const qs = q.toString();
    const data = await request<FolderContents>("GET", `/folders/${id}${qs ? `?${qs}` : ""}`);
    return {
      folder: data.folder ?? null,
      folders: data.folders ?? [],
      files: data.files ?? [],
      next_page_token: data.next_page_token || "",
      total_files: data.total_files ?? 0,
    } satisfies FolderContents;
  },

  breadcrumb: async (id: string) => {
    const data = await request<{ breadcrumb: { id: string; name: string }[] }>(
      "GET",
      `/folders/${id}/breadcrumb`,
    );
    return data.breadcrumb ?? [];
  },

  computers: async () => {
    const data = await request<{ computers: Computer[] }>("GET", "/computers");
    return data.computers ?? [];
  },

  listFiles: async (params: {
    folder_id?: string;
    search?: string;
    starred?: boolean;
    sort?: SortKey;
    dir?: SortDir;
    page_size?: number;
  }) => {
    const q = new URLSearchParams();
    if (params.folder_id) q.set("folder_id", params.folder_id);
    if (params.search) q.set("search", params.search);
    if (params.starred) q.set("starred", "true");
    if (params.sort) q.set("sort", params.sort);
    if (params.dir) q.set("dir", params.dir);
    q.set("page_size", String(params.page_size ?? 100));
    const data = await request<FilesListResponse>("GET", `/files?${q.toString()}`);
    return {
      files: data.files ?? [],
      total: data.total ?? 0,
      page: data.page ?? 1,
    };
  },

  myActivity: async (pageSize = 50) => {
    const data = await request<{ activities: ActivityLog[] | null; total: number }>(
      "GET",
      `/activity?page_size=${pageSize}`,
    );
    return data.activities ?? [];
  },

  trashedFiles: async () => {
    const data = await request<{ files: FileItem[] | null }>("GET", "/files/trash");
    return data.files ?? [];
  },

  trashedFolders: async () => {
    const data = await request<{ folders: FolderItem[] | null }>("GET", "/folders/trash");
    return data.folders ?? [];
  },

  restoreFile: (id: string) => request<FileItem>("POST", `/files/${id}/restore`),

  permanentlyDeleteFile: (id: string) => request("DELETE", `/files/${id}/permanent`),

  restoreFolder: (id: string) => request<FolderItem>("POST", `/folders/${id}/restore`),

  permanentlyDeleteFolder: (id: string) => request("DELETE", `/folders/${id}/permanent`),

  emptyTrash: () => request("POST", "/trash/empty"),

  listComments: async (fileId: string) => {
    const data = await request<{ comments?: FileComment[] | null }>(
      "GET",
      `/files/${fileId}/comments`,
    );
    return data.comments ?? [];
  },

  createComment: (fileId: string, content: string, assignedToEmail?: string) =>
    request<FileComment>("POST", `/files/${fileId}/comments`, {
      content,
      ...(assignedToEmail ? { assigned_to_email: assignedToEmail } : {}),
    }),

  deleteComment: (fileId: string, commentId: string) =>
    request("DELETE", `/files/${fileId}/comments/${commentId}`),

  listVersions: async (fileId: string) => {
    const data = await request<{ versions?: FileVersion[] | null }>(
      "GET",
      `/files/${fileId}/versions`,
    );
    return data.versions ?? [];
  },

  restoreVersion: (fileId: string, version: number) =>
    request<FileItem>("POST", `/files/${fileId}/versions/${version}/restore`),

  requestApproval: (fileId: string, approverEmail: string) =>
    request<FileApproval>("POST", `/files/${fileId}/approvals`, {
      approver_email: approverEmail,
    }),

  listApprovals: async (status?: string) => {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const data = await request<{ approvals?: FileApproval[] | null }>(
      "GET",
      `/approvals${query}`,
    );
    return data.approvals ?? [];
  },

  updateApproval: (id: string, status: "approved" | "rejected") =>
    request<FileApproval>("PATCH", `/approvals/${id}`, { status }),

  sharedWithMe: async () => {
    const data = await request<SharedItem[] | { shares?: SharedItem[]; items?: SharedItem[] }>(
      "GET",
      "/shares/with-me",
    );
    if (Array.isArray(data)) return data;
    return data.shares ?? data.items ?? [];
  },

  sharedByMe: async () => {
    const data = await request<{ items?: SharedItem[] }>("GET", "/shares/by-me");
    return data.items ?? [];
  },

  createUserShare: (body: {
    file_id?: string;
    folder_id?: string;
    shared_email?: string;
    shared_with?: string;
    permission: string;
  }) => request<UserShare>("POST", "/shares/users", body),

  updateUserShare: (id: string, permission: string) =>
    request<UserShare>("PATCH", `/shares/users/${id}`, { permission }),

  deleteUserShare: (id: string) => request("DELETE", `/shares/users/${id}`),

  listLinks: async () => {
    const data = await request<{ links?: ShareLink[] | null }>("GET", "/shares/links");
    return data.links ?? [];
  },

  createLink: (body: {
    file_id?: string;
    folder_id?: string;
    permission?: string;
    password?: string;
  }) => request<ShareLink>("POST", "/shares/links", body),

  deleteLink: (id: string) => request("DELETE", `/shares/links/${id}`),

  updateFile: (
    id: string,
    body: { name?: string; folder_id?: string | null; is_starred?: boolean },
  ) => request<FileItem>("PATCH", `/files/${id}`, body),

  deleteFile: (id: string) => request("DELETE", `/files/${id}`),

  getFile: (id: string) => request<FileItem>("GET", `/files/${id}`),

  updateFolder: (
    id: string,
    body: {
      name?: string;
      parent_id?: string | null;
      is_starred?: boolean;
      color?: string;
    },
  ) => request<FolderItem>("PATCH", `/folders/${id}`, body),

  deleteFolder: (id: string) => request("DELETE", `/folders/${id}`),

  createFolder: (body: { name: string; parent_id?: string | null; color?: string }) =>
    request<FolderItem>("POST", "/folders", body),

  listAllFolders: async (search?: string) => {
    const q = search ? `?search=${encodeURIComponent(search)}` : "";
    const data = await request<{ folders?: FolderItem[] | null }>("GET", `/folders/all${q}`);
    return data.folders ?? [];
  },

  downloadEncrypted: async (fileId: string): Promise<{
    data: ArrayBuffer;
    iv: string;
    mime: string;
    originalSize: number;
  }> => {
    const doFetch = async (retry: boolean) => {
      const url = await baseUrl();
      const headers: Record<string, string> = { ...(await deviceHeaders()) };
      const tokens = await getTokens();
      if (tokens?.access_token) {
        headers.Authorization = `Bearer ${tokens.access_token}`;
      }
      const res = await fetchWithTimeout(
        `${url}/api/v1/files/${fileId}/download`,
        { headers },
        DOWNLOAD_TIMEOUT_MS,
      );
      if (res.status === 401 && retry) {
        const refreshed = await tryRefresh();
        if (refreshed === "ok") return doFetch(false);
        if (refreshed === "transient") {
          throw new ApiError("Request timed out — check your connection", 0);
        }
        await clearSession();
        onUnauthorized?.();
        throw new ApiError("Session expired", 401);
      }
      if (!res.ok) {
        throw new ApiError(await parseError(res), res.status);
      }
      const buffer = await res.arrayBuffer();
      return {
        data: buffer,
        iv: res.headers.get("X-File-IV") || "",
        mime: res.headers.get("X-File-Mime") || "application/octet-stream",
        originalSize: Number(res.headers.get("X-Original-Size") || 0),
      };
    };
    return doFetch(true);
  },

  /**
   * Download ciphertext straight to a cache file (native I/O — avoids loading
   * multi-GB bodies into the JS heap). Response headers come from the download result.
   * On Android prefers FreeDriveDownloads.downloadToFile (no Expo 60s hang) with optional
   * progress notification updates.
   */
  downloadEncryptedToFile: async (
    fileId: string,
    destPath: string,
    opts?: {
      progressNotificationId?: number;
      fileName?: string;
    },
  ): Promise<{
    uri: string;
    iv: string;
    mime: string;
    originalSize: number;
  }> => {
    const doDownload = async (retry: boolean) => {
      const url = await baseUrl();
      const headers: Record<string, string> = { ...(await deviceHeaders()) };
      const tokens = await getTokens();
      if (tokens?.access_token) {
        headers.Authorization = `Bearer ${tokens.access_token}`;
      }
      await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => {});

      const downloadUrl = `${url}/api/v1/files/${fileId}/download`;
      const native = nativeDownloads();
      let status = 0;
      let uri = destPath;
      let iv = "";
      let mime = "application/octet-stream";
      let originalSize = 0;

      if (native) {
        const result = await native.downloadToFile(
          downloadUrl,
          destPath,
          headers,
          opts?.progressNotificationId ?? -1,
          opts?.fileName || "file",
        );
        status = result.status ?? 0;
        const path = result.path || "";
        uri = path
          ? path.startsWith("file:")
            ? path
            : `file://${path}`
          : destPath;
        iv = result.iv || "";
        mime = result.mime || "application/octet-stream";
        originalSize = Number(result.originalSize || 0);
      } else {
        const result = await FileSystem.downloadAsync(downloadUrl, destPath, { headers });
        status = result.status ?? 0;
        uri = result.uri;
        const hdrs = result.headers || {};
        const header = (name: string) => {
          const lower = name.toLowerCase();
          for (const [k, v] of Object.entries(hdrs)) {
            if (k.toLowerCase() === lower) return String(v);
          }
          return "";
        };
        iv = header("X-File-IV");
        mime = header("X-File-Mime") || "application/octet-stream";
        originalSize = Number(header("X-Original-Size") || 0);
      }

      if (status === 401 && retry) {
        await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => {});
        const refreshed = await tryRefresh();
        if (refreshed === "ok") return doDownload(false);
        if (refreshed === "transient") {
          throw new ApiError("Request timed out — check your connection", 0);
        }
        await clearSession();
        onUnauthorized?.();
        throw new ApiError("Session expired", 401);
      }
      if (status < 200 || status >= 300) {
        await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => {});
        throw new ApiError(`Download failed (${status})`, status);
      }
      return { uri, iv, mime, originalSize };
    };
    return doDownload(true);
  },

  /** Replace encrypted blob for an existing file (POST multipart /files/{id}/content). */
  updateFileContent: async (
    fileId: string,
    opts: {
      name: string;
      mimeType: string;
      iv: string;
      originalSize: number;
      encryptedUri: string;
    },
  ): Promise<FileItem> => {
    return resumableUploadFromFile({
      encryptedUri: opts.encryptedUri,
      name: opts.name,
      mimeType: opts.mimeType,
      iv: opts.iv,
      originalSize: opts.originalSize,
      fileId,
    });
  },

  /** Create a new encrypted file (POST multipart /files/upload). */
  uploadFile: async (opts: {
    name: string;
    mimeType: string;
    iv: string;
    originalSize: number;
    encryptedUri: string;
    folderId?: string | null;
  }): Promise<FileItem> => {
    return resumableUploadFromFile({
      encryptedUri: opts.encryptedUri,
      name: opts.name,
      mimeType: opts.mimeType,
      iv: opts.iv,
      originalSize: opts.originalSize,
      folderId: opts.folderId,
    });
  },

  getCryptoAccount: () => request<CryptoAccount>("GET", "/crypto/account"),

  listEncryptionKeys: async (since?: string) => {
    const q = since ? `?since=${encodeURIComponent(since)}` : "";
    const data = await request<{ keys?: EncryptionKeyEntry[] | null }>(
      "GET",
      `/encryption-keys${q}`,
    );
    return data.keys ?? [];
  },

  getFileEncryptionKey: (fileId: string) =>
    request<{ file_id: string; wrapped_file_key: string }>(
      "GET",
      `/files/${fileId}/encryption-key`,
    ),

  putFileEncryptionKey: (fileId: string, wrapped_file_key: string) =>
    request<{ file_id: string; wrapped_file_key: string }>(
      "PUT",
      `/files/${fileId}/encryption-key`,
      { wrapped_file_key },
    ),
};
