import { gcm } from "@noble/ciphers/aes.js";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { api } from "../api/client";
import type { CryptoAccount } from "../api/types";

const PBKDF2_ITERATIONS = 310_000;
const DEVICE_KEY_STORE = "fd_device_crypto_key";
const DEVICE_UEK_PREFIX = "fd_device_uek_";
const FILE_KEY_PREFIX = "fd_file_key_";

let uekRaw: Uint8Array | null = null;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return globalThis.btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return base64ToBytes(padded);
}

export function base64ToUint8(base64: string): Uint8Array {
  return base64ToBytes(base64);
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < length; i += 1) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

async function deriveKek(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder();
  return pbkdf2(sha256, enc.encode(password), salt, {
    c: PBKDF2_ITERATIONS,
    dkLen: 32,
  });
}

async function wrapRawKey(rawKey: Uint8Array, wrappingKeyBytes: Uint8Array): Promise<string> {
  const iv = randomBytes(12);
  const cipher = gcm(wrappingKeyBytes, iv);
  const ciphertext = cipher.encrypt(rawKey);
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return arrayBufferToBase64Url(combined);
}

async function unwrapRawKey(wrappedB64url: string, wrappingKeyBytes: Uint8Array): Promise<Uint8Array> {
  const combined = base64UrlToBytes(wrappedB64url);
  if (combined.length < 13) throw new Error("Invalid wrapped key");
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const cipher = gcm(wrappingKeyBytes, iv);
  return cipher.decrypt(ciphertext);
}

function saltFromAccount(account: CryptoAccount): Uint8Array | null {
  const salt = account.key_salt;
  if (!salt) return null;
  if (Array.isArray(salt)) return new Uint8Array(salt);
  if (typeof salt === "string") {
    try {
      return base64ToBytes(salt);
    } catch {
      return null;
    }
  }
  return null;
}

async function getOrCreateDeviceKey(): Promise<Uint8Array> {
  const existing = await SecureStore.getItemAsync(DEVICE_KEY_STORE);
  if (existing) return base64UrlToBytes(existing);
  const key = randomBytes(32);
  await SecureStore.setItemAsync(DEVICE_KEY_STORE, arrayBufferToBase64Url(key));
  return key;
}

async function persistDeviceUek(userId: string): Promise<void> {
  if (!userId || !uekRaw) return;
  const deviceKey = await getOrCreateDeviceKey();
  const wrapped = await wrapRawKey(uekRaw, deviceKey);
  await SecureStore.setItemAsync(DEVICE_UEK_PREFIX + userId, wrapped);
}

async function restoreDeviceUek(userId: string): Promise<boolean> {
  if (!userId) return false;
  const wrapped = await SecureStore.getItemAsync(DEVICE_UEK_PREFIX + userId);
  if (!wrapped) return false;
  try {
    const deviceKey = await getOrCreateDeviceKey();
    const restored = await unwrapRawKey(wrapped, deviceKey);
    if (restored.length !== 32) return false;
    uekRaw = restored;
    return true;
  } catch {
    return false;
  }
}

export async function clearDeviceUek(userId: string): Promise<void> {
  if (!userId) return;
  try {
    await SecureStore.deleteItemAsync(DEVICE_UEK_PREFIX + userId);
  } catch {
    /* ignore */
  }
}

export function isUnlocked(): boolean {
  return Boolean(uekRaw && uekRaw.length === 32);
}

export function lockCrypto(): void {
  uekRaw = null;
}

export async function lockAndClearDevice(userId: string | null): Promise<void> {
  lockCrypto();
  if (userId) await clearDeviceUek(userId);
}

async function storeFileKeyB64(fileId: string, keyB64url: string): Promise<void> {
  await AsyncStorage.setItem(FILE_KEY_PREFIX + fileId, keyB64url);
}

async function getStoredFileKeyB64(fileId: string): Promise<string | null> {
  return AsyncStorage.getItem(FILE_KEY_PREFIX + fileId);
}

async function pullKeysFromServer(): Promise<void> {
  if (!isUnlocked() || !uekRaw) return;
  const keys = await api.listEncryptionKeys();
  for (const entry of keys) {
    if (!entry?.file_id || !entry?.wrapped_file_key) continue;
    try {
      const raw = await unwrapRawKey(entry.wrapped_file_key, uekRaw);
      await storeFileKeyB64(entry.file_id, arrayBufferToBase64Url(raw));
    } catch {
      /* skip invalid */
    }
  }
}

