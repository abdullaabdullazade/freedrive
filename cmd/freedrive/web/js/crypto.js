// ========================================
// FreeDrive — WebCrypto Encryption Module
// Zero-Knowledge AES-GCM-256
// ========================================

var CryptoModule = window.CryptoModule = (() => {
    const DB_NAME = 'freedrive_keys';
    const STORE_NAME = 'encryption_keys';
    const DEVICE_STORE = 'device_crypto';
    const DB_VERSION = 2;
    const DEVICE_KEY_ID = 'device_key_v1';
    const ALGO = { name: 'AES-GCM', length: 256 };

    function getSubtleCrypto() {
        const subtle = window.crypto?.subtle;
        if (!subtle) {
            throw new Error('Browser encryption requires HTTPS or localhost. Open FreeDrive over HTTPS, or use http://localhost:8080.');
        }
        return subtle;
    }

    function getCrypto() {
        if (!window.crypto?.getRandomValues) {
            throw new Error('Browser encryption is not available in this browser.');
        }
        return window.crypto;
    }

    function canEncrypt() {
        return Boolean(window.crypto?.subtle && window.crypto?.getRandomValues);
    }

    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
                if (!db.objectStoreNames.contains(DEVICE_STORE)) {
                    db.createObjectStore(DEVICE_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function idbGet(storeName, key) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => reject(req.error);
        });
    }

    async function idbPut(storeName, key, value) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function idbDelete(storeName, key) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readwrite');
            tx.objectStore(storeName).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function getOrCreateDeviceKey() {
        const existing = await idbGet(DEVICE_STORE, DEVICE_KEY_ID);
        if (existing) {
            return new Uint8Array(base64UrlToArrayBuffer(existing));
        }
        const deviceKey = generateRawBytes(32);
        await idbPut(DEVICE_STORE, DEVICE_KEY_ID, arrayBufferToBase64Url(deviceKey.buffer));
        return deviceKey;
    }

    function deviceUekKey(userId) {
        return `uek_${userId}`;
    }

    async function persistDeviceUek(userId, uekBytes) {
        if (!userId || !uekBytes || uekBytes.length !== 32) return;
        const deviceKey = await getOrCreateDeviceKey();
        const wrapped = await wrapRawKey(uekBytes, deviceKey);
        await idbPut(DEVICE_STORE, deviceUekKey(userId), wrapped);
    }

    async function restoreDeviceUek(userId) {
        if (!userId) return null;
        const wrapped = await idbGet(DEVICE_STORE, deviceUekKey(userId));
        if (!wrapped) return null;
        const deviceKey = await getOrCreateDeviceKey();
        return await unwrapRawKey(wrapped, deviceKey);
    }

    async function clearDeviceUek(userId) {
        if (!userId) return;
        await idbDelete(DEVICE_STORE, deviceUekKey(userId));
    }

    // Generate a new AES-GCM-256 key
    async function generateKey() {
        return await getSubtleCrypto().generateKey(
            ALGO,
            true, // extractable
            ['encrypt', 'decrypt']
        );
    }

    // Export key to base64url string
    async function exportKey(key) {
        const raw = await getSubtleCrypto().exportKey('raw', key);
        return arrayBufferToBase64Url(raw);
    }

    // Import key from base64url string
    async function importKey(base64url) {
        const raw = base64UrlToArrayBuffer(base64url);
        return await getSubtleCrypto().importKey(
            'raw',
            raw,
            ALGO,
            true,
            ['encrypt', 'decrypt']
        );
    }

    // Encrypt a file (ArrayBuffer)
    async function encryptFile(data, key) {
        const iv = getCrypto().getRandomValues(new Uint8Array(12)); // 96-bit IV
        const ciphertext = await getSubtleCrypto().encrypt(
            { name: 'AES-GCM', iv },
            key,
            data
        );
        return { ciphertext, iv };
    }

    // Decrypt a file (ArrayBuffer)
    async function decryptFile(ciphertext, key, iv) {
        return await getSubtleCrypto().decrypt(
            { name: 'AES-GCM', iv },
            key,
            ciphertext
        );
    }

    // Store key in IndexedDB
    async function storeKey(fileId, key) {
        const exported = await exportKey(key);
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(exported, fileId);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // Retrieve key from IndexedDB
    async function getKey(fileId) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(fileId);
            req.onsuccess = async () => {
                if (req.result) {
                    const key = await importKey(req.result);
                    resolve(key);
                } else {
                    resolve(null);
                }
            };
            req.onerror = () => reject(req.error);
        });
    }

    // Delete key from IndexedDB
    async function deleteKey(fileId) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(fileId);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function exportAllKeys() {
        const db = await openDB();
        const keys = {};
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.openCursor();
            req.onsuccess = () => {
                const cursor = req.result;
                if (cursor) {
                    keys[cursor.key] = cursor.value;
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            req.onerror = () => reject(req.error);
        });
        return {
            version: 1,
            exported_at: new Date().toISOString(),
            keys,
        };
    }

    function downloadKeyExport(exportData) {
        const blob = new Blob([JSON.stringify(exportData, null, 2)], {
            type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `freedrive-encryption-keys-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    async function storeKeyB64(fileId, keyB64url) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(keyB64url, fileId);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function importAllKeys(exportData) {
        const keys = exportData?.keys;
        if (!keys || typeof keys !== 'object') {
            throw new Error('Invalid key export file');
        }
        let count = 0;
        for (const [fileId, keyB64url] of Object.entries(keys)) {
            if (!fileId || typeof keyB64url !== 'string' || !keyB64url.trim()) {
                continue;
            }
            await storeKeyB64(fileId, keyB64url);
            count += 1;
        }
        return count;
    }

    function parseKeyExportFile(text) {
        const data = JSON.parse(text);
        if (!data || typeof data !== 'object' || !data.keys || typeof data.keys !== 'object') {
            throw new Error('Invalid key export file');
        }
        return data;
    }

    // Utility: ArrayBuffer → base64url
    function arrayBufferToBase64Url(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        bytes.forEach(b => binary += String.fromCharCode(b));
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    // Utility: base64url → ArrayBuffer
    function base64UrlToArrayBuffer(base64url) {
        const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    // Utility: Uint8Array → base64
    function uint8ToBase64(arr) {
        let binary = '';
        arr.forEach(b => binary += String.fromCharCode(b));
        return btoa(binary);
    }

    // Utility: base64 → Uint8Array
    function base64ToUint8(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    function generateRawBytes(length) {
        const out = new Uint8Array(length);
        getCrypto().getRandomValues(out);
        return out;
    }

    const PBKDF2_ITERATIONS = 310000;

    async function deriveKek(password, salt) {
        const enc = new TextEncoder();
        const keyMaterial = await getSubtleCrypto().importKey(
            'raw',
            enc.encode(password),
            'PBKDF2',
            false,
            ['deriveBits'],
        );
        const bits = await getSubtleCrypto().deriveBits(
            {
                name: 'PBKDF2',
                salt,
                iterations: PBKDF2_ITERATIONS,
                hash: 'SHA-256',
            },
            keyMaterial,
            256,
        );
        return new Uint8Array(bits);
    }

    async function importAesRawKey(rawBytes) {
        return await getSubtleCrypto().importKey(
            'raw',
            rawBytes,
            ALGO,
            false,
            ['encrypt', 'decrypt'],
        );
    }

    async function wrapRawKey(rawKey, wrappingKeyBytes) {
        const wrapKey = await importAesRawKey(wrappingKeyBytes);
        const iv = getCrypto().getRandomValues(new Uint8Array(12));
        const ciphertext = await getSubtleCrypto().encrypt(
            { name: 'AES-GCM', iv },
            wrapKey,
            rawKey,
        );
        const combined = new Uint8Array(iv.length + ciphertext.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(ciphertext), iv.length);
        return arrayBufferToBase64Url(combined.buffer);
    }

    async function unwrapRawKey(wrappedB64url, wrappingKeyBytes) {
        const combined = new Uint8Array(base64UrlToArrayBuffer(wrappedB64url));
        if (combined.length < 13) {
            throw new Error('Invalid wrapped key');
        }
        const iv = combined.slice(0, 12);
        const ciphertext = combined.slice(12);
        const wrapKey = await importAesRawKey(wrappingKeyBytes);
        const plain = await getSubtleCrypto().decrypt(
            { name: 'AES-GCM', iv },
            wrapKey,
            ciphertext,
        );
        return new Uint8Array(plain);
    }

    function formatRecoveryCode(rawBytes) {
        const hex = Array.from(rawBytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
        return hex.match(/.{1,8}/g)?.join('-') || hex;
    }

    function parseRecoveryCode(code) {
        const hex = String(code || '').replace(/[\s-]/g, '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(hex)) {
            throw new Error('Invalid recovery code format');
        }
        const out = new Uint8Array(32);
        for (let i = 0; i < 32; i += 1) {
            out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    async function rawKeyToCryptoKey(rawBytes) {
        return await importKey(arrayBufferToBase64Url(rawBytes.buffer));
    }

    return {
        generateKey,
        canEncrypt,
        exportKey,
        importKey,
        encryptFile,
        decryptFile,
        storeKey,
        getKey,
        deleteKey,
        exportAllKeys,
        downloadKeyExport,
        importAllKeys,
        parseKeyExportFile,
        uint8ToBase64,
        base64ToUint8,
        arrayBufferToBase64Url,
        base64UrlToArrayBuffer,
        generateRawBytes,
        deriveKek,
        wrapRawKey,
        unwrapRawKey,
        formatRecoveryCode,
        parseRecoveryCode,
        rawKeyToCryptoKey,
        PBKDF2_ITERATIONS,
        persistDeviceUek,
        restoreDeviceUek,
        clearDeviceUek,
    };
})();
