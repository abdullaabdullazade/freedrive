// ========================================
// FreeDrive — E2E Key Sync (account UEK + server)
// ========================================

var CryptoSync = window.CryptoSync = (() => {
    const SYNC_CURSOR_KEY = 'fd_crypto_sync_since';
    const NEEDS_RECOVERY_KEY = 'fd_crypto_needs_recovery';
    const ERR_UNLOCK_REQUIRED = 'FD_CRYPTO_UNLOCK_REQUIRED';
    const ERR_KEY_NOT_ON_SERVER = 'FD_CRYPTO_KEY_NOT_ON_SERVER';
    const ERR_NEEDS_RECOVERY = 'FD_CRYPTO_NEEDS_RECOVERY';
    let uekRaw = null;
    let recoveryKeyRaw = null;

    function currentUserId() {
        return API.getUser?.()?.id || null;
    }

    async function persistDeviceUnlock(userId) {
        if (!userId || !uekRaw) return;
        await CryptoModule.persistDeviceUek(userId, uekRaw);
    }

    async function tryRestoreDeviceUnlock(userId) {
        const uid = userId || currentUserId();
        if (!uid) return false;
        try {
            const restored = await CryptoModule.restoreDeviceUek(uid);
            if (!restored || restored.length !== 32) return false;
            uekRaw = restored;
            return true;
        } catch {
            return false;
        }
    }

    async function clearDeviceUnlock(userId) {
        const uid = userId || currentUserId();
        if (!uid) return;
        await CryptoModule.clearDeviceUek(uid);
    }

    function setNeedsRecovery(flag) {
        if (flag) {
            localStorage.setItem(NEEDS_RECOVERY_KEY, 'true');
        } else {
            localStorage.removeItem(NEEDS_RECOVERY_KEY);
        }
    }

    function getNeedsRecovery() {
        return localStorage.getItem(NEEDS_RECOVERY_KEY) === 'true';
    }

    async function detectNeedsRecovery() {
        if (!API.isLoggedIn()) return false;
        try {
            const account = await API.crypto.getAccount();
            if (account?.has_crypto) {
                setNeedsRecovery(false);
                return false;
            }
            const data = await API.crypto.listKeys('');
            const needs = (data?.keys || []).length > 0;
            setNeedsRecovery(needs);
            return needs;
        } catch {
            return getNeedsRecovery();
        }
    }

    function canUse() {
        return Boolean(window.CryptoModule?.canEncrypt?.());
    }

    function isUnlocked() {
        return Boolean(uekRaw && uekRaw.length === 32);
    }

    function lock() {
        uekRaw = null;
        recoveryKeyRaw = null;
    }

    async function lockAndClearDevice(userId) {
        const uid = userId || currentUserId();
        lock();
        if (uid) {
            await clearDeviceUnlock(uid);
        }
        setNeedsRecovery(false);
    }

    function describeFileKeyError(err) {
        const code = err?.code || err?.message || '';
        if (code === ERR_NEEDS_RECOVERY) {
            return 'Server lost encryption account data but file keys remain. Open Settings and enter your recovery code.';
        }
        if (code === ERR_UNLOCK_REQUIRED) {
            return 'Sign out and sign in again with your password to restore file access.';
        }
        if (code === ERR_KEY_NOT_ON_SERVER) {
            return 'This file\'s encryption key is not on the server yet. Wait for sync from the device that uploaded it, or upload the file again.';
        }
        return err?.message || 'Encryption key not available';
    }

    function saltFromAccount(account) {
        const salt = account?.key_salt;
        if (!salt) return null;
        if (salt instanceof Uint8Array) return salt;
        if (Array.isArray(salt)) return new Uint8Array(salt);
        if (typeof salt === 'string') {
            try {
                const bin = atob(salt);
                const out = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
                return out;
            } catch {
                return null;
            }
        }
        return null;
    }

    async function unwrapUekWithPassword(account, password) {
        const salt = saltFromAccount(account);
        if (!salt || !account?.wrapped_uek) {
            throw new Error('Encryption account is not configured on the server');
        }
        const kek = await CryptoModule.deriveKek(password, salt);
        return await CryptoModule.unwrapRawKey(account.wrapped_uek, kek);
    }

    async function unwrapUekWithRecovery(account, recoveryCode) {
        if (!account?.has_recovery || !account?.wrapped_uek_recovery) {
            throw new Error('No recovery code was set up for this account');
        }
        const recoveryKey = CryptoModule.parseRecoveryCode(recoveryCode);
        return await CryptoModule.unwrapRawKey(account.wrapped_uek_recovery, recoveryKey);
    }

    async function setupNewAccount(password) {
        const uek = CryptoModule.generateRawBytes(32);
        const recoveryKey = CryptoModule.generateRawBytes(32);
        const salt = CryptoModule.generateRawBytes(16);
        const kek = await CryptoModule.deriveKek(password, salt);
        const wrappedUek = await CryptoModule.wrapRawKey(uek, kek);
        const wrappedRecovery = await CryptoModule.wrapRawKey(uek, recoveryKey);
        await API.crypto.setupAccount({
            key_salt: Array.from(salt),
            wrapped_uek: wrappedUek,
            wrapped_uek_recovery: wrappedRecovery,
        });
        uekRaw = uek;
        recoveryKeyRaw = recoveryKey;
        return CryptoModule.formatRecoveryCode(recoveryKey);
    }

    async function syncAllKeysWithStats() {
        if (!isUnlocked()) return { pulled: 0, pushed: 0 };
        const pulled1 = await pullKeysFromServer();
        const pushed = await pushLocalKeysToServer();
        const pulled2 = await pullKeysFromServer();
        return { pulled: pulled1 + pulled2, pushed };
    }

    function toastSyncStats(stats) {
        const total = (stats?.pulled || 0) + (stats?.pushed || 0);
        if (total > 0) {
            Components.toast(`Synced ${total} encryption key${total === 1 ? '' : 's'}`, 'success');
        }
    }

    async function unlockWithPassword(password) {
        const account = await API.crypto.getAccount();
        if (!account?.has_crypto) {
            if (await detectNeedsRecovery()) {
                const err = new Error(ERR_NEEDS_RECOVERY);
                err.code = ERR_NEEDS_RECOVERY;
                throw err;
            }
            const recoveryCode = await setupNewAccount(password);
            await persistDeviceUnlock(currentUserId());
            const stats = await syncAllKeysWithStats();
            toastSyncStats(stats);
            return { setup: true, recoveryCode, stats };
        }
        uekRaw = await unwrapUekWithPassword(account, password);
        await persistDeviceUnlock(currentUserId());
        const stats = await syncAllKeysWithStats();
        toastSyncStats(stats);
        setNeedsRecovery(false);
        return { setup: false, stats };
    }

    async function unlockWithRecovery(recoveryCode) {
        const account = await API.crypto.getAccount();
        if (!account?.has_crypto) {
            throw new Error('Server encryption account is missing. Recovery requires server backup data.');
        }
        uekRaw = await unwrapUekWithRecovery(account, recoveryCode);
        await persistDeviceUnlock(currentUserId());
        const stats = await syncAllKeysWithStats();
        toastSyncStats(stats);
        setNeedsRecovery(false);
        return { setup: false, stats };
    }

    async function restoreWithRecoveryCode(recoveryCode) {
        const result = await unlockWithRecovery(recoveryCode);
        return result;
    }

    async function rotateAccountKey(password) {
        const account = await API.crypto.getAccount();
        if (!account?.has_crypto) {
            throw new Error('Encryption is not set up for this account');
        }
        const oldUek = await unwrapUekWithPassword(account, password);
        const newUek = CryptoModule.generateRawBytes(32);
        const newRecoveryKey = CryptoModule.generateRawBytes(32);
        const salt = CryptoModule.generateRawBytes(16);
        const kek = await CryptoModule.deriveKek(password, salt);
        const wrappedUek = await CryptoModule.wrapRawKey(newUek, kek);
        const wrappedRecovery = await CryptoModule.wrapRawKey(newUek, newRecoveryKey);

        const exportData = await CryptoModule.exportAllKeys();
        const rewrapped = {};
        for (const [fileId, keyB64] of Object.entries(exportData.keys || {})) {
            if (!keyB64) continue;
            try {
                const raw = CryptoModule.base64UrlToArrayBuffer(keyB64);
                rewrapped[fileId] = await CryptoModule.wrapRawKey(new Uint8Array(raw), newUek);
            } catch {
                /* skip */
            }
        }
        if (Object.keys(rewrapped).length) {
            await API.crypto.bulkPutKeys({ keys: rewrapped });
        }
        await API.crypto.updateAccount({
            key_salt: Array.from(salt),
            wrapped_uek: wrappedUek,
            wrapped_uek_recovery: wrappedRecovery,
        });
        uekRaw = newUek;
        recoveryKeyRaw = newRecoveryKey;
        await persistDeviceUnlock(currentUserId());
        const stats = await syncAllKeysWithStats();
        toastSyncStats(stats);
        return {
            recoveryCode: CryptoModule.formatRecoveryCode(newRecoveryKey),
            stats,
        };
    }

    async function rewrapWithNewPassword(oldPassword, newPassword) {
        const account = await API.crypto.getAccount();
        if (!account?.has_crypto) return;
        const current = await unwrapUekWithPassword(account, oldPassword);
        const salt = CryptoModule.generateRawBytes(16);
        const kek = await CryptoModule.deriveKek(newPassword, salt);
        const wrappedUek = await CryptoModule.wrapRawKey(current, kek);
        let wrappedRecovery = account.wrapped_uek_recovery || '';
        if (recoveryKeyRaw) {
            wrappedRecovery = await CryptoModule.wrapRawKey(current, recoveryKeyRaw);
        }
        await API.crypto.updateAccount({
            key_salt: Array.from(salt),
            wrapped_uek: wrappedUek,
            wrapped_uek_recovery: wrappedRecovery || undefined,
        });
        uekRaw = current;
        await persistDeviceUnlock(currentUserId());
    }

    async function rewrapAfterPasswordReset(newPassword, recoveryCode) {
        const account = await API.crypto.getAccount();
        if (!account?.has_crypto) return;
        uekRaw = await unwrapUekWithRecovery(account, recoveryCode);
        const salt = CryptoModule.generateRawBytes(16);
        const kek = await CryptoModule.deriveKek(newPassword, salt);
        const wrappedUek = await CryptoModule.wrapRawKey(uekRaw, kek);
        let wrappedRecovery = '';
        if (account.has_recovery) {
            const recoveryKey = CryptoModule.parseRecoveryCode(recoveryCode);
            recoveryKeyRaw = recoveryKey;
            wrappedRecovery = await CryptoModule.wrapRawKey(uekRaw, recoveryKey);
        }
        await API.crypto.updateAccount({
            key_salt: Array.from(salt),
            wrapped_uek: wrappedUek,
            wrapped_uek_recovery: wrappedRecovery || undefined,
        });
        await persistDeviceUnlock(currentUserId());
    }

    function getSyncCursor() {
        return localStorage.getItem(SYNC_CURSOR_KEY) || '';
    }

    function setSyncCursor(iso) {
        if (iso) localStorage.setItem(SYNC_CURSOR_KEY, iso);
    }

    async function pullKeysFromServer() {
        if (!isUnlocked()) return 0;
        let since = getSyncCursor();
        let imported = 0;
        for (;;) {
            const q = since ? `?since=${encodeURIComponent(since)}` : '';
            const data = await API.crypto.listKeys(q);
            const keys = data?.keys || [];
            if (!keys.length) break;
            for (const entry of keys) {
                if (!entry?.file_id || !entry?.wrapped_file_key) continue;
                try {
                    const raw = await CryptoModule.unwrapRawKey(entry.wrapped_file_key, uekRaw);
                    const keyB64 = CryptoModule.arrayBufferToBase64Url(raw.buffer);
                    await CryptoModule.storeKeyB64(entry.file_id, keyB64);
                    imported += 1;
                } catch {
                    /* skip invalid */
                }
                if (entry.updated_at) since = entry.updated_at;
            }
            if (keys.length < 5000) break;
        }
        if (since) setSyncCursor(since);
        return imported;
    }

    async function pushLocalKeysToServer() {
        if (!isUnlocked()) return 0;
        const exportData = await CryptoModule.exportAllKeys();
        const wrapped = {};
        for (const [fileId, keyB64] of Object.entries(exportData.keys || {})) {
            if (!keyB64) continue;
            try {
                const raw = CryptoModule.base64UrlToArrayBuffer(keyB64);
                wrapped[fileId] = await CryptoModule.wrapRawKey(new Uint8Array(raw), uekRaw);
            } catch {
                /* skip */
            }
        }
        if (!Object.keys(wrapped).length) return 0;
        const result = await API.crypto.bulkPutKeys({ keys: wrapped });
        return result?.imported || 0;
    }

    async function syncAllKeys() {
        const stats = await syncAllKeysWithStats();
        return stats;
    }

    async function wrapFileKeyForUpload(key) {
        if (!isUnlocked()) return null;
        const rawB64 = await CryptoModule.exportKey(key);
        const raw = new Uint8Array(CryptoModule.base64UrlToArrayBuffer(rawB64));
        return CryptoModule.wrapRawKey(raw, uekRaw);
    }

    async function pushFileKey(fileId, key) {
        if (!isUnlocked() || !fileId || !key) return;
        const wrapped = await wrapFileKeyForUpload(key);
        if (!wrapped) return;
        await API.crypto.putFileKey(fileId, wrapped);
    }

    async function ensureFileKey(fileId) {
        let key = await CryptoModule.getKey(fileId);
        if (key) return key;
        if (!isUnlocked()) {
            if (getNeedsRecovery()) {
                const err = new Error(ERR_NEEDS_RECOVERY);
                err.code = ERR_NEEDS_RECOVERY;
                throw err;
            }
            const err = new Error(ERR_UNLOCK_REQUIRED);
            err.code = ERR_UNLOCK_REQUIRED;
            throw err;
        }
        let data;
        try {
            data = await API.crypto.getFileKey(fileId);
        } catch (err) {
            const msg = String(err?.message || '').toLowerCase();
            if (msg.includes('404') || msg.includes('not found')) {
                const e = new Error(ERR_KEY_NOT_ON_SERVER);
                e.code = ERR_KEY_NOT_ON_SERVER;
                throw e;
            }
            throw err;
        }
        if (!data?.wrapped_file_key) {
            const e = new Error(ERR_KEY_NOT_ON_SERVER);
            e.code = ERR_KEY_NOT_ON_SERVER;
            throw e;
        }
        const raw = await CryptoModule.unwrapRawKey(data.wrapped_file_key, uekRaw);
        key = await CryptoModule.rawKeyToCryptoKey(raw);
        await CryptoModule.storeKey(fileId, key);
        return key;
    }

    async function showRecoverySetupModal(recoveryCode) {
        return new Promise((resolve) => {
            Components.showModal(
                'Save your recovery code',
                `<p style="margin:0 0 12px;font-size:14px;color:#5f6368;line-height:1.45;">
                    Store this code in a safe place. You will need it only if you reset your password
                    without knowing the old one.
                </p>
                <div style="font-family:monospace;font-size:15px;padding:12px;border-radius:8px;background:#f1f3f4;word-break:break-all;">${Components.escapeHtml(recoveryCode)}</div>
                <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;color:#3c4043;">
                    <input type="checkbox" id="crypto-recovery-saved">
                    I saved this recovery code
                </label>`,
                [
                    {
                        text: 'Continue',
                        class: 'btn-primary',
                        close: false,
                        action: () => {
                            const checked = document.getElementById('crypto-recovery-saved')?.checked;
                            if (!checked) {
                                Components.toast('Confirm that you saved the recovery code', 'error');
                                return false;
                            }
                            Components.hideModal();
                            resolve(true);
                            return true;
                        },
                    },
                ],
            );
        });
    }

    async function ensureUnlockedAfterLogin(password) {
        if (!canUse()) return true;
        try {
            const userId = currentUserId();
            if (userId && await tryRestoreDeviceUnlock(userId)) {
                try {
                    await syncAllKeysWithStats();
                } catch { /* ignore */ }
                setNeedsRecovery(false);
                return true;
            }
            const result = await unlockWithPassword(password);
            if (result.setup && result.recoveryCode) {
                await showRecoverySetupModal(result.recoveryCode);
            }
            return true;
        } catch (err) {
            if (err?.code === ERR_NEEDS_RECOVERY) {
                await detectNeedsRecovery();
                return true;
            }
            Components.toast(err?.message || 'Encryption setup failed', 'error');
            return false;
        }
    }

    async function ensureUnlockedOnAppLoad() {
        if (!canUse() || !API.isLoggedIn()) return true;
        await detectNeedsRecovery();
        if (isUnlocked()) {
            try {
                await syncAllKeysWithStats();
            } catch { /* ignore background sync errors */ }
            return true;
        }
        const userId = currentUserId();
        if (userId && await tryRestoreDeviceUnlock(userId)) {
            try {
                await syncAllKeysWithStats();
            } catch { /* ignore */ }
            return true;
        }
        return true;
    }

    async function buildCryptoUpdateForReset(token, email, newPassword, recoveryCode) {
        if (!recoveryCode || !canUse()) return null;
        const account = await API.auth.resetPasswordCryptoInfo(token, email);
        if (!account?.has_crypto || !account?.wrapped_uek_recovery) return null;
        const recoveryKey = CryptoModule.parseRecoveryCode(recoveryCode);
        const uek = await CryptoModule.unwrapRawKey(account.wrapped_uek_recovery, recoveryKey);
        const salt = CryptoModule.generateRawBytes(16);
        const kek = await CryptoModule.deriveKek(newPassword, salt);
        const wrappedUek = await CryptoModule.wrapRawKey(uek, kek);
        const wrappedRecovery = await CryptoModule.wrapRawKey(uek, recoveryKey);
        return {
            key_salt: Array.from(salt),
            wrapped_uek: wrappedUek,
            wrapped_uek_recovery: wrappedRecovery,
        };
    }

    return {
        canUse,
        isUnlocked,
        lock,
        lockAndClearDevice,
        unlockWithPassword,
        unlockWithRecovery,
        restoreWithRecoveryCode,
        rotateAccountKey,
        rewrapWithNewPassword,
        rewrapAfterPasswordReset,
        syncAllKeys,
        pushFileKey,
        ensureFileKey,
        describeFileKeyError,
        detectNeedsRecovery,
        getNeedsRecovery,
        ERR_UNLOCK_REQUIRED,
        ERR_KEY_NOT_ON_SERVER,
        ERR_NEEDS_RECOVERY,
        ensureUnlockedAfterLogin,
        ensureUnlockedOnAppLoad,
        showRecoverySetupModal,
        buildCryptoUpdateForReset,
    };
})();