export async function unlockWithPassword(password: string, userId: string): Promise<void> {
  const account = await api.getCryptoAccount();
  if (!account?.has_crypto) {
    // No crypto account — nothing to unlock (legacy/plaintext edge case).
    return;
  }
  const salt = saltFromAccount(account);
  if (!salt || !account.wrapped_uek) {
    throw new Error("Encryption account is not configured on the server");
  }
  const kek = await deriveKek(password, salt);
  uekRaw = await unwrapRawKey(account.wrapped_uek, kek);
  await persistDeviceUek(userId);
  // Sync file keys in background — do not block login UI.
  void pullKeysFromServer().catch(() => {});
}

export async function tryRestoreUnlock(userId: string): Promise<boolean> {
  const ok = await restoreDeviceUek(userId);
  if (ok) {
    // Local UEK is enough for boot; key sync must not block the splash screen.
    void pullKeysFromServer().catch(() => {});
  }
  return ok;
}

export async function ensureFileKey(fileId: string): Promise<Uint8Array> {
  const cached = await getStoredFileKeyB64(fileId);
  if (cached) return base64UrlToBytes(cached);

  if (!isUnlocked() || !uekRaw) {
    throw new Error("Sign out and sign in again with your password to restore file access.");
  }

  let data: { wrapped_file_key: string };
  try {
    data = await api.getFileEncryptionKey(fileId);
  } catch {
    throw new Error(
      "This file's encryption key is not on the server yet. Wait for sync from the device that uploaded it.",
    );
  }
  if (!data?.wrapped_file_key) {
    throw new Error(
      "This file's encryption key is not on the server yet. Wait for sync from the device that uploaded it.",
    );
  }
  const raw = await unwrapRawKey(data.wrapped_file_key, uekRaw);
  await storeFileKeyB64(fileId, arrayBufferToBase64Url(raw));
  return raw;
}

export async function decryptFileBytes(
  ciphertext: ArrayBuffer,
  key: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const cipher = gcm(key, iv);
  return cipher.decrypt(new Uint8Array(ciphertext));
}

export async function encryptFileBytes(
  plaintext: Uint8Array,
  key: Uint8Array,
): Promise<{ ciphertext: Uint8Array; ivB64: string }> {
  const iv = randomBytes(12);
  const cipher = gcm(key, iv);
  const ciphertext = cipher.encrypt(plaintext);
  return { ciphertext, ivB64: bytesToBase64(iv) };
}

/** Generate a new file key and wrap it for the server (no plaintext). */
export async function prepareNewFileKey(): Promise<{
  rawKey: Uint8Array;
  wrappedFileKey: string;
}> {
  if (!isUnlocked() || !uekRaw) {
    throw new Error("Sign out and sign in again with your password to upload encrypted files.");
  }
  const rawKey = randomBytes(32);
  const wrappedFileKey = await wrapRawKey(rawKey, uekRaw);
  return { rawKey, wrappedFileKey };
}

/** Generate a new file key, encrypt plaintext, wrap key for the server, cache locally. */
export async function prepareNewEncryptedFile(plaintext: Uint8Array): Promise<{
  ciphertext: Uint8Array;
  ivB64: string;
  rawKey: Uint8Array;
  wrappedFileKey: string;
}> {
  const { rawKey, wrappedFileKey } = await prepareNewFileKey();
  const { ciphertext, ivB64 } = await encryptFileBytes(plaintext, rawKey);
  return { ciphertext, ivB64, rawKey, wrappedFileKey };
}

export async function cacheFileKey(fileId: string, rawKey: Uint8Array): Promise<void> {
  await storeFileKeyB64(fileId, arrayBufferToBase64Url(rawKey));
}

export async function decryptDownloadedFile(fileId: string, ivB64: string, data: ArrayBuffer): Promise<Uint8Array> {
  if (!ivB64) {
    // Unencrypted payload (legacy)
    return new Uint8Array(data);
  }
  const key = await ensureFileKey(fileId);
  const iv = base64ToUint8(ivB64);
  return decryptFileBytes(data, key, iv);
}

/** Standard Base64 for native AES (Android Cipher). */
export function rawKeyToStandardBase64(key: Uint8Array): string {
  return bytesToBase64(key);
}
