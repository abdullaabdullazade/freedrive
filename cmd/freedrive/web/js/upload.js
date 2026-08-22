const Upload = (() => {
    const queue = [];
    let active = 0;
    const MAX_CONCURRENT = 3;
    let insecureUploadNoticeShown = false;
    let refreshTimer = null;
    let batchUploaded = 0;
    let batchFailed = 0;
    let batchTotal = 0;

    function init() {
        document.getElementById('upload-minimize')?.addEventListener('click', () => {
            document.getElementById('upload-progress').classList.add('hidden');
        });
    }

    function scheduleRefresh() {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            FileManager.refresh?.();
        }, 400);
    }

    function flushRefresh() {
        clearTimeout(refreshTimer);
        refreshTimer = null;
        FileManager.refresh?.();
    }

    function fileWithRelativePath(file, relativePath) {
        if (file.webkitRelativePath === relativePath) return file;
        try {
            Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true });
            return file;
        } catch {
            const wrapped = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
            try {
                Object.defineProperty(wrapped, 'webkitRelativePath', { value: relativePath, configurable: true });
            } catch {}
            return wrapped;
        }
    }

    function readDirectoryEntries(dirEntry) {
        return new Promise((resolve, reject) => {
            const reader = dirEntry.createReader();
            const entries = [];
            const readBatch = () => {
                reader.readEntries((batch) => {
                    if (!batch.length) {
                        resolve(entries);
                        return;
                    }
                    entries.push(...batch);
                    readBatch();
                }, reject);
            };
            readBatch();
        });
    }

    async function readEntryTree(entry, pathPrefix, out) {
        if (entry.isFile) {
            const file = await new Promise((resolve, reject) => {
                entry.file(resolve, reject);
            });
            const rel = pathPrefix ? `${pathPrefix}/${file.name}` : file.name;
            out.push(fileWithRelativePath(file, rel));
            return;
        }
        if (!entry.isDirectory) return;

        const dirPath = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
        const children = await readDirectoryEntries(entry);
        await Promise.all(children.map((child) => readEntryTree(child, dirPath, out)));
    }

    async function collectFromDataTransfer(dataTransfer) {
        const items = dataTransfer?.items;
        if (!items?.length) {
            return Array.from(dataTransfer?.files || []);
        }

        const collected = [];
        const entryPromises = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind !== 'file') continue;
            const entry = item.webkitGetAsEntry?.() || item.getAsEntry?.();
            if (entry) {
                entryPromises.push(readEntryTree(entry, '', collected));
            } else if (item.getAsFile) {
                const file = item.getAsFile();
                if (file) collected.push(file);
            }
        }

        if (entryPromises.length) {
            await Promise.all(entryPromises);
        }

        if (!collected.length && dataTransfer.files?.length) {
            return Array.from(dataTransfer.files);
        }

        return collected;
    }

    function handleFiles(files) {
        const list = Array.from(files || []);
        if (!list.length) return;
        uploadFileTree(list);
    }

    async function resolveFolderId(name, parentId) {
        try {
            const data = parentId ? await API.folders.get(parentId) : await API.folders.root();
            const match = (data.folders || []).find((f) => f.name === name);
            return match?.id || null;
        } catch {
            return null;
        }
    }

    async function ensureFolder(name, parentId, folderMap, dirPath) {
        if (folderMap.has(dirPath)) return folderMap.get(dirPath);

        try {
            const created = await API.folders.create(name, parentId || null);
            if (!created?.id) throw new Error('no id returned');
            folderMap.set(dirPath, created.id);
            return created.id;
        } catch (err) {
            const existingId = await resolveFolderId(name, parentId);
            if (existingId) {
                folderMap.set(dirPath, existingId);
                return existingId;
            }
            throw err;
        }
    }

    async function uploadFileTree(files) {
        const fileList = Array.from(files || []);
        if (!fileList.length) return;

        const hasRelative = fileList.some((f) => f.webkitRelativePath && f.webkitRelativePath.includes('/'));
        if (!hasRelative) {
            addFiles(fileList.map((f) => ({ file: f, folderId: null })));
            return;
        }

        const uploadProgress = document.getElementById('upload-progress');
        const uploadList = document.getElementById('upload-list');
        const uploadCount = document.getElementById('upload-count');
        uploadProgress.classList.remove('hidden');

        const prepItem = document.createElement('div');
        prepItem.className = 'upload-item';
        prepItem.innerHTML = `
            <div style="flex:1;min-width:0;">
                <div class="upload-item-name">Creating folder structure…</div>
                <div class="upload-item-progress"><div class="upload-item-progress-fill" style="width:60%;transition:none"></div></div>
            </div>
            <div class="upload-item-status">Preparing…</div>
        `;
        uploadList.appendChild(prepItem);
        uploadCount.textContent = '…';

        const currentFolder = FileManager.getCurrentFolder?.() || null;
        const folderMap = new Map();

        const uniqueDirs = new Set();
        fileList.forEach((f) => {
            const parts = f.webkitRelativePath.split('/');
            for (let i = 1; i < parts.length; i++) {
                uniqueDirs.add(parts.slice(0, i).join('/'));
            }
        });
        const sortedDirs = Array.from(uniqueDirs).sort((a, b) => a.split('/').length - b.split('/').length);

        try {
            for (const dirPath of sortedDirs) {
                const parts = dirPath.split('/');
                const name = parts[parts.length - 1];
                const parentPath = parts.slice(0, -1).join('/');
                const parentId = parentPath ? (folderMap.get(parentPath) ?? currentFolder) : currentFolder;
                await ensureFolder(name, parentId, folderMap, dirPath);
            }
        } catch (err) {
            prepItem.remove();
            Components.toast(`Folder structure could not be created: ${err.message}`, 'error');
            return;
        }

        prepItem.remove();

        const jobs = fileList.map((f) => {
            const parts = f.webkitRelativePath.split('/');
            const dirPath = parts.slice(0, -1).join('/');
            const folderId = folderMap.get(dirPath) ?? currentFolder;
            return { file: f, folderId };
        });

        addFiles(jobs);
    }

    async function handleFolderFiles(files) {
        await uploadFileTree(files);
    }

    function addFiles(jobs) {
        if (!jobs.length) return;
        const uploadProgress = document.getElementById('upload-progress');
        const uploadList = document.getElementById('upload-list');
        const uploadCount = document.getElementById('upload-count');

        uploadProgress.classList.remove('hidden');
        batchTotal += jobs.length;

        jobs.forEach(({ file, folderId }) => {
            const id = `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const item = document.createElement('div');
            item.className = 'upload-item';
            item.id = id;
            item.innerHTML = `
                <div style="flex:1;min-width:0;">
                    <div class="upload-item-name">${Components.escapeHtml(file.name)}</div>
                    <div class="upload-item-progress"><div class="upload-item-progress-fill"></div></div>
                </div>
                <div class="upload-item-status">Encrypting...</div>
            `;
            uploadList.appendChild(item);
            queue.push({ file, id, folderId });
        });

        uploadCount.textContent = String(queue.length + active);
        processQueue();
    }

    function showBatchSummary() {
        if (batchUploaded > 0) {
            const label = batchUploaded === 1 ? '1 file uploaded' : `${batchUploaded} files uploaded`;
            Components.toast(label, batchFailed ? 'warning' : 'success', { duration: 4000 });
        }
        if (batchFailed > 0 && batchUploaded === 0) {
            const label = batchFailed === 1 ? '1 upload failed' : `${batchFailed} uploads failed`;
            Components.toast(label, 'error', { duration: 5000 });
        } else if (batchFailed > 0) {
            Components.toast(`${batchFailed} upload(s) failed`, 'error', { duration: 5000 });
        }
        batchUploaded = 0;
        batchFailed = 0;
        batchTotal = 0;
    }

    async function processQueue() {
        while (queue.length && active < MAX_CONCURRENT) {
            const job = queue.shift();
            active += 1;
            uploadFile(job)
                .catch(() => {})
                .finally(() => {
                    active -= 1;
                    document.getElementById('upload-count').textContent = String(queue.length + active);
                    processQueue();
                    if (!queue.length && !active) {
                        flushRefresh();
                        showBatchSummary();
                        setTimeout(() => {
                            document.getElementById('upload-progress').classList.add('hidden');
                            document.getElementById('upload-list').innerHTML = '';
                        }, 1400);
                    }
                });
        }
    }

    async function uploadWithRetry(jobFn) {
        try {
            return await jobFn();
        } catch (err) {
            const msg = String(err.message || '').toLowerCase();
            if (msg.includes('rate limit') || msg.includes('database') || msg.includes('locked')) {
                await new Promise((r) => setTimeout(r, 600));
                return jobFn();
            }
            throw err;
        }
    }

    async function uploadFile(job) {
        const { file, id, folderId: jobFolderId } = job;
        const itemEl = document.getElementById(id);
        if (!itemEl) return;
        const progressFill = itemEl.querySelector('.upload-item-progress-fill');
        const statusEl = itemEl.querySelector('.upload-item-status');

        try {
            const cryptoModule = window.CryptoModule;
            const canEncrypt = Boolean(cryptoModule?.canEncrypt?.() && cryptoModule?.generateKey);

            statusEl.textContent = 'Uploading...';

            const currentFolder = jobFolderId || FileManager.getCurrentFolder?.();
            let key = null;
            let payload;
            let ivB64 = '';
            const originalSize = file.size;

            if (canEncrypt) {
                statusEl.textContent = 'Encrypting...';
                key = await cryptoModule.generateKey();
                const originalBuffer = await file.arrayBuffer();
                const { ciphertext, iv } = await cryptoModule.encryptFile(originalBuffer, key);
                payload = ciphertext;
                ivB64 = cryptoModule.uint8ToBase64(iv);
            } else {
                if (!insecureUploadNoticeShown) {
                    insecureUploadNoticeShown = true;
                    Components.toast('HTTPS is not enabled, so files will be uploaded without browser encryption.', 'info', { duration: 7000 });
                }
                payload = await file.arrayBuffer();
            }

            const result = await uploadWithRetry(() => API.uploadBytes({
                data: payload,
                name: file.name,
                mimeType: file.type || 'application/octet-stream',
                originalSize,
                iv: ivB64,
                folderId: currentFolder || undefined,
                onProgress: (pct) => {
                    progressFill.style.width = `${pct}%`;
                    statusEl.textContent = `${pct}%`;
                },
            }));

            if (key) {
                await cryptoModule.storeKey(result.id, key);
                if (window.CryptoSync?.pushFileKey) await CryptoSync.pushFileKey(result.id, key);
            }
            progressFill.style.width = '100%';
            statusEl.textContent = 'Done';
            statusEl.style.color = 'var(--fd-green)';

            FileManager.afterUpload?.(result, file);
            batchUploaded += 1;
            scheduleRefresh();
        } catch (err) {
            statusEl.textContent = 'Failed';
            statusEl.style.color = 'var(--fd-red)';
            batchFailed += 1;
        }
    }

    return {
        init,
        handleFiles,
        handleFolderFiles,
        uploadFileTree,
        collectFromDataTransfer,
        addFiles,
    };
})();
