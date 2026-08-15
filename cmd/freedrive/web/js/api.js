const API = (() => {
    const BASE = '/api/v1';
    let accessToken = localStorage.getItem('fd_access_token') || '';
    let refreshToken = localStorage.getItem('fd_refresh_token') || '';
    let currentUser = JSON.parse(localStorage.getItem('fd_user') || 'null');

    function setTokens(tokens) {
        accessToken = tokens?.access_token || '';
        refreshToken = tokens?.refresh_token || '';
        localStorage.setItem('fd_access_token', accessToken);
        localStorage.setItem('fd_refresh_token', refreshToken);
    }

    function setUser(user) {
        currentUser = user || null;
        localStorage.setItem('fd_user', JSON.stringify(currentUser));
    }

    function getUser() {
        return currentUser;
    }

    function isLoggedIn() {
        return Boolean(accessToken);
    }

    // Auto-refresh the access token before it expires (every 23 hours)
    let _refreshTimer = null;
    function startAutoRefresh() {
        if (_refreshTimer) clearInterval(_refreshTimer);
        if (!refreshToken) return;
        // Refresh every 23 hours (token lasts 24h)
        _refreshTimer = setInterval(async () => {
            if (refreshToken) await tryRefresh();
        }, 23 * 60 * 60 * 1000);
    }
    // Also try to refresh immediately on page load if we have a refresh token
    if (refreshToken) {
        setTimeout(() => tryRefresh().then(ok => { if (ok) startAutoRefresh(); }), 2000);
    }

    function clearAuth() {
        accessToken = '';
        refreshToken = '';
        currentUser = null;
        localStorage.removeItem('fd_access_token');
        localStorage.removeItem('fd_refresh_token');
        localStorage.removeItem('fd_user');
        // Keep fd_device_id so re-login overwrites the same device session.
    }

    function getDeviceID() {
        let id = localStorage.getItem('fd_device_id') || '';
        if (!id) {
            id = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : ('web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
            localStorage.setItem('fd_device_id', id);
        }
        return id;
    }

    async function request(method, path, body = null, isRetry = false, rlRetries = 2) {
        const headers = {};
        if (!(body instanceof FormData)) {
            headers['Content-Type'] = 'application/json';
        }
        headers['X-Device-ID'] = getDeviceID();
        if (accessToken) {
            headers.Authorization = `Bearer ${accessToken}`;
        }

        const opts = { method, headers };
        if (body && method !== 'GET') {
            opts.body = body instanceof FormData ? body : JSON.stringify(body);
        }

        let res;
        try {
            res = await fetch(BASE + path, opts);
        } catch (err) {
            const raw = String(err?.message || '').toLowerCase();
            if (raw.includes('failed to fetch') || raw.includes('networkerror') || raw.includes('load failed') || !raw) {
                throw new Error('Cannot reach the server. Check the FreeDrive URL (HTTPS / reverse proxy) and try again.');
            }
            throw new Error(err.message || 'Network error');
        }

        // Public auth endpoints return 401 for bad credentials — never treat as session refresh.
        const isPublicAuth = path === '/auth/login'
            || path === '/auth/register'
            || path === '/auth/refresh'
            || path === '/auth/reset-password'
            || path === '/auth/confirm-email'
            || path === '/auth/verify-2fa'
            || path === '/auth/2fa/send-email'
            || path === '/auth/forgot-password';
        if (res.status === 401 && !isRetry && refreshToken && !isPublicAuth) {
            const refreshed = await tryRefresh();
            if (refreshed) return request(method, path, body, true, rlRetries);
            clearAuth();
            window.location.hash = '#/login';
            throw new Error('Session expired');
        }

        if (res.status === 429 && rlRetries > 0) {
            await new Promise((r) => setTimeout(r, 400));
            return request(method, path, body, isRetry, rlRetries - 1);
        }

        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        return data;
    }

    async function tryRefresh() {
        try {
            const res = await fetch(`${BASE}/auth/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: refreshToken }),
            });
            if (!res.ok) return false;
            const data = await res.json();
            setTokens(data.tokens);
            return true;
        } catch {
            return false;
        }
    }

    function uploadXHR(path, formData, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', BASE + path);
            if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
            xhr.setRequestHeader('X-Device-ID', getDeviceID());

            xhr.upload.onprogress = (e) => {
                if (!e.lengthComputable || !onProgress) return;
                onProgress(Math.round((e.loaded / e.total) * 100));
            };

            xhr.onload = () => {
                let payload = {};
                try { payload = JSON.parse(xhr.responseText || '{}'); } catch {}
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(payload);
                } else {
                    reject(new Error(payload.error || `Upload failed (${xhr.status})`));
                }
            };
            xhr.onerror = () => reject(new Error('Network error'));
            xhr.send(formData);
        });
    }

    /** Ciphertext larger than this uses resumable chunked upload (Cloudflare-safe). */
    const RESUMABLE_THRESHOLD = 32 * 1024 * 1024;
    const RESUMABLE_CHUNK = 8 * 1024 * 1024;

    function putChunkXHR(sessionId, body, contentRange, onChunkProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', `${BASE}/uploads/sessions/${sessionId}`);
            if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
            xhr.setRequestHeader('X-Device-ID', getDeviceID());
            xhr.setRequestHeader('Content-Range', contentRange);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            if (onChunkProgress) {
                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) onChunkProgress(e.loaded, e.total);
                };
            }
            xhr.onload = () => {
                let payload = {};
                try { payload = JSON.parse(xhr.responseText || '{}'); } catch {}
                if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
                else reject(new Error(payload.error || `Chunk upload failed (${xhr.status})`));
            };
            xhr.onerror = () => reject(new Error('Network error'));
            xhr.send(body);
        });
    }

    /**
     * Upload encrypted (or plain) bytes via resumable session when large enough.
     * @param {object} opts
     * @param {ArrayBuffer|Uint8Array|Blob} opts.data
     * @param {string} opts.name
     * @param {string} opts.mimeType
     * @param {number} opts.originalSize
     * @param {string} [opts.iv]
     * @param {string} [opts.folderId]
     * @param {string} [opts.fileId] replace existing file content
     * @param {(pct:number)=>void} [opts.onProgress]
     */
    async function uploadBytes(opts) {
        const {
            data, name, mimeType, originalSize, iv = '', folderId, fileId, onProgress,
        } = opts;
        let bytes;
        if (data instanceof Blob) {
            bytes = new Uint8Array(await data.arrayBuffer());
        } else if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data);
        } else {
            bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        }
        const encryptedSize = bytes.byteLength;

        if (encryptedSize <= RESUMABLE_THRESHOLD) {
            const form = new FormData();
            form.append('name', name);
            form.append('mime_type', mimeType || 'application/octet-stream');
            form.append('original_size', String(originalSize));
            if (iv) form.append('iv', iv);
            if (folderId) form.append('folder_id', folderId);
            form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), name);
            if (fileId) return files.updateContent(fileId, form, onProgress);
            return uploadXHR('/files/upload', form, onProgress);
        }

        const sessionBody = {
            name,
            mime_type: mimeType || 'application/octet-stream',
            iv: iv || '',
            original_size: originalSize,
            encrypted_size: encryptedSize,
        };
        if (folderId) sessionBody.folder_id = folderId;
        if (fileId) sessionBody.file_id = fileId;

        const session = await request('POST', '/uploads/sessions', sessionBody);
        let offset = 0;
        let last = null;
        while (offset < encryptedSize) {
            const end = Math.min(offset + RESUMABLE_CHUNK, encryptedSize) - 1;
            const chunk = bytes.subarray(offset, end + 1);
            const range = `bytes ${offset}-${end}/${encryptedSize}`;
            last = await putChunkXHR(session.id, chunk, range, (loaded, total) => {
                if (!onProgress) return;
                const overall = offset + (total ? (loaded / total) * (end - offset + 1) : 0);
                onProgress(Math.min(99, Math.round((overall / encryptedSize) * 100)));
            });
            offset = end + 1;
            if (onProgress) onProgress(Math.min(100, Math.round((offset / encryptedSize) * 100)));
            if (last && last.id && last.name && last.complete !== false && offset >= encryptedSize) {
                return last;
            }
            if (last && last.complete === false) continue;
            if (last && last.id && last.owner_id !== undefined) return last;
            if (last && last.id && last.mime_type !== undefined && offset >= encryptedSize) return last;
        }
        return last;
    }

    async function downloadBlob(fileId) {
        const res = await fetch(`${BASE}/files/${fileId}/download`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) throw new Error('Download failed');
        const blob = await res.blob();
        return {
            blob,
            iv: res.headers.get('X-File-IV') || '',
            mime: res.headers.get('X-File-Mime') || blob.type,
            originalSize: Number(res.headers.get('X-Original-Size') || 0),
        };
    }

    const auth = {
        login: (email, password) => request('POST', '/auth/login', { email, password }),
        pollLoginApproval: (id, token) => request('GET', `/auth/login-approval/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`),
        verify2FA: (challenge_id, code) => request('POST', '/auth/verify-2fa', { challenge_id, code }),
        send2FAEmail: (challenge_id) => request('POST', '/auth/2fa/send-email', { challenge_id }),
        register: (email, username, password, invite_code) => request('POST', '/auth/register', { email, username, password, invite_code }),
        logout: () => request('POST', '/auth/logout', { refresh_token: refreshToken }),
        resetPassword: (token, email, new_password, crypto_update) => request('POST', '/auth/reset-password', {
            token, email, new_password, crypto_update: crypto_update || undefined,
        }),
        resetPasswordCryptoInfo: (token, email) => request('POST', '/auth/reset-password/crypto-info', { token, email }),
        forgotPassword: (email) => request('POST', '/auth/forgot-password', { email }),
        confirmEmail: (token) => request('POST', '/auth/confirm-email', { token }),
        getSessions: () => request('GET', '/auth/sessions'),
        revokeSession: (id) => request('DELETE', `/auth/sessions/${id}`),
        revokeOtherSessions: () => request('POST', '/auth/sessions/revoke-others'),
    };

    const files = {
        list: (params = {}) => {
            const q = new URLSearchParams(params).toString();
            return request('GET', `/files${q ? `?${q}` : ''}`);
        },
        get: (id) => request('GET', `/files/${id}`),
        update: (id, data) => request('PATCH', `/files/${id}`, data),
        delete: (id) => request('DELETE', `/files/${id}`),
        restore: (id) => request('POST', `/files/${id}/restore`),
        permanentDelete: (id) => request('DELETE', `/files/${id}/permanent`),
        versions: (id) => request('GET', `/files/${id}/versions`),
        trash: () => request('GET', '/files/trash'),
        upload: (formData, onProgress) => uploadXHR('/files/upload', formData, onProgress),
        updateContent: (id, formData, onProgress) => uploadXHR(`/files/${id}/content`, formData, onProgress),
        restoreVersion: (id, version) => request('POST', `/files/${id}/versions/${version}/restore`),
    };

    const folders = {
        create: (name, parentId, color) => request('POST', '/folders', { name, parent_id: parentId || null, color }),
        get: (id, opts = {}) => {
            const q = new URLSearchParams();
            if (opts.page_size) q.set('page_size', String(opts.page_size));
            if (opts.page_token) q.set('page_token', opts.page_token);
            const qs = q.toString();
            return request('GET', `/folders/${id}${qs ? `?${qs}` : ''}`);
        },
        root: (opts = {}) => {
            const q = new URLSearchParams();
            if (opts.page_size) q.set('page_size', String(opts.page_size));
            if (opts.page_token) q.set('page_token', opts.page_token);
            const qs = q.toString();
            return request('GET', `/folders/root${qs ? `?${qs}` : ''}`);
        },
        /** Load every page of files (folders come on the first page). */
        getAll: async (id) => {
            const pageSize = 500;
            let page_token = '';
            let folder = null;
            let childFolders = [];
            const files = [];
            let total_files = 0;
            let guard = 0;
            while (guard < 10000) {
                guard += 1;
                const opts = { page_size: pageSize };
                if (page_token) opts.page_token = page_token;
                const data = id ? await API.folders.get(id, opts) : await API.folders.root(opts);
                if (!folder && data.folder) folder = data.folder;
                if (Array.isArray(data.folders) && data.folders.length) childFolders = data.folders;
                if (typeof data.total_files === 'number') total_files = data.total_files;
                if (Array.isArray(data.files)) files.push(...data.files);
                page_token = data.next_page_token || '';
                if (!page_token) break;
            }
            return { folder, folders: childFolders, files, total_files, next_page_token: '' };
        },
        all: (search) => request('GET', `/folders/all${search ? `?search=${encodeURIComponent(search)}` : ''}`),
        update: (id, data) => request('PATCH', `/folders/${id}`, data),
        delete: (id) => request('DELETE', `/folders/${id}`),
        restore: (id) => request('POST', `/folders/${id}/restore`),
        permanentDelete: (id) => request('DELETE', `/folders/${id}/permanent`),
        trash: () => request('GET', '/folders/trash'),
        breadcrumb: (id) => request('GET', `/folders/${id}/breadcrumb`),
    };

    const computers = {
        list: () => request('GET', '/computers'),
        get: (id) => request('GET', `/computers/${id}`),
        register: (name, hostname) => request('POST', '/computers/register', { name, hostname }),
        heartbeat: (id) => request('POST', `/computers/${id}/heartbeat`),
        delete: (id) => request('DELETE', `/computers/${id}`),
    };

    const trash = {
        empty: () => request('POST', '/trash/empty'),
    };

    const shares = {
        sharedWithMe: () => request('GET', '/shares/with-me'),
        sharedByMe: () => request('GET', '/shares/by-me'),
        createUserShare: (data) => request('POST', '/shares/users', data),
        updateUserShare: (id, data) => request('PATCH', `/shares/users/${id}`, data),
        deleteUserShare: (id) => request('DELETE', `/shares/users/${id}`),
        listLinks: () => request('GET', '/shares/links'),
        createLink: (data) => request('POST', '/shares/links', data),
        deleteLink: (id) => request('DELETE', `/shares/links/${id}`),
    };

    const comments = {
        list: (fileId) => request('GET', `/files/${fileId}/comments`),
        create: (fileId, data) => request('POST', `/files/${fileId}/comments`, data),
        delete: (fileId, commentId) => request('DELETE', `/files/${fileId}/comments/${commentId}`),
    };

    const diskStats = () => request('GET', '/disk-stats');
    const myStorage = () => request('GET', '/me/storage');
    const me = () => request('GET', '/me');
    const updateMe = (payload) => request('PATCH', '/me', payload);
    const loginApprovalStatus = () => request('GET', '/me/login-approval/status');
    const totpSetup = () => request('POST', '/me/totp/setup');
    const totpConfirm = (code) => request('POST', '/me/totp/confirm', { code });
    const totpDisable = (payload) => request('POST', '/me/totp/disable', payload || {});
    const requestEmailChange = (new_email, password) => request('POST', '/me/email-change/request', { new_email, password });
    const emailChangeStatus = () => request('GET', '/me/email-change/status');

    const admin = {
        users: () => request('GET', '/admin/users'),
        createUser: (data) => request('POST', '/admin/users', data),
        updateUser: (id, data) => request('PATCH', `/admin/users/${id}`, data),
        deleteUser: (id) => request('DELETE', `/admin/users/${id}`),
        sendPasswordReset: (id) => request('POST', `/admin/users/${id}/reset-password`),
        send2FAReminder: () => request('POST', '/admin/users/send-2fa-reminder'),
        revokeUserSessions: (id) => request('POST', `/admin/users/${id}/revoke-sessions`),
        revokeAllSessions: () => request('POST', '/admin/sessions/revoke-all'),
        stats: () => request('GET', '/admin/stats'),
        createInvite: (data) => request('POST', '/admin/invites', data),
        resendInvite: (data) => request('POST', '/admin/invites/resend', data),
        invites: () => request('GET', '/admin/invites'),
        deleteInvite: (id) => request('DELETE', `/admin/invites/${id}`),
        activity: (page = 1, pageSize = 50) => request('GET', `/admin/activity?page=${page}&page_size=${pageSize}`),
        purgeTrash: (days = 30) => request('POST', `/admin/storage/purge-trash?days=${encodeURIComponent(days)}`),
        storageBreakdown: (userId) => {
            const q = userId ? `?user_id=${encodeURIComponent(userId)}` : '';
            return request('GET', `/admin/storage/breakdown${q}`);
        },
        listDuplicates: () => request('GET', '/admin/storage/duplicates'),
        purgeDuplicates: () => request('POST', '/admin/storage/duplicates/purge'),
        listBackups: () => request('GET', '/admin/backup/list'),
        downloadBackup: async (filename) => {
            const res = await fetch(`${BASE}/admin/backup/download/${encodeURIComponent(filename)}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `Download failed (${res.status})`);
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        },
        restoreBackup: (filename) => request('POST', '/admin/backup/restore', { filename }),
        deleteBackup: (filename) => request('DELETE', `/admin/backup/${encodeURIComponent(filename)}`),
        wipeAllData: () => request('POST', '/admin/danger/wipe', { confirm: 'WIPE' }),
    };

    const activity = {
        list: (page = 1, pageSize = 50) => request('GET', `/activity?page=${page}&page_size=${pageSize}`),
    };

    const search = {
        advanced: (params = {}) => {
            const q = new URLSearchParams();
            Object.entries(params).forEach(([key, value]) => {
                if (value !== undefined && value !== null && value !== '') {
                    q.set(key, String(value));
                }
            });
            const qs = q.toString();
            return request('GET', `/search${qs ? `?${qs}` : ''}`);
        },
    };

    const approvals = {
        list: (status = '') => request('GET', `/approvals${status ? `?status=${encodeURIComponent(status)}` : ''}`),
        create: (fileId, data) => request('POST', `/files/${fileId}/approvals`, data),
        update: (id, data) => request('PATCH', `/approvals/${id}`, data),
    };

    const crypto = {
        getAccount: () => request('GET', '/crypto/account'),
        setupAccount: (data) => request('POST', '/crypto/account', data),
        updateAccount: (data) => request('PUT', '/crypto/account', data),
        listKeys: (query = '') => request('GET', `/encryption-keys${query}`),
        getFileKey: (fileId) => request('GET', `/files/${fileId}/encryption-key`),
        putFileKey: (fileId, wrappedFileKey) => request('PUT', `/files/${fileId}/encryption-key`, { wrapped_file_key: wrappedFileKey }),
        bulkPutKeys: (data) => request('POST', '/encryption-keys/bulk', data),
    };

    return {
        setTokens,
        setUser,
        getUser,
        isLoggedIn,
        clearAuth,
        auth,
        files,
        folders,
        computers,
        trash,
        shares,
        comments,
        admin,
        activity,
        search,
        approvals,
        crypto,
        diskStats,
        myStorage,
        me,
        updateMe,
        loginApprovalStatus,
        totpSetup,
        totpConfirm,
        totpDisable,
        requestEmailChange,
        emailChangeStatus,
        request,
        uploadFile: uploadXHR.bind(null, '/files/upload'),
        uploadBytes,
        downloadBlob,
    };
})();
