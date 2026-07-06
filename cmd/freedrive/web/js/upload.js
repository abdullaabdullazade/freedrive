const Upload = (() => {
    const queue = [];
    let active = 0;
    const MAX_CONCURRENT = 3;
    let insecureUploadNoticeShown = false;

    function init() {
        document.getElementById('upload-minimize')?.addEventListener('click', () => {
            document.getElementById('upload-progress').classList.add('hidden');
        });
    }

    function handleFiles(files) {
        addFiles(Array.from(files || []).map((f) => ({ file: f, folderId: null })));
    }

    async function handleFolderFiles(files) {
        const fileList = Array.from(files || []);
        if (!fileList.length) return;

        // Fall back to flat upload if no relative paths (shouldn't happen with webkitdirectory)
        const hasRelative = fileList.some((f) => f.webkitRelativePath && f.webkitRelativePath.includes('/'));
        if (!hasRelative) {
            handleFiles(files);
            return;
        }

        // Show "preparing" indicator in the upload panel
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

        // Collect unique directory paths sorted shallowest-first
        const uniqueDirs = new Set();
        fileList.forEach((f) => {
            const parts = f.webkitRelativePath.split('/');
            for (let i = 1; i < parts.length; i++) {
                uniqueDirs.add(parts.slice(0, i).join('/'));
            }
        });
        const sortedDirs = Array.from(uniqueDirs).sort((a, b) => a.split('/').length - b.split('/').length);

        // Create each folder in order (parent before child)
        for (const dirPath of sortedDirs) {
            const parts = dirPath.split('/');
            const name = parts[parts.length - 1];
            const parentPath = parts.slice(0, -1).join('/');
            const parentId = parentPath ? (folderMap.get(parentPath) ?? currentFolder) : currentFolder;
            try {
                const created = await API.folders.create(name, parentId || null);
                if (!created || !created.id) throw new Error('no id returned');
                folderMap.set(dirPath, created.id);
            } catch (err) {
                prepItem.remove();
                Components.toast(`Folder "${name}" could not be created: ${err.message}`, 'error');
                return;
            }
        }

        prepItem.remove();

        // Map each file to its target folder id
        const jobs = fileList.map((f) => {
            const parts = f.webkitRelativePath.split('/');
            const dirPath = parts.slice(0, -1).join('/');
            const folderId = folderMap.get(dirPath) ?? currentFolder;
            return { file: f, folderId };
        });

        FileManager.refresh?.();
        addFiles(jobs);
    }

    function addFiles(jobs) {
        if (!jobs.length) return;
        const uploadProgress = document.getElementById('upload-progress');
        const uploadList = document.getElementById('upload-list');
        const uploadCount = document.getElementById('upload-count');

        uploadProgress.classList.remove('hidden');

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
                        setTimeout(() => {
                            document.getElementById('upload-progress').classList.add('hidden');
                            document.getElementById('upload-list').innerHTML = '';
                        }, 1400);
                    }
                });
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

            const formData = new FormData();
            formData.append('name', file.name);
            formData.append('mime_type', file.type || 'application/octet-stream');
            formData.append('original_size', String(file.size));

            let key = null;
            if (canEncrypt) {
                statusEl.textContent = 'Encrypting...';
                key = await cryptoModule.generateKey();
                const originalBuffer = await file.arrayBuffer();
                const { ciphertext, iv } = await cryptoModule.encryptFile(originalBuffer, key);
                const encryptedBlob = new Blob([ciphertext], { type: 'application/octet-stream' });
                formData.append('file', encryptedBlob, file.name);
                formData.append('iv', cryptoModule.uint8ToBase64(iv));
            } else {
                if (!insecureUploadNoticeShown) {
                    insecureUploadNoticeShown = true;
                    Components.toast('HTTPS is not enabled, so files will be uploaded without browser encryption.', 'info', { duration: 7000 });
                }
                formData.append('file', file, file.name);
            }

            const currentFolder = jobFolderId || FileManager.getCurrentFolder?.();
            if (currentFolder) formData.append('folder_id', currentFolder);

            const result = await API.uploadFile(formData, (pct) => {
                progressFill.style.width = `${pct}%`;
                statusEl.textContent = `${pct}%`;
            });

            if (key) await cryptoModule.storeKey(result.id, key);
            progressFill.style.width = '100%';
            statusEl.textContent = 'Done';
            statusEl.style.color = 'var(--fd-green)';

            Components.toast('File uploaded successfully', 'success', {
                actionText: 'Undo',
                onAction: async () => {
                    try {
                        await API.files.delete(result.id);
                        if (cryptoModule?.deleteKey) await cryptoModule.deleteKey(result.id);
                        FileManager.refresh();
                    } catch {
                        Components.toast('Undo failed', 'error');
                    }
                },
                duration: 4000,
            });

            FileManager.afterUpload?.(result, file);
            FileManager.refresh();
        } catch (err) {
            statusEl.textContent = 'Failed';
            statusEl.style.color = 'var(--fd-red)';
            Components.toast(`Upload failed: ${err.message}`, 'error');
        }
    }

    // Read all entries from a DirectoryReader, looping until exhausted.
    // readEntries() returns at most 100 items per call (browser limit).
    function readAllEntries(reader) {
        return new Promise((resolve, reject) => {
            const all = [];
            const next = () =>
                reader.readEntries((batch) => {
                    if (!batch.length) return resolve(all);
                    all.push(...batch);
                    next();
                }, reject);
            next();
        });
    }

    // Accepts FileSystemEntry[] captured synchronously from the drop event.
    async function handleDropEntries(entries) {
        if (!entries.length) return;

        const hasDir = entries.some((e) => e.isDirectory);

        if (!hasDir) {
            // Pure files — fast path
            const files = await Promise.all(
                entries.map((entry) => new Promise((res, rej) => entry.file(res, rej)))
            );
            handleFiles(files);
            return;
        }

        // Mixed or folder-only — show preparing indicator
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
        const fileJobPromises = [];

        async function traverse(entry, parentFolderId) {
            if (entry.isFile) {
                fileJobPromises.push(
                    new Promise((res, rej) =>
                        entry.file((f) => res({ file: f, folderId: parentFolderId }), rej)
                    )
                );
            } else if (entry.isDirectory) {
                let folderId;
                try {
                    const created = await API.folders.create(entry.name, parentFolderId || null);
                    if (!created?.id) throw new Error('no id returned');
                    folderId = created.id;
                } catch (err) {
                    Components.toast(`Folder "${entry.name}" could not be created: ${err.message}`, 'error');
                    return;
                }
                const children = await readAllEntries(entry.createReader());
                await Promise.all(children.map((child) => traverse(child, folderId)));
            }
        }

        try {
            await Promise.all(entries.map((entry) => traverse(entry, currentFolder)));
            const jobs = await Promise.all(fileJobPromises);
            prepItem.remove();
            FileManager.refresh?.();
            addFiles(jobs);
        } catch (err) {
            prepItem.remove();
            Components.toast(`Upload failed: ${err.message}`, 'error');
        }
    }

    return { init, handleFiles, handleFolderFiles, handleDropEntries, addFiles };
})();
