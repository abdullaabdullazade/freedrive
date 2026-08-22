const FileManager = (() => {
    const META_KEY = 'fd_meta_v4';
    const HOME_WARNING_DISMISS_KEY = 'fd_home_warning_dismiss_until';

    let currentFolderId = null;
    let currentPage = 'files';
    let currentView = localStorage.getItem('fd_view') || 'grid';
    let selectedItems = new Set();
    let selectedPrimary = null;
    let selectionAnchor = null;
    let contextTarget = null;
    let allFiles = [];
    let allFolders = [];
    let registeredComputers = [];
    let currentComputerContext = null;
    let filteredFiles = [];
    let filteredFolders = [];
    let folderFilesPageToken = '';
    let folderFilesLoadingMore = false;
    let folderFilesHasMore = false;
    let sortBy = 'modified';
    let sortDir = 'desc';
    let searchDebounce = null;
    let usersCache = [];
    let sharedItemIds = new Set();
    let shareDraft = [];
    let shareTarget = null;
    let editorState = null;
    let dragPayload = null;
    let insecureUploadNoticeShown = false;
    const folderStatsCache = new Map();
    const folderStatsPending = new Map();
    const folderNameCache = new Map();
    let homeSuggestedFolders = [];
    let homeSuggestedFiles = [];
    let homeSuggestedVisible = 0;
    const HOME_SUGGESTED_INITIAL = 6;
    const HOME_SUGGESTED_STEP = 6;
    let searchGlobalCloseBound = false;
    const zipCrcTable = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n += 1) {
            let c = n;
            for (let k = 0; k < 8; k += 1) {
                c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1));
            }
            table[n] = c >>> 0;
        }
        return table;
    })();

    let meta = {
        shares: [],
        offline_ids: [],
        notifications: [],
        descriptions: {},
        file_activity: {},
        general_access: {},
    };

    function init() {
        loadMeta();
        bindTopControls();
        bindListControls();
        bindDetailsControls();
        bindShareControls();
        bindContextMenu();
        bindActivityControls();

        setView(currentView);
        refreshNotificationsBadge();
        loadUsersCache();
        updateStorageInfo();
    }

    function bindTopControls() {
        document.getElementById('view-grid')?.addEventListener('click', () => setView('grid'));
        document.getElementById('view-list')?.addEventListener('click', () => setView('list'));
        document.getElementById('topbar-view-grid')?.addEventListener('click', () => setView('grid'));
        document.getElementById('topbar-view-list')?.addEventListener('click', () => setView('list'));
        document.getElementById('new-folder-btn')?.addEventListener('click', createFolder);
        document.getElementById('empty-bin-btn')?.addEventListener('click', () => emptyBin());
        document.getElementById('home-warning-clean')?.addEventListener('click', () => {
            window.location.hash = '#/storage';
        });
        document.getElementById('home-warning-manage')?.addEventListener('click', async () => {
            try {
                const stats = await API.diskStats();
                const used = Components.formatSize(stats.used_bytes || 0);
                const total = Components.formatSize(stats.total_bytes || 0);
                const free = Components.formatSize((stats.total_bytes || 0) - (stats.used_bytes || 0));
                Components.showModal('System stats', `
                    <div style="display:flex;flex-direction:column;gap:10px;">
                        <div><strong>Disk usage:</strong> ${used} / ${total}</div>
                        <div><strong>Free space:</strong> ${free}</div>
                    </div>
                `, [{ text: 'Close' }]);
            } catch {
                Components.toast('Unable to load system stats', 'error');
            }
        });
        document.getElementById('home-warning-close')?.addEventListener('click', dismissHomeWarning);

        document.querySelectorAll('.md3-chip-wrap').forEach((wrap) => {
            const btn = wrap.querySelector('.md3-chip-btn');
            const menu = wrap.querySelector('.md3-chip-menu');
            if (!btn || !menu) return;
            const textEl = btn.querySelector('.md3-chip-text');
            if (!textEl) return;
            const defaultText = textEl.textContent;
            
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = !menu.classList.contains('hidden');
                document.querySelectorAll('.md3-chip-menu').forEach(m => m.classList.add('hidden'));
                document.querySelectorAll('.md3-chip-btn').forEach(b => b.classList.remove('open'));
                if (!isOpen) {
                    menu.classList.remove('hidden');
                    btn.classList.add('open');
                }
            });

            menu.querySelectorAll('.md3-chip-option').forEach(opt => {
                opt.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const val = opt.dataset.value;
                    const label = opt.textContent;

                    menu.querySelectorAll('.md3-chip-option').forEach(o => o.classList.remove('selected'));
                    opt.classList.add('selected');

                    if (val === '') {
                        textEl.textContent = defaultText;
                        btn.classList.remove('active');
                        wrap.dataset.selectedValue = '';
                    } else {
                        textEl.textContent = label;
                        btn.classList.add('active');
                        wrap.dataset.selectedValue = val;
                    }

                    menu.classList.add('hidden');
                    btn.classList.remove('open');
                    refresh();
                });
            });
        });

        document.addEventListener('click', () => {
            document.querySelectorAll('.md3-chip-menu').forEach(m => m.classList.add('hidden'));
            document.querySelectorAll('.md3-chip-btn').forEach(b => b.classList.remove('open'));
        });

        document.getElementById('search-input')?.addEventListener('input', (e) => {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => {
                const q = e.target.value.trim();
                if (!q) {
                    hideSearchDropdown();
                    refresh();
                    return;
                }
                renderSearchDropdown(q);
            }, 220);
        });

        const searchInput = document.getElementById('search-input');
        searchInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const q = searchInput.value.trim();
                if (q) searchAllResults(q);
            } else if (e.key === 'Escape') {
                hideSearchDropdown();
            }
        });
        searchInput?.addEventListener('focus', () => {
            const q = searchInput.value.trim();
            if (q) renderSearchDropdown(q);
        });
        bindSearchGlobalClose();

        document.querySelectorAll('.sort-col').forEach((btn) => {
            btn.addEventListener('click', () => {
                const key = btn.dataset.sort;
                if (!key) return;
                if (sortBy === key) {
                    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    sortBy = key;
                    sortDir = 'asc';
                }
                updateSortArrows();
                renderItems(filteredFolders, filteredFiles, { keepSelection: true });
            });
        });

        // Click on empty grid area → deselect (panel stays open until X/Escape)
        document.getElementById('file-grid')?.addEventListener('click', (e) => {
            if (e.target.closest('.file-row, .file-card')) return;
            clearSelection();
        });
    }

    function bindListControls() {
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#context-menu')) {
                document.getElementById('context-menu')?.classList.add('hidden');
            }
        });

        document.getElementById('content-area')?.addEventListener('scroll', (e) => {
            document.getElementById('context-menu')?.classList.add('hidden');
            const el = e.target;
            if (!el || folderFilesLoadingMore || !folderFilesHasMore) return;
            if (currentPage !== 'files' && currentPage !== 'computers') return;
            if (currentPage === 'computers' && !currentFolderId) return;
            const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (remaining < 240) {
                loadMoreFolderFiles();
            }
        });
    }

    function bindDetailsControls() {
        document.querySelectorAll('.tab-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset.tab;
                if (!tab) return;
                document.querySelectorAll('.tab-btn').forEach((t) => t.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById('details-properties')?.classList.toggle('hidden', tab !== 'properties');
                document.getElementById('details-activity')?.classList.toggle('hidden', tab !== 'activity');
            });
        });

        document.getElementById('details-name')?.addEventListener('change', async (e) => {
            if (!selectedPrimary) return;
            const newName = e.target.value.trim();
            if (!newName || newName === selectedPrimary.data.name) return;
            try {
                await renameItem(selectedPrimary, newName);
                Components.toast('Renamed', 'success');
                refresh();
            } catch (err) {
                Components.toast(err.message, 'error');
            }
        });
    }

    function bindShareControls() {
        document.getElementById('share-people-input')?.addEventListener('input', (e) => {
            renderShareSuggestions(e.target.value.trim());
        });

        document.getElementById('share-people-input')?.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const value = e.currentTarget.value.trim();
            if (!value) return;
            addShareDraft(value, value, 'viewer');
            e.currentTarget.value = '';
            renderShareSuggestions('');
        });

        document.getElementById('share-general-access')?.addEventListener('change', renderShareModalState);
        document.getElementById('share-link-role')?.addEventListener('change', renderShareModalState);
    }

    function bindContextMenu() {
        document.querySelectorAll('#context-menu .context-item[data-action]').forEach((el) => {
            el.addEventListener('click', async () => {
                document.getElementById('context-menu')?.classList.add('hidden');
                if (!contextTarget) return;
                await handleContextAction(el.dataset.action, contextTarget);
            });
        });
    }

    function bindActivityControls() {
        document.getElementById('activity-filter')?.addEventListener('change', () => {
            if (currentPage === 'activity') {
                loadActivity();
            }
        });
    }

    function loadMeta() {
        try {
            const raw = localStorage.getItem(META_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                meta = { ...meta, ...parsed };
                if (!Array.isArray(meta.shares)) meta.shares = [];
                if (!Array.isArray(meta.offline_ids)) meta.offline_ids = [];
                if (!Array.isArray(meta.notifications)) meta.notifications = [];
                if (typeof meta.descriptions !== 'object' || meta.descriptions === null) meta.descriptions = {};
                if (typeof meta.file_activity !== 'object' || meta.file_activity === null) meta.file_activity = {};
                if (typeof meta.general_access !== 'object' || meta.general_access === null) meta.general_access = {};
            }
        } catch {
            meta = { shares: [], offline_ids: [], notifications: [], descriptions: {}, file_activity: {}, general_access: {} };
        }
    }

    function saveMeta() {
        localStorage.setItem(META_KEY, JSON.stringify(meta));
    }

    function esc(value) {
        return Components.escapeHtml(value || '');
    }

    function getCurrentUser() {
        return API.getUser() || { id: '', username: 'User', email: '' };
    }

    function canWriteFileItem(item) {
        const me = getCurrentUser();
        if (!me?.id || !item) return false;
        if (item.owner_id === me.id) return true;
        const role = item.share_role || permissionToRole(item.share?.permission);
        return role === 'editor';
    }

    function lookupUserLabel(userId) {
        if (!userId) return 'Unknown';
        const me = getCurrentUser();
        if (me?.id && userId === me.id) return me.username || me.email || 'You';
        const hit = usersCache.find((u) => u.id === userId);
        return hit?.label || hit?.email || hit?.username || userId.slice(0, 8);
    }

    async function requestApprovalForFile(file) {
        const email = await Components.prompt('Request approval', '', 'Approver email');
        if (!email || !String(email).trim()) return;
        try {
            await API.approvals.create(file.id, { approver_email: String(email).trim() });
            Components.toast('Approval requested', 'success');
            if (selectedPrimary?.type === 'file' && selectedPrimary.data?.id === file.id) {
                await renderDetailsActivity(selectedPrimary);
            }
        } catch (err) {
            Components.toast(err?.message || 'Failed to request approval', 'error');
        }
    }

    function currentUserLabel() {
        const u = getCurrentUser();
        return u.username || u.email || 'Me';
    }

    function itemOwner(item) {
        if (item.owner_name) return item.owner_name;
        const me = getCurrentUser();
        if (item.owner_id && me.id && item.owner_id === me.id) return currentUserLabel();
        return item.shared_by_name || 'Unknown';
    }

    function isComputerListEntry(item) {
        return currentPage === 'computers'
            && !currentFolderId
            && item
            && item.computer_id;
    }

    async function refreshSharedByMeCache() {
        sharedItemIds = new Set();
        try {
            const data = await API.shares.sharedByMe();
            (data.items || []).forEach((item) => {
                if (item.item_id) sharedItemIds.add(item.item_id);
            });
        } catch {
            sharedItemIds = new Set();
        }
    }

    function isMyDrivePage() {
        return currentPage === 'files' && !currentComputerContext;
    }

    function showSharedBadgeForItem(item) {
        const me = getCurrentUser();
        return isMyDrivePage()
            && !!(me?.id && item.owner_id === me.id)
            && sharedItemIds.has(item.id);
    }

    const SHARED_BADGE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M18 16.08a2.9 2.9 0 0 0-1.96.77L8.91 12.7a2.9 2.9 0 0 0 0-1.39l7.05-4.11A2.99 2.99 0 1 0 15 5a2.9 2.9 0 0 0 .09.7L8.04 9.81A3 3 0 1 0 8 14.19l7.12 4.16a2.96 2.96 0 1 0 2.88-2.27z"/></svg>';

    function renderSharedBadge() {
        return `<span class="file-shared-badge" title="Shared" style="display:inline-flex;align-items:center;margin-left:4px;color:#5f6368;vertical-align:middle;">${SHARED_BADGE_SVG}</span>`;
    }

    function renderOwnerCell(item, options = {}) {
        const me = getCurrentUser();
        const isSharedWith = currentPage === 'shared-with';

        let displayName;
        let isMe = false;

        if (options.labelOverride !== undefined) {
            displayName = options.labelOverride;
            isMe = String(displayName).toLowerCase() === 'me'
                || !!(item.owner_id && me.id && item.owner_id === me.id);
        } else if (isSharedWith) {
            displayName = item.shared_by_name || item.shared_by_email || itemOwner(item);
            isMe = !!(item.shared_by_id && me.id && item.shared_by_id === me.id);
        } else {
            isMe = !!(item.owner_id && me.id && item.owner_id === me.id);
            displayName = isMe ? 'me' : itemOwner(item);
        }

        if (isMe) displayName = 'me';

        const showPhoto = isMe && !!getMyProfileAvatar();
        const seed = isMe
            ? (me.username || me.email || 'me')
            : String(displayName || 'U');
        const hue = (seed.length * 137) % 360;
        const initials = esc(Components.initials(isMe ? (me.username || me.email || 'me') : displayName));

        return `<span class="owner-avatar${showPhoto ? ' has-avatar' : ''}"${showPhoto ? '' : ` style="background-color:hsl(${hue},60%,50%)"`}>${showPhoto ? '' : initials}</span><span class="owner-name">${esc(displayName)}</span>`;
    }

    function getMyProfileAvatar() {
        try {
            return JSON.parse(localStorage.getItem('fd_user_prefs') || '{}').profileAvatar || '';
        } catch {
            return '';
        }
    }

    function formatSizeStrict(bytes) {
        const value = Number(bytes || 0);
        if (!Number.isFinite(value) || value < 0) return '—';
        if (value === 0) return '0 B';
        return Components.formatSize(value);
    }

    async function calculateFolderStats(folderID, visited = new Set()) {
        if (!folderID || visited.has(folderID)) {
            return { bytes: 0, files: 0, folders: 0 };
        }

        if (folderStatsCache.has(folderID)) {
            return folderStatsCache.get(folderID);
        }

        if (folderStatsPending.has(folderID)) {
            return folderStatsPending.get(folderID);
        }

        visited.add(folderID);

        const pending = (async () => {
            const contents = await API.folders.getAll(folderID);
            const files = Array.isArray(contents.files) ? contents.files : [];
            const folders = Array.isArray(contents.folders) ? contents.folders : [];

            let bytes = 0;
            let fileCount = 0;
            let folderCount = folders.length;

            files.forEach((f) => {
                bytes += Number(f.size || 0);
                fileCount += 1;
            });

            for (const child of folders) {
                const nested = await calculateFolderStats(child.id, visited);
                bytes += nested.bytes;
                fileCount += nested.files;
                folderCount += nested.folders;
            }

            const stats = { bytes, files: fileCount, folders: folderCount };
            folderStatsCache.set(folderID, stats);
            return stats;
        })()
            .finally(() => {
                folderStatsPending.delete(folderID);
            });

        folderStatsPending.set(folderID, pending);
        return pending;
    }

    function getFileExtension(name) {
        if (!name || typeof name !== 'string') return '';
        const idx = name.lastIndexOf('.');
        if (idx < 0 || idx === name.length - 1) return '';
        return name.slice(idx + 1).toLowerCase();
    }

    function isJsonMimeOrName(mime, name) {
        const mt = String(mime || '').toLowerCase();
        const ext = getFileExtension(name);
        return mt === 'application/json' || mt === 'text/json' || ext === 'json';
    }

    function isSpreadsheetMimeOrName(mime, name) {
        const mt = String(mime || '').toLowerCase();
        const ext = getFileExtension(name);
        return mt.includes('csv')
            || mt.includes('spreadsheet')
            || mt.includes('ms-excel')
            || mt.includes('spreadsheetml')
            || ext === 'csv'
            || ext === 'tsv'
            || ext === 'xls'
            || ext === 'xlsx';
    }

    function getMimeGroup(mime, type, name = '') {
        if (type === 'folder') return 'folder';
        const mt = String(mime || '').toLowerCase();
        const ext = getFileExtension(name);
        if (!mt && !ext) return 'document';
        if (mt.startsWith('image/')) return 'image';
        if (mt.startsWith('video/')) return 'video';
        if (mt.startsWith('audio/')) return 'audio';
        if (mt === 'application/pdf' || ext === 'pdf') return 'pdf';
        if (mt.includes('presentation') || mt.includes('powerpoint') || ['ppt', 'pptx', 'odp', 'key'].includes(ext)) return 'presentation';
        if (mt.includes('zip') || mt.includes('rar') || mt.includes('gzip') || ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
        if (isSpreadsheetMimeOrName(mt, name)) return 'sheet';
        if (isJsonMimeOrName(mt, name)) return 'text';
        if (mt.startsWith('text/')) return 'text';
        if ([
            'txt', 'md', 'markdown', 'log', 'ini', 'cfg', 'conf', 'yml', 'yaml', 'toml',
            'xml', 'html', 'css', 'js', 'ts', 'jsx', 'tsx', 'jsonc', 
            'py', 'c', 'cpp', 'h', 'hpp', 'sh', 'bash', 'go', 'java', 'php', 'rb', 'swift'
        ].includes(ext)) return 'text';
        return 'document';
    }

    // Classifier for the Storage breakdown: maps a file to one of the four
    // fixed buckets using both mime type and extension. Unknown types (audio,
    // archives, binaries, fonts, ...) fall into 'Other' rather than Documents.
    function getStorageCategory(mime, name) {
        const mt = String(mime || '').toLowerCase();
        const ext = getFileExtension(name);
        const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'heif', 'avif', 'raw', 'cr2', 'nef', 'arw', 'dng', 'psd']);
        const VIDEO = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'm2ts', 'ogv', 'mts']);
        const DOC = new Set([
            'pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'markdown', 'pages',
            'ppt', 'pptx', 'odp', 'key',
            'xls', 'xlsx', 'ods', 'csv', 'tsv', 'numbers',
            'json', 'jsonc', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx',
            'py', 'c', 'cpp', 'h', 'hpp', 'sh', 'bash', 'go', 'java', 'php', 'rb', 'swift',
            'ini', 'cfg', 'conf', 'yml', 'yaml', 'toml', 'log',
        ]);
        if (mt.startsWith('image/') || IMAGE.has(ext)) return 'Images';
        if (mt.startsWith('video/') || VIDEO.has(ext)) return 'Videos';
        if (mt === 'application/pdf'
            || mt.startsWith('text/')
            || mt.includes('word') || mt.includes('opendocument')
            || mt.includes('spreadsheet') || mt.includes('ms-excel') || mt.includes('spreadsheetml')
            || mt.includes('presentation') || mt.includes('powerpoint')
            || mt === 'application/json'
            || DOC.has(ext)) return 'Documents';
        return 'Other';
    }

    function getIcon(type, mime, name = '') {
        const group = getMimeGroup(mime, type, name);
        const ext = getFileExtension(name);
        // #11 - Colored icons by file type
        if (type === 'file' && ['yaml', 'yml', 'nix', 'patch'].includes(ext)) {
            return '<svg viewBox="0 0 24 24" width="20" height="20" fill="#6f7378"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 3.5V9h5.5" fill="#fff"/><path d="M8 12h8v1.4H8zm0 2.8h8v1.4H8zm0 2.8h5v1.4H8z" fill="#fff"/></svg>';
        }
        if (type === 'file' && ['js', 'ts', 'jsx', 'tsx'].includes(ext)) {
            return '<svg viewBox="0 0 24 24" width="20" height="20" fill="#fbbc05"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 3.5V9h5.5" fill="#fff"/><text x="8" y="16.5" font-size="6" font-family="Arial" font-weight="bold" fill="#fff">JS</text></svg>';
        }
        if (type === 'file' && ['py', 'css', 'html'].includes(ext)) {
            return `<svg viewBox="0 0 24 24" width="20" height="20" fill="#4285f4"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 3.5V9h5.5" fill="#fff"/><text x="6.5" y="16.5" font-size="5" font-family="Arial" font-weight="bold" fill="#fff">${ext.toUpperCase()}</text></svg>`;
        }
        if (type === 'file' && ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(ext)) {
            return '<svg viewBox="0 0 24 24" width="20" height="20" fill="#34a853"><path d="M21 19V5c0-1.1-.9-2-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2zM8.5 11.5A1.5 1.5 0 1 1 8.5 8a1.5 1.5 0 0 1 0 3.5zM5 18l3.5-4.5 2.5 3 3.5-4.5 4.5 6H5z"/></svg>';
        }
        if (type === 'file' && ['json', 'jsonc'].includes(ext)) {
            return '<svg viewBox="0 0 24 24" width="20" height="20" fill="#4285f4"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 3.5V9h5.5" fill="#fff"/><path d="M8 12h8v1.6H8zm0 3h8v1.6H8zm0 3h5v1.6H8z" fill="#fff"/></svg>';
        }
        if (type === 'file' && ['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz'].includes(ext)) {
            return '<svg viewBox="0 0 24 24" width="20" height="20" fill="#5f6368"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-2 6h-2v2h2v2h-2v2h-2v-2h2v-2h-2v-2h2v-2h-2V8h2v2h2v2z"/></svg>';
        }
        const icons = {
            folder: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#5f6368"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
            image: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#34a853"><path d="M21 19V5c0-1.1-.9-2-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2zM8.5 11.5A1.5 1.5 0 1 1 8.5 8a1.5 1.5 0 0 1 0 3.5zM5 18l3.5-4.5 2.5 3 3.5-4.5 4.5 6H5z"/></svg>',
            video: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#ea4335"><path d="M17 10.5V7c0-1.1-.9-2-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10c1.1 0 2-.9 2-2v-3.5l4 4v-11l-4 4z"/></svg>',
            audio: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#a142f4"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55a4 4 0 1 0 4 4V7h4V3h-6z"/></svg>',
            pdf: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#ea4335"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 3.5V9h5.5" fill="#fff"/><path d="M8 17h1v-1h1.2a1.8 1.8 0 1 0 0-3.6H8V17zm1-2v-1.6h1.1a.8.8 0 1 1 0 1.6H9zm3 2h2.2a1.9 1.9 0 0 0 0-3.8H12V17zm1-1v-1.8h1.1a.9.9 0 1 1 0 1.8H13zm4 1h1v-1.5h1.4v-1H18v-.6h1.7v-1H17V17z" fill="#fff"/></svg>',
            sheet: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#34a853"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 3.5V9h5.5" fill="#fff"/><path d="M8 11h8v2H8zm0 3h8v2H8zm0 3h5v2H8z" fill="#fff"/></svg>',
            text: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#4285f4"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 3.5V9h5.5" fill="#fff"/><path d="M8 12h8v1.6H8zm0 3h8v1.6H8zm0 3h5v1.6H8z" fill="#fff"/></svg>',
            document: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#5f6368"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 3.5V9h5.5" fill="#fff"/><path d="M8 12h8v1.6H8zm0 3h8v1.6H8zm0 3h5v1.6H8z" fill="#fff"/></svg>',
        };
        return icons[group] || icons.document;
    }

    async function loadUsersCache() {
        usersCache = [];
        try {
            const me = getCurrentUser();
            usersCache.push({
                id: me.id,
                email: me.email,
                username: me.username,
                avatar_url: me.avatar_url,
                label: me.username || me.email,
            });
            if (me.role === 'admin') {
                const resp = await API.admin.users();
                const users = resp.users || [];
                users.forEach((u) => {
                    usersCache.push({
                        id: u.id,
                        email: u.email,
                        username: u.username,
                        avatar_url: u.avatar_url,
                        label: u.username ? `${u.username} (${u.email})` : u.email,
                    });
                });
            }
        } catch {
            // fallback silently
        }
    }

    function showFilesView() {
        document.getElementById('app')?.classList.remove('home-active');
        document.getElementById('home-page')?.classList.add('hidden');
        document.getElementById('activity-page')?.classList.add('hidden');
        document.getElementById('storage-page')?.classList.add('hidden');
        document.getElementById('md3-chip-bar')?.classList.add('hidden');
        document.getElementById('file-grid')?.classList.remove('hidden');
        if (currentView === 'list') {
            document.getElementById('file-list-header')?.classList.remove('hidden');
        }
        if (currentPage !== 'home') hideHomeWarning();
        updateTrashBinBanner();
    }

    function showActivityView() {
        document.getElementById('app')?.classList.remove('home-active');
        document.getElementById('home-page')?.classList.add('hidden');
        document.getElementById('activity-page')?.classList.remove('hidden');
        document.getElementById('storage-page')?.classList.add('hidden');
        document.getElementById('md3-chip-bar')?.classList.add('hidden');
        document.getElementById('file-list-header')?.classList.add('hidden');
        document.getElementById('file-grid')?.classList.add('hidden');
        document.getElementById('shared-filter-bar')?.classList.add('hidden');
        document.getElementById('empty-state')?.classList.add('hidden');
        document.getElementById('loading-state')?.classList.add('hidden');
        hideHomeWarning();
        document.getElementById('trash-bin-banner')?.classList.add('hidden');
    }

    function showStorageView() {
        document.getElementById('app')?.classList.remove('home-active');
        document.getElementById('home-page')?.classList.add('hidden');
        document.getElementById('storage-page')?.classList.remove('hidden');
        document.getElementById('activity-page')?.classList.add('hidden');
        document.getElementById('md3-chip-bar')?.classList.add('hidden');
        document.getElementById('file-list-header')?.classList.add('hidden');
        document.getElementById('file-grid')?.classList.add('hidden');
        document.getElementById('shared-filter-bar')?.classList.add('hidden');
        document.getElementById('empty-state')?.classList.add('hidden');
        document.getElementById('loading-state')?.classList.add('hidden');
        hideHomeWarning();
        document.getElementById('trash-bin-banner')?.classList.add('hidden');
    }

    function showHomeView() {
        document.getElementById('app')?.classList.add('home-active');
        document.getElementById('home-page')?.classList.remove('hidden');
        document.getElementById('activity-page')?.classList.add('hidden');
        document.getElementById('storage-page')?.classList.add('hidden');
        document.getElementById('md3-chip-bar')?.classList.add('hidden');
        document.getElementById('file-list-header')?.classList.add('hidden');
        document.getElementById('file-grid')?.classList.add('hidden');
        document.getElementById('shared-filter-bar')?.classList.add('hidden');
        document.getElementById('empty-state')?.classList.add('hidden');
        document.getElementById('loading-state')?.classList.add('hidden');
        document.getElementById('trash-bin-banner')?.classList.add('hidden');
    }

    function hideHomeWarning() {
        document.getElementById('home-warning')?.classList.add('hidden');
    }

    function dismissHomeWarning() {
        const until = Date.now() + (12 * 60 * 60 * 1000);
        localStorage.setItem(HOME_WARNING_DISMISS_KEY, String(until));
        hideHomeWarning();
    }

    function isHomeWarningDismissed() {
        const until = Number(localStorage.getItem(HOME_WARNING_DISMISS_KEY) || 0);
        return until > Date.now();
    }

    async function renderHomeWarning() {
        const warning = document.getElementById('home-warning');
        const text = document.getElementById('home-warning-text');
        if (!warning || !text) return;
        if (currentPage !== 'home' || isHomeWarningDismissed()) {
            warning.classList.add('hidden');
            return;
        }
        try {
            const stats = await API.diskStats();
            const used = Number(stats.used_bytes || 0);
            const total = Number(stats.total_bytes || 0);
            if (!total) {
                warning.classList.add('hidden');
                return;
            }
            const pct = (used / total) * 100;
            if (pct < 75) {
                warning.classList.add('hidden');
                return;
            }
            text.innerHTML = `
                <span class="home-warning-icon">⚠</span>
                <span><strong>${Math.round(pct)}% of storage used.</strong> If you run out, you can't create, edit, and upload files.</span>
            `;
            warning.classList.remove('hidden');
        } catch {
            warning.classList.add('hidden');
        }
    }

    function getPageHeaderEl() {
        return document.getElementById('page-header-content');
    }

    function setBreadcrumbText(text) {
        const el = getPageHeaderEl();
        if (!el) return;
        el.innerHTML = `<h1 class="page-hero-title">${esc(text)}</h1>`;
    }

    function setBreadcrumbHtml(html) {
        const el = getPageHeaderEl();
        if (!el) return;
        el.innerHTML = `<nav class="page-hero-breadcrumb breadcrumb" aria-label="Breadcrumb">${html}</nav>`;
    }

    function syncPageActions() {
        document.querySelector('.new-btn-wrap')?.classList.remove('hidden');
    }

    function folderNavHash(folderId) {
        if (currentPage === 'computers') return `#/computers/${folderId}`;
        return `#/files/${folderId}`;
    }

    function canAcceptUploads() {
        return !(currentPage === 'computers' && !currentFolderId);
    }

    async function ensureComputersLoaded() {
        if (registeredComputers.length) return registeredComputers;
        try {
            const data = await API.computers.list();
            registeredComputers = Array.isArray(data.computers) ? data.computers : [];
        } catch {
            registeredComputers = [];
        }
        return registeredComputers;
    }

    function findComputerByRootFolderId(folderId) {
        return registeredComputers.find((c) => c.root_folder_id === folderId) || null;
    }

    async function ensureComputerContext(folderId) {
        await ensureComputersLoaded();
        if (!folderId) {
            currentComputerContext = null;
            return null;
        }

        let comp = findComputerByRootFolderId(folderId);
        if (!comp) {
            try {
                const data = await API.folders.breadcrumb(folderId);
                const crumbs = data.breadcrumb || [];
                if (crumbs.length) comp = findComputerByRootFolderId(crumbs[0].id);
            } catch {
                comp = null;
            }
        }
        currentComputerContext = comp;
        return comp;
    }

    async function updateComputerBreadcrumb(folderId) {
        let html = '<a href="#/computers" class="breadcrumb-item">Computers</a>';
        if (!folderId) {
            setBreadcrumbHtml(html);
            return;
        }

        const comp = await ensureComputerContext(folderId);
        if (!comp) {
            setBreadcrumbHtml(html);
            return;
        }

        try {
            const data = await API.folders.breadcrumb(folderId);
            const crumbs = data.breadcrumb || [];
            const subCrumbs = crumbs[0]?.id === comp.root_folder_id ? crumbs.slice(1) : crumbs;

            html += '<span class="breadcrumb-sep">›</span>';
            if (!subCrumbs.length) {
                html += `<span class="breadcrumb-item">${esc(comp.name)}</span>`;
            } else {
                html += `<a href="#/computers/${comp.root_folder_id}" class="breadcrumb-item">${esc(comp.name)}</a>`;
                subCrumbs.forEach((c, idx) => {
                    html += '<span class="breadcrumb-sep">›</span>';
                    if (idx === subCrumbs.length - 1) {
                        html += `<span class="breadcrumb-item">${esc(c.name)}</span>`;
                    } else {
                        html += `<a href="#/computers/${c.id}" class="breadcrumb-item">${esc(c.name)}</a>`;
                    }
                });
            }
            setBreadcrumbHtml(html);
        } catch {
            setBreadcrumbHtml(html);
        }
    }

    function renderComputersEmptyState() {
        const grid = document.getElementById('file-grid');
        const empty = document.getElementById('empty-state');
        const header = document.getElementById('file-list-header');

        grid.innerHTML = '';
        grid.classList.add('hidden');
        header?.classList.add('hidden');
        empty?.classList.remove('hidden');
        document.getElementById('empty-title').textContent = 'No computers registered';
        document.getElementById('empty-desc').textContent =
            'Register a computer from the API or a future desktop client to back up files here.';
        updateSelectionUI();
    }

    async function updateBreadcrumb(folderId) {
        if (!folderId) {
            setBreadcrumbText('My Drive');
            return;
        }

        let html = '<a href="#/files" class="breadcrumb-item">My Drive</a>';
        try {
            const data = await API.folders.breadcrumb(folderId);
            const crumbs = data.breadcrumb || [];
            crumbs.forEach((c, idx) => {
                html += '<span class="breadcrumb-sep">›</span>';
                if (idx === crumbs.length - 1) {
                    html += `<span class="breadcrumb-item">${esc(c.name)}</span>`;
                } else {
                    html += `<a href="#/files/${c.id}" class="breadcrumb-item">${esc(c.name)}</a>`;
                }
            });
            setBreadcrumbHtml(html);
        } catch {
            setBreadcrumbHtml(html);
        }
    }

    async function loadFolder(folderId) {
        currentPage = 'files';
        currentFolderId = folderId || null;
        currentComputerContext = null;
        clearSelection();
        showFilesView();
        showLoading(true);
        syncPageActions();
        folderFilesPageToken = '';
        folderFilesHasMore = false;

        try {
            const opts = { page_size: 100 };
            const data = folderId ? await API.folders.get(folderId, opts) : await API.folders.root(opts);
            allFolders = Array.isArray(data.folders) ? data.folders : [];
            allFiles = Array.isArray(data.files) ? data.files : [];
            // #8 - Remove duplicate filenames, keep only first occurrence
            const seenNames = new Set();
            allFiles = allFiles.filter(f => {
                if (seenNames.has(f.name)) return false;
                seenNames.add(f.name);
                return true;
            });
            folderFilesPageToken = data.next_page_token || '';
            folderFilesHasMore = Boolean(folderFilesPageToken);
            filteredFolders = [...allFolders];
            filteredFiles = [...allFiles];
            await refreshSharedByMeCache();
            renderItems(filteredFolders, filteredFiles);
            HOME_CHIP_DEFS.forEach((d) => setFilterSelect(d.select, '', d.anyLabel));
            renderSearchChipBar();
            await updateBreadcrumb(folderId || null);
            await updateStorageInfo();
            syncTrashActionLabels();
        } catch (err) {
            Components.toast(`Failed to load files: ${err.message}`, 'error');
        } finally {
            showLoading(false);
        }
    }

    async function loadMoreFolderFiles() {
        if (folderFilesLoadingMore || !folderFilesHasMore || !folderFilesPageToken) return;
        if (currentPage !== 'files' && currentPage !== 'computers') return;
        if (currentPage === 'computers' && !currentFolderId) return;
        folderFilesLoadingMore = true;
        try {
            const opts = { page_size: 100, page_token: folderFilesPageToken };
            const data = currentFolderId
                ? await API.folders.get(currentFolderId, opts)
                : await API.folders.root(opts);
            const more = Array.isArray(data.files) ? data.files : [];
            const seenNames = new Set(allFiles.map((f) => f.name));
            for (const f of more) {
                if (seenNames.has(f.name)) continue;
                seenNames.add(f.name);
                allFiles.push(f);
            }
            folderFilesPageToken = data.next_page_token || '';
            folderFilesHasMore = Boolean(folderFilesPageToken);
            filteredFolders = [...allFolders];
            filteredFiles = [...allFiles];
            renderItems(filteredFolders, filteredFiles);
        } catch (err) {
            Components.toast(`Failed to load more files: ${err.message}`, 'error');
        } finally {
            folderFilesLoadingMore = false;
        }
    }

    async function loadComputers() {
        currentPage = 'computers';
        currentFolderId = null;
        currentComputerContext = null;
        clearSelection();
        showFilesView();
        showLoading(true);
        syncPageActions();
        setBreadcrumbText('Computers');

        try {
            const data = await API.computers.list();
            registeredComputers = data.computers || [];
            allFiles = [];
            allFolders = registeredComputers
                .filter((c) => c.root_folder_id)
                .map((c) => ({
                    id: c.root_folder_id,
                    owner_id: c.owner_id,
                    name: c.name || c.hostname || 'Computer',
                    mime_type: 'application/x-freedrive-computer',
                    updated_at: c.last_seen_at || c.updated_at || c.created_at,
                    created_at: c.created_at,
                    computer_id: c.id,
                }));
            filteredFolders = [...allFolders];
            filteredFiles = [];

            if (!allFolders.length) {
                renderComputersEmptyState();
            } else {
                const grid = document.getElementById('file-grid');
                const empty = document.getElementById('empty-state');
                const header = document.getElementById('file-list-header');
                grid?.classList.remove('hidden');
                empty?.classList.add('hidden');
                header?.classList.remove('hidden');
                renderItems(filteredFolders, filteredFiles);
            }
            await updateStorageInfo();
            syncTrashActionLabels();
            syncToolbarSlot();
        } catch (err) {
            Components.toast(`Failed to load computers: ${err.message}`, 'error');
            renderComputersEmptyState();
        } finally {
            showLoading(false);
        }
    }

    async function loadComputerFolder(folderId) {
        currentPage = 'computers';
        currentFolderId = folderId || null;
        clearSelection();
        showFilesView();
        showLoading(true);
        syncPageActions();

        if (!folderId) {
            return loadComputers();
        }

        await ensureComputerContext(folderId);
        try {
            folderFilesPageToken = '';
            folderFilesHasMore = false;
            const data = await API.folders.get(folderId, { page_size: 100 });
            allFolders = Array.isArray(data.folders) ? data.folders : [];
            allFiles = Array.isArray(data.files) ? data.files : [];
            folderFilesPageToken = data.next_page_token || '';
            folderFilesHasMore = Boolean(folderFilesPageToken);
            filteredFolders = [...allFolders];
            filteredFiles = [...allFiles];
            renderItems(filteredFolders, filteredFiles);
            await updateComputerBreadcrumb(folderId);
            if (currentComputerContext?.id) {
                API.computers.heartbeat(currentComputerContext.id).catch(() => {});
            }
            await updateStorageInfo();
            syncTrashActionLabels();
            syncToolbarSlot();
        } catch (err) {
            Components.toast(`Failed to load computer folder: ${err.message}`, 'error');
            await loadComputers();
        } finally {
            showLoading(false);
        }
    }

    async function loadHome() {
        currentPage = 'home';
        currentFolderId = null;
        clearSelection();
        showHomeView();
        const searchInput = document.getElementById('search-input');
        if (searchInput) searchInput.value = '';
        document.getElementById('search-filter-panel')?.classList.add('hidden');
        hideSearchDropdown();
        homeSuggestedVisible = HOME_SUGGESTED_INITIAL;
        showLoading(true);
        try {
            const data = await API.files.list({ sort: 'accessed_at', dir: 'desc', page_size: '60' });
            allFolders = [];
            allFiles = data.files || [];
            // #8 - Remove duplicate filenames, keep only first occurrence
            const seenNames = new Set();
            allFiles = allFiles.filter(f => {
                if (seenNames.has(f.name)) return false;
                seenNames.add(f.name);
                return true;
            });

            // Fetch top-level folders for the "Suggested folders" section and to
            // seed the location-name cache used by the live search dropdown.
            homeSuggestedFolders = [];
            try {
                const root = await API.folders.root();
                const rootFolders = Array.isArray(root.folders) ? root.folders : [];
                rootFolders.forEach((f) => { if (f && f.id) folderNameCache.set(f.id, f.name); });
                homeSuggestedFolders = [...rootFolders].sort((a, b) =>
                    new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
            } catch { /* folders optional */ }

            const flt = filterCollections(allFolders, allFiles);
            filteredFolders = flt.folders;
            filteredFiles = flt.files;

            renderHomeItems(filteredFiles, homeSuggestedFolders);
            setBreadcrumbText('Welcome to FreeDrive');
            await renderHomeWarning();
        } catch {
            Components.toast('Failed to load Home', 'error');
            hideHomeWarning();
        } finally {
            showLoading(false);
        }
    }

    // Filter chips shown under the Home search box. They mirror the hidden
    // #filter-* <select> elements used by applyAdvancedSearch().
    const HOME_CHIP_DEFS = [
        { key: 'type', label: 'Type', select: 'filter-type', anyLabel: 'Any', options: ['Photos', 'Documents', 'Spreadsheets', 'PDFs', 'Presentations', 'Videos', 'Audio', 'Archives', 'Folders'] },
        { key: 'people', label: 'People', select: 'filter-owner', anyLabel: 'Anyone', options: ['Me', 'Not me'] },
        { key: 'modified', label: 'Modified', select: 'filter-modified', anyLabel: 'Any time', options: ['Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'Last 90 days'] },
        { key: 'location', label: 'Location', select: 'filter-location', anyLabel: 'Anywhere', options: ['My Drive', 'Shared with me', 'Computers'] },
    ];

    function resetAdvancedSearchForm() {
        const searchInput = document.getElementById('search-input');
        if (searchInput) searchInput.value = '';
        setFilterSelect('filter-type', '', 'Any');
        setFilterSelect('filter-owner', 'Anyone', 'Anyone');
        setFilterSelect('filter-modified', 'Any time', 'Any time');
        setFilterSelect('filter-location', 'Anywhere', 'Anywhere');
        setFilterSelect('filter-followups', '-', '-');
        const words = document.getElementById('filter-words');
        const itemName = document.getElementById('filter-item-name');
        const ownerEmail = document.getElementById('filter-owner-email');
        const sharedTo = document.getElementById('filter-shared-to');
        const modFrom = document.getElementById('filter-modified-from');
        const modTo = document.getElementById('filter-modified-to');
        if (words) words.value = '';
        if (itemName) itemName.value = '';
        if (ownerEmail) ownerEmail.value = '';
        if (sharedTo) sharedTo.value = '';
        if (modFrom) modFrom.value = '';
        if (modTo) modTo.value = '';
        ['filter-location-bin', 'filter-location-starred', 'filter-location-encrypted', 'filter-approval-awaiting', 'filter-approval-requested'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.checked = false;
        });
        syncAdvancedSearchDependentFields();
    }

    function syncAdvancedSearchDependentFields() {
        const owner = document.getElementById('filter-owner')?.value || 'Anyone';
        const modified = document.getElementById('filter-modified')?.value || 'Any time';
        document.getElementById('filter-owner-email')?.classList.toggle('hidden', owner !== 'Specific person');
        document.getElementById('filter-modified-custom')?.classList.toggle('hidden', modified !== 'Custom');
    }

    function showAdvancedSearchHelp() {
        Components.toast(
            'Includes the words searches file names and comments, not encrypted file contents. Approvals use a simplified workflow. More locations folder picker is coming soon.',
            'info',
        );
    }

    function collectAdvancedSearchParams() {
        const q = document.getElementById('search-input')?.value?.trim() || '';
        const name = document.getElementById('filter-item-name')?.value?.trim() || '';
        const words = document.getElementById('filter-words')?.value?.trim() || '';
        const type = document.getElementById('filter-type')?.value || '';
        const owner = document.getElementById('filter-owner')?.value || 'Anyone';
        const ownerEmail = document.getElementById('filter-owner-email')?.value?.trim() || '';
        const location = document.getElementById('filter-location')?.value || 'Anywhere';
        const modified = document.getElementById('filter-modified')?.value || 'Any time';
        const sharedTo = document.getElementById('filter-shared-to')?.value?.trim() || '';
        const followups = document.getElementById('filter-followups')?.value || '-';

        const params = {
            page_size: '100',
        };
        if (q) params.q = q;
        if (name) params.name = name;
        if (words) params.words = words;
        if (type) params.type = type;
        if (owner && owner !== 'Anyone') params.owner = owner;
        if (owner === 'Specific person' && ownerEmail) params.owner_email = ownerEmail;
        if (location && location !== 'Anywhere') params.location = location;
        if (sharedTo) params.shared_to = sharedTo;
        if (followups && followups !== '-') params.followups = followups;

        if (document.getElementById('filter-location-bin')?.checked) params.in_trash = 'true';
        if (document.getElementById('filter-location-starred')?.checked) params.starred = 'true';
        if (document.getElementById('filter-location-encrypted')?.checked) params.encrypted = 'true';
        if (document.getElementById('filter-approval-awaiting')?.checked) params.approval_awaiting = 'true';
        if (document.getElementById('filter-approval-requested')?.checked) params.approval_requested = 'true';

        if (modified === 'Custom') {
            const from = document.getElementById('filter-modified-from')?.value || '';
            const to = document.getElementById('filter-modified-to')?.value || '';
            params.modified = 'Custom';
            if (from) params.modified_from = from;
            if (to) params.modified_to = to;
        } else if (modified !== 'Any time') {
            params.modified = modified;
        }

        return params;
    }

    function homeChipHtml(defs, options = {}) {
        const withClear = !!options.withClear;
        const caretSvg = '<span class="gd-chip-caret"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg></span>';
        const clearSvg = '<span class="gd-chip-clear" role="button" aria-label="Clear filter"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></span>';
        return defs.map((d) => {
            const sel = document.getElementById(d.select);
            const current = sel && sel.value && sel.value !== d.anyLabel ? sel.value : '';
            const active = current ? ' active' : '';
            const label = current || d.label;
            const trailing = (withClear && current) ? clearSvg : caretSvg;
            const opts = `<button class="gd-chip-option" data-value="">${esc(d.anyLabel)}</button>` +
                d.options.map((o) => `<button class="gd-chip-option" data-value="${esc(o)}">${esc(o)}</button>`).join('');
            return `
                <div class="gd-chip${active}" data-chip="${d.key}" data-select="${d.select}" data-any="${esc(d.anyLabel)}" data-label="${esc(d.label)}">
                    <button class="gd-chip-btn" type="button">
                        <span class="gd-chip-text">${esc(label)}</span>
                        ${trailing}
                    </button>
                    <div class="gd-chip-menu hidden">${opts}</div>
                </div>`;
        }).join('');
    }

    function formatHomeReason(item) {
        const created = item.created_at ? new Date(item.created_at).getTime() : 0;
        const accessed = item.accessed_at ? new Date(item.accessed_at).getTime() : 0;
        const opened = accessed > created + 60000;
        const when = new Date(opened
            ? (item.accessed_at || item.updated_at || item.created_at)
            : (item.created_at || item.updated_at || item.accessed_at));
        return `${opened ? 'You opened' : 'You created'} \u00b7 ${formatHomeReasonDate(when)}`;
    }

    function formatHomeReasonDate(d) {
        if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '—';
        const now = new Date();
        const sameDay = d.getFullYear() === now.getFullYear()
            && d.getMonth() === now.getMonth()
            && d.getDate() === now.getDate();
        if (sameDay) {
            return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
        }
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const day = d.getDate();
        const mon = months[d.getMonth()];
        if (d.getFullYear() !== now.getFullYear()) return `${day} ${mon} ${d.getFullYear()}`;
        return `${day} ${mon}`;
    }

    function renderHomeItems(files, folders) {
        const homePage = document.getElementById('home-page');
        if (!homePage) return;

        document.getElementById('file-list-header')?.classList.add('hidden');

        const justFiles = files.filter(f => f.mime_type !== 'folder' && !f.isDir);
        const suggestedFiles = [...justFiles].sort((a, b) =>
            new Date(b.accessed_at || b.updated_at || b.created_at || 0)
            - new Date(a.accessed_at || a.updated_at || a.created_at || 0));
        const suggestedFolders = (Array.isArray(folders) ? folders : []).slice(0, 6);

        homeSuggestedFiles = suggestedFiles;
        homeSuggestedVisible = HOME_SUGGESTED_INITIAL;
        const initialCards = suggestedFiles.slice(0, HOME_SUGGESTED_INITIAL);
        const showViewMore = suggestedFiles.length > HOME_SUGGESTED_INITIAL;
        const useList = currentView === 'list';

        let html = '';

        if (suggestedFolders.length > 0) {
            html += `
                <h3 class="gd-home-section-title collapsible" data-target="gd-suggested-grid"><span class="caret">▾</span> Suggested folders</h3>
                <div class="gd-suggested-grid" id="gd-suggested-grid"></div>
            `;
        }

        if (initialCards.length > 0) {
            if (useList) {
                html += `
                    <h3 class="gd-home-section-title collapsible" data-target="gd-home-suggested-wrap"><span class="caret">▾</span> Suggested files</h3>
                    <div id="gd-home-suggested-wrap">
                        <div class="file-list-header gd-home-list-header">
                            <div class="col-name">Name</div>
                            <div class="col-owner">Reason suggested</div>
                            <div class="col-date">Owner</div>
                            <div class="col-size">Location</div>
                            <div class="col-actions"></div>
                        </div>
                        <div class="file-grid gd-home-recent-list" id="gd-home-suggested-list"></div>
                        ${showViewMore ? '<div class="gd-home-viewmore"><button type="button" class="gd-viewmore-link" id="home-view-more-btn">View more</button></div>' : ''}
                    </div>
                `;
            } else {
                html += `
                    <h3 class="gd-home-section-title collapsible" data-target="gd-home-suggested-wrap"><span class="caret">▾</span> Suggested files</h3>
                    <div id="gd-home-suggested-wrap">
                        <div class="file-grid grid-view" id="gd-home-suggested-cards"></div>
                        ${showViewMore ? '<div class="gd-home-viewmore"><button type="button" class="gd-viewmore-link" id="home-view-more-btn">View more</button></div>' : ''}
                    </div>
                `;
            }
        }

        if (!suggestedFiles.length && !suggestedFolders.length) {
            html += `
                <div class="gd-home-empty">Welcome to your Drive. You don't have any files yet.</div>
            `;
        }

        homePage.innerHTML = html;

        if (suggestedFolders.length > 0) {
            const grid = document.getElementById('gd-suggested-grid');
            suggestedFolders.forEach(f => {
                const card = document.createElement('div');
                card.className = 'gd-suggested-card gd-suggested-folder';
                card.dataset.id = f.id;
                card.dataset.type = 'folder';
                card.innerHTML = `
                    <div class="gd-card-top">
                        <div class="gd-card-icon"><svg viewBox="0 0 24 24" fill="#5F6368" width="24" height="24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg></div>
                        <div class="gd-card-content">
                            <div class="gd-card-name" title="${esc(f.name)}">${esc(f.name)}</div>
                            <div class="gd-card-action">in My Drive</div>
                        </div>
                    </div>
                `;
                card.addEventListener('click', () => { window.location.hash = `#/files/${f.id}`; });
                grid.appendChild(card);
            });
        }

        if (initialCards.length > 0) {
            if (useList) {
                const listContainer = document.getElementById('gd-home-suggested-list');
                const myAvatar = getMyProfileAvatar();
                listContainer.style.setProperty('--fd-me-avatar', myAvatar ? `url("${myAvatar}")` : 'none');
                initialCards.forEach((f) => {
                    listContainer.appendChild(createRow(f, 'file', false));
                });
                resolveHomeListLocations(initialCards, listContainer);
            } else {
                const gridContainer = document.getElementById('gd-home-suggested-cards');
                initialCards.forEach((f) => {
                    gridContainer.appendChild(createGridCard(f, 'file', false));
                });
            }
            document.getElementById('home-view-more-btn')?.addEventListener('click', expandHomeSuggestedFiles);
        }

        homePage.querySelectorAll('.gd-home-section-title.collapsible').forEach((header) => {
            header.addEventListener('click', () => {
                const targetId = header.dataset.target;
                const target = targetId ? document.getElementById(targetId) : null;
                if (!target) return;
                target.classList.toggle('hidden');
                const caret = header.querySelector('.caret');
                if (caret) caret.textContent = target.classList.contains('hidden') ? '▸' : '▾';
            });
        });

        clearSelection();
    }

    function expandHomeSuggestedFiles() {
        const useList = currentView === 'list';
        const container = useList
            ? document.getElementById('gd-home-suggested-list')
            : document.getElementById('gd-home-suggested-cards');
        if (!container) return;
        if (useList) {
            const myAvatar = getMyProfileAvatar();
            container.style.setProperty('--fd-me-avatar', myAvatar ? `url("${myAvatar}")` : 'none');
        }
        const next = homeSuggestedFiles.slice(homeSuggestedVisible, homeSuggestedVisible + HOME_SUGGESTED_STEP);
        next.forEach((f) => {
            container.appendChild(useList ? createRow(f, 'file', false) : createGridCard(f, 'file', false));
        });
        if (useList) resolveHomeListLocations(next, container);
        homeSuggestedVisible += next.length;
        if (homeSuggestedVisible >= homeSuggestedFiles.length) {
            document.getElementById('home-view-more-btn')?.closest('.gd-home-viewmore')?.classList.add('hidden');
        }
    }

    function hideSearchDropdown() {
        document.getElementById('search-live-dropdown')?.classList.add('hidden');
        document.querySelectorAll('.gd-chip-menu').forEach(m => m.classList.add('hidden'));
        document.querySelectorAll('.gd-chip.open').forEach(c => c.classList.remove('open'));
    }

    function setFilterSelect(selectId, value, anyLabel) {
        const sel = document.getElementById(selectId);
        if (!sel) return;
        if (!value) sel.value = (selectId === 'filter-type') ? '' : (anyLabel || '');
        else sel.value = value;
    }

    function updateChipLabel(chip, value) {
        const textEl = chip.querySelector('.gd-chip-text');
        if (textEl) textEl.textContent = value || (chip.dataset.label || '');
        chip.classList.toggle('active', !!value);
    }

    // Keep chips that target the same underlying <select> visually in sync
    // (e.g. an inline dropdown chip and the outer Home chip).
    function syncChipsForSelect(selectId, value) {
        document.querySelectorAll(`.gd-chip[data-select="${selectId}"]`).forEach((chip) => {
            updateChipLabel(chip, value);
        });
    }

    function bindChip(chip, onSelect) {
        const btn = chip.querySelector('.gd-chip-btn');
        const menu = chip.querySelector('.gd-chip-menu');
        if (!btn || !menu) return;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = menu.classList.contains('hidden');
            document.querySelectorAll('.gd-chip-menu').forEach(m => m.classList.add('hidden'));
            document.querySelectorAll('.gd-chip.open').forEach(c => c.classList.remove('open'));
            if (willOpen) { menu.classList.remove('hidden'); chip.classList.add('open'); }
        });
        menu.querySelectorAll('.gd-chip-option').forEach((opt) => {
            opt.addEventListener('click', (e) => {
                e.stopPropagation();
                menu.classList.add('hidden');
                chip.classList.remove('open');
                onSelect(opt.dataset.value || '');
            });
        });
    }

    function bindSearchGlobalClose() {
        if (searchGlobalCloseBound) return;
        searchGlobalCloseBound = true;
        document.addEventListener('click', (e) => {
            const wrap = document.querySelector('.search-wrap');
            if (wrap && !wrap.contains(e.target)) {
                hideSearchDropdown();
            }
        });
    }

    function highlightMatch(name, qLower) {
        const raw = String(name || '');
        const idx = raw.toLowerCase().indexOf(qLower);
        if (idx < 0 || !qLower) return esc(raw);
        return `${esc(raw.slice(0, idx))}<strong>${esc(raw.slice(idx, idx + qLower.length))}</strong>${esc(raw.slice(idx + qLower.length))}`;
    }

    function resolveHomeLocationName(folderId) {
        if (!folderId) return 'My Drive';
        return folderNameCache.get(folderId) || '';
    }

    async function ensureFolderNames(ids, onResolved) {
        const missing = [...new Set((ids || []).filter((id) => id && !folderNameCache.has(id)))];
        for (const id of missing) {
            let name = 'My Drive';
            try {
                const data = await API.folders.breadcrumb(id);
                const crumbs = data.breadcrumb || [];
                name = crumbs.length ? crumbs[crumbs.length - 1].name : 'My Drive';
            } catch { /* keep fallback */ }
            folderNameCache.set(id, name);
            onResolved?.(id, name);
        }
    }

    async function resolveUnknownLocations(items, dropdown) {
        await ensureFolderNames(
            items.map((f) => f.folder_id),
            (id, name) => {
                dropdown.querySelectorAll(`.gd-sr-row[data-folder="${id}"] .gd-sr-loc-text`).forEach((el) => {
                    el.textContent = name;
                });
            }
        );
    }

    async function resolveHomeListLocations(items, listContainer) {
        if (!listContainer) return;
        await ensureFolderNames(
            items.map((f) => f.folder_id),
            (id, name) => {
                listContainer.querySelectorAll(`.home-location-cell[data-folder="${id}"] .home-location-text`).forEach((el) => {
                    el.textContent = name;
                });
            }
        );
    }

    // Apply the Type/People/Modified filter selects to a live search list.
    function applyHomeInlineFilters(list) {
        const me = getCurrentUser();
        const type = document.getElementById('filter-type')?.value || '';
        const owner = document.getElementById('filter-owner')?.value || 'Anyone';
        const modified = document.getElementById('filter-modified')?.value || 'Any time';

        let out = [...list];
        if (type && type !== 'Any') {
            out = out.filter((f) => {
                const g = getMimeGroup(f.mime_type, f.mime_type === 'folder' ? 'folder' : 'file', f.name);
                if (type === 'Folders') return f.mime_type === 'folder';
                if (type === 'Photos') return g === 'image';
                if (type === 'Documents') return g === 'document' || g === 'text';
                if (type === 'Spreadsheets') return g === 'sheet';
                if (type === 'Presentations') return g === 'presentation';
                if (type === 'PDFs') return g === 'pdf';
                if (type === 'Images') return g === 'image';
                if (type === 'Videos') return g === 'video';
                if (type === 'Audio') return g === 'audio';
                if (type === 'Archives') return g === 'archive';
                return true;
            });
        }
        if (owner === 'Me') out = out.filter((f) => f.owner_id === me.id);
        else if (owner === 'Not me') out = out.filter((f) => f.owner_id !== me.id);
        if (modified !== 'Any time') {
            const now = Date.now();
            out = out.filter((f) => {
                const diffDays = (now - new Date(f.updated_at || f.created_at).getTime()) / (1000 * 60 * 60 * 24);
                if (modified === 'Today') return diffDays < 1;
                if (modified === 'Yesterday') return diffDays >= 1 && diffDays < 2;
                if (modified === 'Last 7 days') return diffDays <= 7;
                if (modified === 'Last 30 days') return diffDays <= 30;
                if (modified === 'Last 90 days') return diffDays <= 90;
                return true;
            });
        }
        return out;
    }

    async function renderSearchDropdown(query) {
        const dropdown = document.getElementById('search-live-dropdown');
        if (!dropdown) return;
        const q = String(query || '').trim();
        if (!q) { hideSearchDropdown(); return; }

        dropdown.classList.remove('hidden');

        let list = [];
        try {
            const data = await API.files.list({ search: q, page_size: '20' });
            list = data.files || [];
        } catch { list = []; }

        list = applyHomeInlineFilters(list);
        const top = list.slice(0, 5);
        const qLower = q.toLowerCase();

        const chipsHtml = homeChipHtml(HOME_CHIP_DEFS.filter((d) => d.key !== 'location'));
        const folderIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="#5f6368"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';

        let rowsHtml;
        if (!top.length) {
            rowsHtml = '<div class="gd-sr-empty">No results found</div>';
        } else {
            rowsHtml = top.map((f) => {
                const type = (f.mime_type === 'folder') ? 'folder' : 'file';
                const loc = resolveHomeLocationName(f.folder_id);
                return `
                    <button type="button" class="gd-sr-row" data-id="${esc(f.id)}" data-type="${type}" data-folder="${esc(f.folder_id || '')}">
                        <span class="gd-sr-icon">${getIcon(type, f.mime_type, f.name)}</span>
                        <span class="gd-sr-main">
                            <span class="gd-sr-name">${highlightMatch(f.name, qLower)}</span>
                            <span class="gd-sr-owner">${esc(itemOwner(f))}</span>
                        </span>
                        <span class="gd-sr-date">${esc(Components.formatDate(f.updated_at || f.created_at))}</span>
                        <span class="gd-sr-loc">${folderIcon}<span class="gd-sr-loc-text">${esc(loc || 'My Drive')}</span></span>
                    </button>`;
            }).join('');
        }

        dropdown.innerHTML = `
            <div class="gd-sr-chips">${chipsHtml}</div>
            <div class="gd-sr-list">${rowsHtml}</div>
            <div class="gd-sr-footer">
                <a href="#" class="gd-sr-advanced">Advanced search</a>
                <a href="#" class="gd-sr-all">${'\u2190'} All results</a>
            </div>
        `;

        dropdown.querySelectorAll('.gd-chip').forEach((chip) => {
            bindChip(chip, (value) => {
                setFilterSelect(chip.dataset.select, value, chip.dataset.any);
                syncChipsForSelect(chip.dataset.select, value);
                renderSearchDropdown(q);
            });
        });

        dropdown.querySelectorAll('.gd-sr-row').forEach((row) => {
            row.addEventListener('click', () => {
                const id = row.dataset.id;
                if (row.dataset.type === 'folder') { window.location.hash = `#/files/${id}`; hideSearchDropdown(); return; }
                const f = top.find((x) => x.id === id);
                if (f) openFile(f);
                hideSearchDropdown();
            });
        });

        dropdown.querySelector('.gd-sr-advanced')?.addEventListener('click', (e) => { e.preventDefault(); openAdvancedSearchPanel(q); });
        dropdown.querySelector('.gd-sr-all')?.addEventListener('click', (e) => { e.preventDefault(); searchAllResults(q); });

        resolveUnknownLocations(top, dropdown);
    }

    function searchAllResults(query) {
        hideSearchDropdown();
        const topInput = document.getElementById('search-input');
        if (topInput) topInput.value = query;
        quickSearch(query);
    }

    function openAdvancedSearchPanel(query) {
        hideSearchDropdown();
        const topInput = document.getElementById('search-input');
        const itemName = document.getElementById('filter-item-name');
        if (topInput) topInput.value = query;
        if (itemName && query) itemName.value = query;
        document.getElementById('search-filter-panel')?.classList.remove('hidden');
        syncAdvancedSearchDependentFields();
        topInput?.focus();
    }

    // Google Drive-style filter chip bar shown above the search results.
    function renderSearchChipBar() {
        const bar = document.getElementById('md3-chip-bar');
        if (!bar) return;

        const anyActive = HOME_CHIP_DEFS.some((d) => {
            const s = document.getElementById(d.select);
            return s && s.value && s.value !== d.anyLabel;
        });
        bar.innerHTML = homeChipHtml(HOME_CHIP_DEFS, { withClear: true })
            + (anyActive ? '<button type="button" class="gd-chip-clearall">Clear filters</button>' : '');

        bar.querySelectorAll('.gd-chip').forEach((chip) => {
            const clearEl = chip.querySelector('.gd-chip-clear');
            if (clearEl) {
                clearEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    setFilterSelect(chip.dataset.select, '', chip.dataset.any);
                    applyAdvancedSearch();
                });
            }
            bindChip(chip, (value) => {
                setFilterSelect(chip.dataset.select, value, chip.dataset.any);
                syncChipsForSelect(chip.dataset.select, value);
                applyAdvancedSearch();
            });
        });

        bar.querySelector('.gd-chip-clearall')?.addEventListener('click', () => {
            HOME_CHIP_DEFS.forEach((d) => setFilterSelect(d.select, '', d.anyLabel));
            applyAdvancedSearch();
        });

        bar.classList.remove('hidden');
    }

    async function loadRecent() {
        currentPage = 'recent';
        currentFolderId = null;
        clearSelection();
        showFilesView();
        showLoading(true);
        try {
            const data = await API.files.list({ sort: 'accessed_at', dir: 'desc', page_size: '80' });
            allFolders = [];
            allFiles = data.files || [];
            filteredFolders = [];
            filteredFiles = [...allFiles];
            renderItems(filteredFolders, filteredFiles);
            setBreadcrumbText('Recent');
        } catch {
            Components.toast('Failed to load recent files', 'error');
        } finally {
            showLoading(false);
        }
    }

    async function loadStarred() {
        currentPage = 'starred';
        currentFolderId = null;
        clearSelection();
        showFilesView();
        showLoading(true);
        try {
            const data = await API.files.list({ starred: 'true', page_size: '150' });
            allFolders = [];
            allFiles = data.files || [];
            filteredFolders = [];
            filteredFiles = [...allFiles];
            renderItems(filteredFolders, filteredFiles);
            setBreadcrumbText('Starred');
        } catch {
            Components.toast('Failed to load starred', 'error');
        } finally {
            showLoading(false);
        }
    }

    async function loadTrash() {
        currentPage = 'trash';
        currentFolderId = null;
        clearSelection();
        showFilesView();
        showLoading(true);
        try {
            const [fileData, folderData] = await Promise.all([API.files.trash(), API.folders.trash()]);
            allFolders = folderData.folders || [];
            allFiles = fileData.files || [];
            filteredFolders = [...allFolders];
            filteredFiles = [...allFiles];
            renderItems(filteredFolders, filteredFiles, { isTrash: true });
            setBreadcrumbText('Trash');
            syncTrashActionLabels();
            updateTrashBinBanner();
        } catch {
            Components.toast('Failed to load trash', 'error');
        } finally {
            showLoading(false);
        }
    }

    function updateTrashBinBanner() {
        const banner = document.getElementById('trash-bin-banner');
        if (!banner) return;
        const inTrash = currentPage === 'trash';
        const hasItems = inTrash && ((allFolders && allFolders.length) || (allFiles && allFiles.length));
        banner.classList.toggle('hidden', !hasItems);
    }

    async function emptyBin() {
        if (currentPage !== 'trash') return;
        const hasItems = (allFolders && allFolders.length) || (allFiles && allFiles.length);
        if (!hasItems) return;
        const ok = await Components.confirm(
            'Empty bin?',
            'All items in the bin will be deleted forever. This cannot be undone.',
            'Empty bin',
        );
        if (!ok) return;
        Components.toast('Emptying bin…', 'info');
        try {
            await API.trash.empty();
            Components.toast('Bin emptied', 'success');
            clearSelection();
            await loadTrash();
        } catch (e) {
            Components.toast(e?.message || 'Failed to empty bin', 'error');
        }
    }

    async function resolveSharedListings(items, mode) {
        const fileResults = await Promise.all(items
            .filter((item) => item.item_type === 'file' && item.item_id)
            .map(async (item) => {
                try {
                    const f = await API.files.get(item.item_id);
                    if (!f) return null;
                    const base = {
                        ...f,
                        share_role: permissionToRole(item.share?.permission),
                        shared_at: item.share?.created_at || f.updated_at || f.created_at,
                    };
                    if (mode === 'with-me') {
                        return {
                            ...base,
                            shared_by_name: item.owner_name || 'User',
                            shared_by_email: item.owner_email || '',
                        };
                    }
                    const recipient = usersCache.find((u) => u.id === item.share?.shared_with);
                    return {
                        ...base,
                        shared_with_name: recipient?.label || recipient?.email || item.share?.shared_with || 'User',
                        shared_with_email: recipient?.email || '',
                    };
                } catch {
                    return null;
                }
            }));

        const folderResults = items
            .filter((item) => item.item_type === 'folder' && item.item_id)
            .map((item) => {
                const base = {
                    id: item.item_id,
                    name: item.item_name || 'Folder',
                    updated_at: item.share?.created_at || new Date().toISOString(),
                    created_at: item.share?.created_at || new Date().toISOString(),
                    share_role: permissionToRole(item.share?.permission),
                    shared_at: item.share?.created_at || new Date().toISOString(),
                };
                if (mode === 'with-me') {
                    return {
                        ...base,
                        shared_by_name: item.owner_name || 'User',
                        shared_by_email: item.owner_email || '',
                    };
                }
                const recipient = usersCache.find((u) => u.id === item.share?.shared_with);
                return {
                    ...base,
                    shared_with_name: recipient?.label || recipient?.email || item.share?.shared_with || 'User',
                    shared_with_email: recipient?.email || '',
                };
            });

        const sortByShared = (a, b) => new Date(b.shared_at) - new Date(a.shared_at);
        return {
            files: fileResults.filter(Boolean).sort(sortByShared),
            folders: folderResults.sort(sortByShared),
        };
    }

    async function loadSharedWithMe() {
        currentPage = 'shared-with';
        currentFolderId = null;
        clearSelection();
        showFilesView();
        showLoading(true);

        try {
            const data = await API.shares.sharedWithMe();
            const { files, folders } = await resolveSharedListings(data.items || [], 'with-me');
            allFolders = folders;
            allFiles = files;
            filteredFolders = [...allFolders];
            filteredFiles = [...allFiles];
            renderItems(filteredFolders, filteredFiles);
            setBreadcrumbText('Shared with me');
        } catch {
            allFolders = [];
            allFiles = [];
            filteredFolders = [];
            filteredFiles = [];
            renderItems([], []);
            setBreadcrumbText('Shared with me');
        } finally {
            showLoading(false);
        }
    }

    async function loadOffline() {
        currentPage = 'offline';
        currentFolderId = null;
        clearSelection();
        showFilesView();
        showLoading(true);

        try {
            const data = await API.files.list({ page_size: '300' });
            allFolders = [];
            allFiles = (data.files || []).filter((f) => meta.offline_ids.includes(f.id));
            filteredFolders = [];
            filteredFiles = [...allFiles];
            renderItems(filteredFolders, filteredFiles);
            setBreadcrumbText('Offline');
        } catch {
            Components.toast('Failed to load offline files', 'error');
        } finally {
            showLoading(false);
        }
    }

    async function createFolder() {
        if (!canAcceptUploads()) {
            Components.toast('Connect a computer to add folders here', 'info');
            return;
        }
        const name = await Components.prompt('New folder', '', 'Folder name');
        if (!name || !name.trim()) return;
        try {
            await API.folders.create(name.trim(), currentFolderId || null);
            Components.toast('Folder created', 'success');
            refresh();
            if (currentPage === 'files') SidebarTree.refresh(currentFolderId || null);
        } catch (err) {
            Components.toast(err.message, 'error');
        }
    }

    async function quickSearch(query) {
        hideSearchDropdown();
        const q = String(query || '').trim().toLowerCase();

        // In folder view, search only within the currently opened folder.
        if (currentPage === 'files') {
            const folders = (allFolders || []).filter((f) => String(f.name || '').toLowerCase().includes(q));
            const files = (allFiles || []).filter((f) => String(f.name || '').toLowerCase().includes(q));
            filteredFolders = folders;
            filteredFiles = files;
            renderItems(filteredFolders, filteredFiles, { keepSelection: true });
            return;
        }

        currentPage = 'search';
        showFilesView();
        showLoading(true);
        try {
            const data = await API.files.list({ search: query, page_size: '300' });
            allFolders = [];
            allFiles = data.files || [];
            filteredFolders = [];
            filteredFiles = [...allFiles];
            renderItems(filteredFolders, filteredFiles);
            renderSearchChipBar();
            setBreadcrumbText(`Search: ${query}`);
        } catch {
            Components.toast('Search failed', 'error');
        } finally {
            showLoading(false);
        }
    }

    async function applyAdvancedSearch() {
        hideSearchDropdown();
        const params = collectAdvancedSearchParams();

        currentPage = 'search';
        showFilesView();
        showLoading(true);

        try {
            const data = await API.search.advanced(params);
            allFolders = data.folders || [];
            allFiles = data.files || [];
            filteredFolders = [...allFolders];
            filteredFiles = [...allFiles];
            renderItems(filteredFolders, filteredFiles);
            renderSearchChipBar();
            setBreadcrumbText('Advanced Search');
        } catch {
            Components.toast('Advanced search failed', 'error');
        } finally {
            showLoading(false);
        }
    }

    function sortCollections(folders, files) {
        const folderItems = [...folders];
        const fileItems = [...files];

        const factor = sortDir === 'asc' ? 1 : -1;

        const sortFn = (a, b) => {
            if (sortBy === 'name') {
                return a.name.localeCompare(b.name) * factor;
            }
            if (sortBy === 'owner') {
                const ownerA = currentPage === 'shared-with'
                    ? (a.shared_by_name || a.shared_by_email || itemOwner(a))
                    : itemOwner(a);
                const ownerB = currentPage === 'shared-with'
                    ? (b.shared_by_name || b.shared_by_email || itemOwner(b))
                    : itemOwner(b);
                return ownerA.localeCompare(ownerB) * factor;
            }
            if (sortBy === 'size') {
                if (currentPage === 'shared-with') {
                    const roleA = String(a.share_role || 'viewer');
                    const roleB = String(b.share_role || 'viewer');
                    return roleA.localeCompare(roleB) * factor;
                }
                const av = Number(a.size || 0);
                const bv = Number(b.size || 0);
                return (av - bv) * factor;
            }
            if (sortBy === 'modified_by') {
                const am = (a.last_modified_by || itemOwner(a)).toLowerCase();
                const bm = (b.last_modified_by || itemOwner(b)).toLowerCase();
                return am.localeCompare(bm) * factor;
            }

            const at = new Date((currentPage === 'shared-with')
                ? (a.shared_at || a.updated_at || a.created_at || 0)
                : (a.updated_at || a.created_at || 0)).getTime();
            const bt = new Date((currentPage === 'shared-with')
                ? (b.shared_at || b.updated_at || b.created_at || 0)
                : (b.updated_at || b.created_at || 0)).getTime();
            return (at - bt) * factor;
        };

        folderItems.sort(sortFn);
        fileItems.sort(sortFn);
        return { folders: folderItems, files: fileItems };
    }

    function updateSortArrows() {
        document.querySelectorAll('#file-list-header .sort-col').forEach((col) => {
            col.classList.remove('sorted-asc', 'sorted-desc');
            if (col.dataset.sort === sortBy) {
                col.classList.add(sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
            }
        });
        document.querySelectorAll('#file-list-header .sort-arrow').forEach((el) => {
            const key = el.dataset.arrow;
            if (key !== sortBy) {
                el.textContent = '↕';
                return;
            }
            el.textContent = sortDir === 'asc' ? '↑' : '↓';
        });
    }

    function filterCollections(folders, files) {
        let flds = folders || [];
        let fls = files || [];

        const type = document.querySelector('.md3-chip-wrap[data-chip="type"]')?.dataset.selectedValue;
        if (type && type !== '') {
            if (type === 'Folders') {
                // If it's pure folders, ensure mixed lists keep folders and drop files
                fls = fls.filter(f => f.mime_type === 'folder' || f.isDir);
                // flds is preserved
            } else {
                flds = []; // Drop strict folders if specific file type is sought
                fls = fls.filter((f) => {
                    if (f.mime_type === 'folder' || f.isDir) return false;
                    const g = getMimeGroup(f.mime_type, 'file', f.name);
                    if (type === 'Documents') return g === 'document' || g === 'text';
                    if (type === 'Images') return g === 'image';
                    if (type === 'Videos') return g === 'video';
                    if (type === 'Audio') return g === 'audio';
                    return true;
                });
            }
        }

        const owner = document.querySelector('.md3-chip-wrap[data-chip="people"]')?.dataset.selectedValue;
        if (owner && owner !== '') {
            const me = getCurrentUser();
            const flt = list => list.filter(f => 
                (owner === 'me' && f.owner_id === me.id) ||
                (owner === 'not_me' && f.owner_id !== me.id) ||
                owner === 'anyone'
            );
            if (owner !== 'anyone') {
                flds = flt(flds);
                fls = flt(fls);
            }
        }

        const modified = document.querySelector('.md3-chip-wrap[data-chip="modified"]')?.dataset.selectedValue;
        if (modified && modified !== '') {
            const now = Date.now();
            const flt = list => list.filter(f => {
                const t = new Date(f.updated_at || f.created_at).getTime();
                const diffDays = (now - t) / (1000 * 60 * 60 * 24);
                if (modified === 'today') return diffDays < 1;
                if (modified === 'last7') return diffDays <= 7;
                if (modified === 'last30') return diffDays <= 30;
                return true;
            });
            flds = flt(flds);
            fls = flt(fls);
        }

        return { folders: flds, files: fls };
    }

    function renderItems(folders, files, options = {}) {
        const grid = document.getElementById('file-grid');
        const empty = document.getElementById('empty-state');
        const header = document.getElementById('file-list-header');
        const isTrash = options.isTrash || currentPage === 'trash';

        const filtered = filterCollections(folders, files);
        const sorted = sortCollections(filtered.folders, filtered.files);
        filteredFolders = sorted.folders;
        filteredFiles = sorted.files;

        grid.innerHTML = '';
        updateListHeaderLabels();
        updateSortArrows();

        if (!filteredFolders.length && !filteredFiles.length) {
            grid.classList.add('hidden');
            empty.classList.remove('hidden');
            header.classList.add('hidden');
            if (currentPage === 'computers' && !currentFolderId) {
                renderComputersEmptyState();
                return;
            }
            document.getElementById('empty-title').textContent = isTrash ? 'Trash is empty' : 'No files found';
            document.getElementById('empty-desc').textContent = isTrash
                ? 'Items in Trash are deleted after 30 days.'
                : 'Use New or Upload to add files.';
            updateSelectionUI();
            return;
        }

        empty.classList.add('hidden');
        grid.classList.remove('hidden');

        if (currentView === 'grid') {
            grid.classList.add('grid-view');
            header.classList.add('hidden');
            let gi = 0;
            if (filteredFolders.length) {
                const fh = document.createElement('div');
                fh.className = 'fd-grid-section-title';
                fh.textContent = 'Folders';
                grid.appendChild(fh);
                const fw = document.createElement('div');
                fw.className = 'fd-folder-chips';
                filteredFolders.forEach((f) => fw.appendChild(createGridCard(f, 'folder', isTrash)));
                grid.appendChild(fw);
                if (filteredFiles.length) {
                    const dh = document.createElement('div');
                    dh.className = 'fd-grid-section-title';
                    dh.textContent = 'Files';
                    grid.appendChild(dh);
                }
            }
            filteredFiles.forEach((f)   => { const el = createGridCard(f, 'file',   isTrash); el.style.setProperty('--fd-i', gi++); grid.appendChild(el); });
        } else {
            grid.classList.remove('grid-view');
            header.classList.remove('hidden');
            const myAvatar = getMyProfileAvatar();
            grid.style.setProperty('--fd-me-avatar', myAvatar ? `url("${myAvatar}")` : 'none');
            let ri = 0;
            filteredFolders.forEach((f) => { const el = createRow(f, 'folder', isTrash); el.style.setProperty('--fd-i', ri++); grid.appendChild(el); });
            filteredFiles.forEach((f)   => { const el = createRow(f, 'file',   isTrash); el.style.setProperty('--fd-i', ri++); grid.appendChild(el); });
        }

        if (!options.keepSelection) {
            clearSelection();
        } else {
            syncSelectionStyles();
        }
    }

    function createRow(item, type, isTrash) {
        const row = document.createElement('div');
        row.className = 'file-row';
        row.dataset.id = item.id;
        row.dataset.type = type;
        row.draggable = true;

        const isHomeSuggested = currentPage === 'home';
        const isSharedWith = currentPage === 'shared-with';

        let owner = itemOwner(item);
        let modifiedBy = item.last_modified_by || owner || 'Admin';
        let sizeText = type === 'folder' ? '—' : Components.formatSize(item.size);
        let modifiedText = `${Components.formatDate(item.updated_at || item.created_at)}${type === 'file' ? ` by ${modifiedBy}` : ''}`;
        let locationText = buildLocationLabel(item.folder_id);
        if (isSharedWith) {
            modifiedText = Components.formatDate(item.shared_at || item.updated_at || item.created_at);
            sizeText = capitalizeRole(item.share_role || 'viewer');
        }
        if (isHomeSuggested) {
            locationText = resolveHomeLocationName(item.folder_id) || '…';
        }
        const lockBadge = '';
        const sharedBadge = showSharedBadgeForItem(item) ? renderSharedBadge() : '';
        const folderIconSvg = '<svg viewBox="0 0 24 24" width="16" height="16" fill="#5f6368"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
        const reasonText = isHomeSuggested ? formatHomeReason(item) : '';
        const ownerCellHtml = renderOwnerCell(item);

        row.innerHTML = `
            <div class="file-cell file-name">
                <input type="checkbox" class="file-checkbox" aria-label="Select">
                <span class="file-icon">${getIcon(type, item.mime_type, item.name)}</span>
                <span class="file-label">${esc(item.name)}</span>
                ${sharedBadge}
                ${lockBadge}
            </div>
            <div class="file-cell cell-owner">${isHomeSuggested
                ? `<span class="home-reason-cell">${esc(reasonText)}</span>`
                : ownerCellHtml}</div>
            <div class="file-cell cell-date">${isHomeSuggested
                ? ownerCellHtml
                : esc(modifiedText)}</div>
            <div class="file-cell cell-size">${isHomeSuggested
                ? `<a class="home-location-cell" data-folder="${esc(item.folder_id || '')}" href="#/files${item.folder_id ? `/${item.folder_id}` : ''}">${folderIconSvg}<span class="home-location-text">${esc(locationText)}</span></a>`
                : sizeText}</div>
            <div class="file-cell file-actions">
                <button class="btn-icon action-share" title="Share"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M18 16.08a2.9 2.9 0 0 0-1.96.77L8.91 12.7a2.9 2.9 0 0 0 0-1.39l7.05-4.11A2.99 2.99 0 1 0 15 5a2.9 2.9 0 0 0 .09.7L8.04 9.81A3 3 0 1 0 8 14.19l7.12 4.16a2.96 2.96 0 1 0 2.88-2.27z"/></svg></button>
                <button class="btn-icon action-download" title="Download"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M5 20h14v-2H5m14-9h-4V3H9v6H5l7 7 7-7z"/></svg></button>
                <button class="btn-icon action-more" title="More"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg></button>
            </div>
        `;

        bindItemRowEvents(row, item, type, isTrash);
        setupDropTarget(row, item, type);
        return row;
    }

    function createGridCard(item, type, isTrash) {
        const card = document.createElement('div');
        card.className = `file-card ${type === 'folder' ? 'folder-card' : ''}`;
        card.dataset.id = item.id;
        card.dataset.type = type;
        card.draggable = true;

        const overlayHtml = `
            <div class="card-overlay">
                <input type="checkbox" class="file-checkbox" aria-label="Select">
            </div>
            <button class="btn-icon action-more card-more-btn" title="More" aria-label="More"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg></button>`;

        if (type === 'folder') {
            const folderSharedBadge = showSharedBadgeForItem(item) ? renderSharedBadge() : '';
            card.innerHTML = `
                <span class="folder-chip-icon">${getIcon('folder', item.mime_type, item.name)}</span>
                <span class="folder-chip-name" title="${esc(item.name)}">${esc(item.name)}</span>${folderSharedBadge}
                <button class="btn-icon action-more card-more-btn" title="More" aria-label="More"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg></button>
            `;
            bindItemRowEvents(card, item, type, isTrash);
            setupDropTarget(card, item, type);
            return card;
        }

        const me = getCurrentUser();
        const edited = item.updated_at && item.created_at
            && new Date(item.updated_at).getTime() > new Date(item.created_at).getTime();
        const who = (item.owner_id && me.id && item.owner_id === me.id) ? 'You' : (itemOwner(item) || 'You');
        const reason = `${who} ${edited ? 'edited' : 'created'} \u00b7 ${Components.formatDate(item.updated_at || item.created_at)}`;
        const fileSharedBadge = showSharedBadgeForItem(item) ? renderSharedBadge() : '';

        card.innerHTML = `
            <div class="card-thumb" id="thumb-${item.id}">${getIcon('file', item.mime_type, item.name)}</div>
            ${overlayHtml}
            <div class="card-meta">
                <span class="card-type-icon">${getIcon('file', item.mime_type, item.name)}</span>
                <div class="card-meta-text">
                    <div class="card-name" title="${esc(item.name)}">${esc(item.name)}${fileSharedBadge}</div>
                    <div class="card-sub">${esc(reason)}</div>
                </div>
            </div>
        `;

        bindItemRowEvents(card, item, type, isTrash);
        setupDropTarget(card, item, type);

        if (getMimeGroup(item.mime_type, type, item.name) === 'image') {
            renderImageThumb(item, card.querySelector('.card-thumb'));
        }

        return card;
    }

    async function renderImageThumb(item, target) {
        const holder = target || document.getElementById(`thumb-${item.id}`);
        if (!holder) return;
        try {
            const blob = await decryptFileBlob(item);
            const url = URL.createObjectURL(blob);
            holder.innerHTML = `<img src="${url}" alt="${esc(item.name)}">`;
        } catch {
            // keep icon fallback
        }
    }

    function bindItemRowEvents(container, item, type, isTrash) {
        const checkbox = container.querySelector('.file-checkbox');
        const moreBtn = container.querySelector('.action-more');
        const shareBtn = container.querySelector('.action-share');
        const downloadBtn = container.querySelector('.action-download');

        checkbox?.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleSelection(item.id, { type, data: item, isTrash }, checkbox.checked, container);
        });

        container.addEventListener('click', (e) => {
            if (e.target.closest('.action-more,.action-share,.action-download,.file-checkbox')) return;

            // Recent page should open items with a single click.
            if (currentPage === 'recent') {
                if (type === 'folder' || type === 'suggested-folder') {
                    window.location.hash = folderNavHash(item.id);
                } else {
                    openFile(item);
                }
                return;
            }

            // Mobile UX: double-click is unreliable on touch devices.
            // Open files and folders on single tap in mobile/tablet widths.
            if (window.matchMedia('(max-width: 820px)').matches) {
                if (type === 'folder' || type === 'suggested-folder') {
                    window.location.hash = folderNavHash(item.id);
                } else {
                    openFile(item);
                }
                return;
            }

            selectSingle(item.id, { type, data: item, isTrash }, container, e);
        });

        container.addEventListener('dblclick', () => {
            if (type === 'folder') {
                window.location.hash = folderNavHash(item.id);
                return;
            }
            openFile(item);
        });

        container.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            contextTarget = { type, data: item, isTrash };
            showContextMenu(e.clientX, e.clientY);
        });

        moreBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            contextTarget = { type, data: item, isTrash };
            const rect = moreBtn.getBoundingClientRect();
            showContextMenu(rect.right, rect.bottom);
        });

        shareBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            openShareModal({ type, data: item });
        });

        downloadBtn?.addEventListener('click', async (e) => {
            e.stopPropagation();
            await downloadPayloadAsZip({ type, data: item });
        });

        container.addEventListener('dragstart', (e) => {
            dragPayload = { type, data: item };
            e.dataTransfer.effectAllowed = 'move';
        });

        container.addEventListener('dragend', () => {
            dragPayload = null;
            clearDropHighlights();
        });
    }

    function setupDropTarget(container, item, type) {
        if (type !== 'folder') return;

        container.addEventListener('dragenter', (e) => {
            if (!dragPayload) return;
            e.preventDefault();
            container.classList.add('folder-drop-target');
        });

        container.addEventListener('dragover', (e) => {
            if (!dragPayload) return;
            e.preventDefault();
        });

        container.addEventListener('dragleave', () => {
            container.classList.remove('folder-drop-target');
        });

        container.addEventListener('drop', async (e) => {
            e.preventDefault();
            container.classList.remove('folder-drop-target');
            if (!dragPayload) return;
            const toFolder = item.id;
            Components.toast(`Moving to ${item.name}...`, 'info');
            try {
                if (dragPayload.type === 'file') {
                    await API.files.update(dragPayload.data.id, { folder_id: toFolder });
                } else {
                    await API.folders.update(dragPayload.data.id, { parent_id: toFolder });
                }
                addFileActivity(dragPayload.data.id, 'moved', dragPayload.data.name);
                refresh();
            } catch (err) {
                Components.toast(`Move failed: ${err.message}`, 'error');
            }
        });
    }

    function clearDropHighlights() {
        document.querySelectorAll('.folder-drop-target').forEach((el) => el.classList.remove('folder-drop-target'));
    }

    const TrashCopy = {
        deleteForever: 'Delete forever',
        deleteForeverTitle: 'Delete forever?',
        deleteForeverButton: 'Delete forever',
        deleteForeverToast: 'Deleted forever',
        moveToTrash: 'Move to trash',
        moveToTrashTitle: 'Move to trash?',
        moveToTrashButton: 'Move to trash',
        movedToTrashToast: 'Moved to trash',
        restore: 'Restore',
        singleDeleteBody(name) {
            return `"${name}" will be deleted forever.`;
        },
        bulkDeleteBody(count) {
            return count === 1 ? '1 item will be deleted forever.' : `${count} items will be deleted forever.`;
        },
        singleMoveBody(name) {
            return `"${name}" will be moved to trash.`;
        },
        bulkMoveBody() {
            return 'Selected items will be moved to trash.';
        },
        restoredToast(count) {
            return count === 1 ? 'Restored' : `${count} items restored`;
        },
    };

    function inTrashView() {
        return currentPage === 'trash';
    }

    function isTrashMode(target) {
        // Permanent-delete UX is tied to the Trash page only — never stale
        // contextTarget.isTrash from a previous visit.
        return inTrashView() || Boolean(target?.isTrash && currentPage === 'trash');
    }

    function setElementHidden(el, hidden) {
        if (!el) return;
        if (hidden) {
            el.setAttribute('hidden', '');
        } else {
            el.removeAttribute('hidden');
        }
    }

    function setActionLabel(el, label) {
        if (!el) return;
        el.title = label;
        el.setAttribute('aria-label', label);
    }

    function syncTrashActionLabels(target = contextTarget) {
        const trashMode = inTrashView();
        const computerList = currentPage === 'computers' && !currentFolderId;

        setActionLabel(
            document.getElementById('bulk-delete'),
            trashMode ? TrashCopy.deleteForever : (computerList ? 'Remove device' : 'Delete'),
        );
        setActionLabel(document.getElementById('bulk-restore'), TrashCopy.restore);

        setElementHidden(document.getElementById('bulk-share'), trashMode);
        setElementHidden(document.getElementById('bulk-move'), trashMode);
        setElementHidden(document.getElementById('bulk-restore'), !trashMode);

        const detailsDeleteBtn = document.getElementById('details-delete-btn');
        if (detailsDeleteBtn) {
            const label = trashMode ? TrashCopy.deleteForever : 'Delete';
            detailsDeleteBtn.title = trashMode ? TrashCopy.deleteForever : TrashCopy.moveToTrash;
            detailsDeleteBtn.setAttribute('aria-label', label);
            const textNode = detailsDeleteBtn.lastChild;
            if (textNode?.nodeType === Node.TEXT_NODE) {
                textNode.textContent = label;
            }
        }

        configureContextMenu(target);
    }

    let contextMenuOrder = null;

    function captureContextMenuOrder(menu) {
        if (contextMenuOrder) return;
        contextMenuOrder = Array.from(menu.children);
    }

    function restoreContextMenuOrder(menu) {
        if (!contextMenuOrder) return;
        contextMenuOrder.forEach((child) => menu.appendChild(child));
    }

    function configureContextMenu(target = contextTarget) {
        const menu = document.getElementById('context-menu');
        if (!menu) return;

        captureContextMenuOrder(menu);
        restoreContextMenuOrder(menu);

        const actionMap = {};
        menu.querySelectorAll('.context-item[data-action]').forEach((item) => {
            actionMap[item.dataset.action] = item;
            item.style.display = '';
        });
        menu.querySelectorAll('.context-divider').forEach((divider) => {
            divider.style.display = '';
        });

        const inTrash = isTrashMode(target);
        const isFolder = target && target.type === 'folder';
        const allowed = inTrash
            ? new Set(isFolder
                ? ['open', 'restore', 'info', 'delete']
                : ['open', 'restore', 'info', 'download', 'delete'])
            : null;

        Object.entries(actionMap).forEach(([action, item]) => {
            const show = inTrash ? allowed.has(action) : action !== 'restore';
            setElementHidden(item, !show);
            item.style.display = show ? '' : 'none';
        });

        if (actionMap.delete) {
            const computerEntry = target && target.type === 'folder' && isComputerListEntry(target.data);
            if (computerEntry) {
                actionMap.delete.textContent = 'Remove device';
                setActionLabel(actionMap.delete, 'Remove device');
            } else {
                actionMap.delete.textContent = inTrash ? TrashCopy.deleteForever : TrashCopy.moveToTrash;
                setActionLabel(actionMap.delete, actionMap.delete.textContent);
            }
        }
        if (actionMap.restore) {
            actionMap.restore.textContent = TrashCopy.restore;
            setActionLabel(actionMap.restore, TrashCopy.restore);
        }
        if (actionMap.info) {
            const infoLabel = (target && target.type === 'folder') ? 'Folder information' : 'File information';
            actionMap.info.textContent = infoLabel;
            setActionLabel(actionMap.info, infoLabel);
        }
        if (actionMap.request_approval) {
            const showApproval = !inTrash && target && target.type === 'file' && canWriteFileItem(target.data);
            setElementHidden(actionMap.request_approval, !showApproval);
            actionMap.request_approval.style.display = showApproval ? '' : 'none';
        }
        if (actionMap.open_with) {
            const showOpenWith = !inTrash && target && target.type === 'file';
            setElementHidden(actionMap.open_with, !showOpenWith);
            actionMap.open_with.style.display = showOpenWith ? '' : 'none';
        }

        const computerEntry = target && target.type === 'folder' && isComputerListEntry(target.data);
        if (computerEntry) {
            ['move', 'share', 'get_link', 'request_approval', 'copy', 'rename', 'offline', 'open_with', 'star', 'download'].forEach((action) => {
                if (actionMap[action]) {
                    setElementHidden(actionMap[action], true);
                    actionMap[action].style.display = 'none';
                }
            });
        }

        if (inTrash) {
            ['open', 'restore', 'download', 'info', 'delete'].forEach((action) => {
                if (actionMap[action]) menu.appendChild(actionMap[action]);
            });
            menu.querySelectorAll('.context-divider').forEach((divider) => {
                divider.style.display = 'none';
            });
        } else {
            const isVisibleItem = (el) =>
                el?.classList?.contains('context-item')
                && el.style.display !== 'none'
                && !el.hasAttribute('hidden');
            const dividers = Array.from(menu.querySelectorAll('.context-divider'));
            dividers.forEach((divider) => {
                divider.style.display = 'none';
            });
            const visibleItems = Array.from(menu.children).filter(isVisibleItem);
            for (let i = 0; i < visibleItems.length - 1; i++) {
                let el = visibleItems[i].nextElementSibling;
                let firstDivider = null;
                while (el && el !== visibleItems[i + 1]) {
                    if (el.classList.contains('context-divider') && !firstDivider) {
                        firstDivider = el;
                    }
                    el = el.nextElementSibling;
                }
                if (firstDivider) firstDivider.style.display = '';
            }
        }
    }

    function showContextMenu(x, y) {
        const menu = document.getElementById('context-menu');
        if (!menu) return;
        configureContextMenu();
        menu.style.left = `${Math.min(x, window.innerWidth - 250)}px`;
        menu.style.top = `${Math.min(y, window.innerHeight - 320)}px`;
        menu.classList.remove('hidden');
    }

    function syncSelectionStyles() {
        document.querySelectorAll('.file-row, .file-card').forEach((el) => {
            const selected = selectedItems.has(el.dataset.id);
            el.classList.toggle('selected', selected);
            const cb = el.querySelector('.file-checkbox');
            if (cb) cb.checked = selected;
        });
        updateSelectionUI();
    }

    function clearSelection() {
        selectedItems.clear();
        selectedPrimary = null;
        selectionAnchor = null;
        contextTarget = null;
        syncSelectionStyles();
    }

    function getVisibleItemPayloads() {
        const isTrash = currentPage === 'trash';
        const items = [];
        filteredFolders.forEach((f) => items.push({ id: f.id, type: 'folder', data: f, isTrash }));
        filteredFiles.forEach((f) => items.push({ id: f.id, type: 'file', data: f, isTrash }));
        return items;
    }

    function selectRange(anchorId, targetId) {
        const items = getVisibleItemPayloads();
        const anchorIdx = items.findIndex((x) => x.id === anchorId);
        const targetIdx = items.findIndex((x) => x.id === targetId);
        if (anchorIdx < 0 || targetIdx < 0) return;

        const start = Math.min(anchorIdx, targetIdx);
        const end = Math.max(anchorIdx, targetIdx);
        selectedItems.clear();
        for (let i = start; i <= end; i++) {
            selectedItems.add(items[i].id);
        }
        selectedPrimary = items[targetIdx];
    }

    function selectSingle(id, payload, el, event) {
        if (event?.shiftKey) {
            if (!selectionAnchor) {
                selectionAnchor = id;
                selectedItems.clear();
                selectedItems.add(id);
                selectedPrimary = payload;
            } else {
                selectRange(selectionAnchor, id);
            }
            syncSelectionStyles();
            return;
        }

        const preserve = event && (event.ctrlKey || event.metaKey);
        if (preserve) {
            const now = !selectedItems.has(id);
            toggleSelection(id, payload, now, el);
            return;
        }

        selectedItems.clear();
        selectedItems.add(id);
        selectedPrimary = payload;
        selectionAnchor = id;
        syncSelectionStyles();
        if (!document.getElementById('details-panel')?.classList.contains('hidden')) {
            openDetailsPanel(payload);
        }
    }

    function toggleSelection(id, payload, checked, el) {
        if (checked) {
            selectedItems.add(id);
            selectedPrimary = payload;
            el?.classList.add('selected');
        } else {
            selectedItems.delete(id);
            el?.classList.remove('selected');
            if (selectedPrimary && selectedPrimary.data.id === id) {
                selectedPrimary = null;
            }
        }

        syncSelectionStyles();
    }

    function syncToolbarSlot() {
        const app = document.getElementById('app');
        const gridVisible = !document.getElementById('file-grid')?.classList.contains('hidden');
        app?.classList.toggle('reserve-toolbar-slot', currentPage === 'computers' && gridVisible);
    }

    function updateSelectionUI() {
        const bar = document.getElementById('selection-bar');
        const count = document.getElementById('selection-count');
        const chipBar = document.getElementById('md3-chip-bar');
        if (!bar || !count) return;

        if (!selectedItems.size) {
            bar.classList.add('hidden');
            if (currentPage === 'files' || currentPage === 'search') {
                chipBar?.classList.remove('hidden');
            }
            syncToolbarSlot();
            return;
        }

        count.textContent = `${selectedItems.size} ${selectedItems.size === 1 ? 'item' : 'items'} selected`;
        syncTrashActionLabels();
        chipBar?.classList.add('hidden');
        bar.classList.remove('hidden');
        syncToolbarSlot();
    }

    async function handleContextAction(action, target) {
        const { type, data, isTrash } = target;
        switch (action) {
            case 'open':
                if (type === 'folder') {
                    window.location.hash = `#/files/${data.id}`;
                } else {
                    openFile(data);
                }
                return;
            case 'open_with':
                if (type === 'file') showOpenWithDialog(data);
                return;
            case 'share':
                openShareModal({ type, data });
                return;
            case 'get_link':
                await navigator.clipboard.writeText(buildShareLink(data.id));
                Components.toast('Link copied to clipboard', 'success');
                return;
            case 'request_approval':
                if (type === 'file') await requestApprovalForFile(data);
                return;
            case 'move':
                await moveItemPrompt(type, data);
                return;
            case 'star':
                await toggleStar(type, data);
                return;
            case 'offline':
                toggleOffline(data.id);
                return;
            case 'copy':
                await makeCopy(type, data);
                return;
            case 'rename':
                await renamePrompt(type, data);
                return;
            case 'info':
                openDetailsPanel({ type, data, isTrash });
                return;
            case 'download':
                await downloadPayloadAsZip({ type, data });
                return;
            case 'restore':
                if (type === 'folder') {
                    await API.folders.restore(data.id);
                } else {
                    await API.files.restore(data.id);
                }
                Components.toast(TrashCopy.restoredToast(1), 'success');
                refresh();
                return;
            case 'delete':
                await moveToTrash(type, data, isTrash);
                return;
            default:
                return;
        }
    }

    async function renamePrompt(type, data) {
        const value = await Components.prompt('Rename', data.name);
        if (!value || value.trim() === data.name) return;
        await renameItem({ type, data }, value.trim());
        Components.toast('Renamed', 'success');
        refresh();
    }

    async function renameItem(payload, newName) {
        if (payload.type === 'file') {
            await API.files.update(payload.data.id, { name: newName });
        } else {
            await API.folders.update(payload.data.id, { name: newName });
        }
        addFileActivity(payload.data.id, 'renamed', newName);
    }

    async function moveItemPrompt(type, data) {
        let list = [];
        try {
            const root = await API.folders.root();
            list = root.folders || [];
        } catch {
            Components.toast('Could not load folders', 'error');
            return;
        }

        const options = [''].concat(list.map((f) => f.id));
        const labels = ['My Drive (root)'].concat(list.map((f) => f.name));

        const html = `
            <label class="modal-label">Move to</label>
            <select id="move-target" style="width:100%;height:36px;border-radius:8px;border:1px solid var(--fd-border);background:var(--fd-bg-soft);color:var(--fd-text);">
                ${options.map((id, i) => `<option value="${id}">${esc(labels[i])}</option>`).join('')}
            </select>
        `;

        let moved = false;
        Components.showModal('Move to', html, [
            { text: 'Cancel' },
            {
                text: 'Move',
                class: 'btn-primary',
                action: async () => {
                    const targetId = document.getElementById('move-target').value;
                    if (type === 'file') {
                        await API.files.update(data.id, { folder_id: targetId || '' });
                    } else {
                        await API.folders.update(data.id, { parent_id: targetId || '' });
                    }
                    moved = true;
                },
            },
        ]);

        const check = setInterval(() => {
            if (!document.getElementById('modal-overlay')?.classList.contains('hidden')) return;
            clearInterval(check);
            if (moved) {
                Components.toast('Moved', 'success');
                refresh();
            }
        }, 120);
    }

    async function toggleStar(type, data) {
        if (type === 'file') {
            await API.files.update(data.id, { is_starred: !data.is_starred });
        } else {
            await API.folders.update(data.id, { is_starred: !data.is_starred });
        }
        Components.toast(data.is_starred ? 'Removed from Starred' : 'Added to Starred', 'success');
        refresh();
    }

    function toggleOffline(fileId) {
        const has = meta.offline_ids.includes(fileId);
        if (has) {
            meta.offline_ids = meta.offline_ids.filter((id) => id !== fileId);
            Components.toast('Removed from Offline', 'info');
        } else {
            meta.offline_ids.push(fileId);
            Components.toast('Added to Offline', 'success');
        }
        saveMeta();
        if (currentPage === 'offline') refresh();
    }

    async function makeCopy(type, data) {
        if (type === 'folder') {
            await API.folders.create(`Copy of ${data.name}`, data.parent_id || null);
            Components.toast('Folder copy created', 'success');
            refresh();
            return;
        }

        const blob = await decryptFileBlob(data);
        const copyName = `Copy of ${data.name}`;
        await uploadEncryptedBlob(blob, copyName, data.mime_type || blob.type, data.folder_id || currentFolderId);
        Components.toast('Copy created', 'success');
        refresh();
    }

    function showFileInfo(type, data) {
        const html = `
            <div style="display:flex;flex-direction:column;gap:10px;">
                <div><span class="modal-label">Name</span>${esc(data.name)}</div>
                <div><span class="modal-label">Type</span>${esc(type === 'folder' ? 'Folder' : (data.mime_type || 'File'))}</div>
                <div><span class="modal-label">Size</span>${type === 'folder' ? '—' : Components.formatSize(data.size)}</div>
                <div><span class="modal-label">Owner</span>${esc(itemOwner(data))}</div>
                <div><span class="modal-label">Modified</span>${Components.formatAbsoluteDate(data.updated_at || data.created_at)}</div>
                <div><span class="modal-label">Created</span>${Components.formatAbsoluteDate(data.created_at)}</div>
            </div>
        `;
        Components.showModal('File information', html, [{ text: 'Close' }]);
    }

    async function removeComputerDevice(data) {
        const name = data.name || 'this device';
        const ok = await Components.confirm(
            'Remove device?',
            `Remove "${name}" and all synced files from FreeDrive? This cannot be undone.`,
            'Remove device',
        );
        if (!ok) return;
        Components.toast('Removing device…', 'info');
        await API.computers.delete(data.computer_id);
        Components.toast('Device removed', 'success');
        clearSelection();
        refresh();
    }

    async function moveToTrash(type, data, isTrash) {
        if (type === 'folder' && isComputerListEntry(data)) {
            await removeComputerDevice(data);
            return;
        }

        // Permanent delete only on the Trash page — ignore stale payload.isTrash.
        if (inTrashView()) {
            const ok = await Components.confirm(
                TrashCopy.deleteForeverTitle,
                TrashCopy.singleDeleteBody(data.name),
                TrashCopy.deleteForeverButton,
            );
            if (!ok) return;
            if (type === 'folder') {
                await API.folders.permanentDelete(data.id);
            } else {
                await API.files.permanentDelete(data.id);
                await CryptoModule.deleteKey(data.id);
            }
            Components.toast(TrashCopy.deleteForeverToast, 'success');
            refresh();
            return;
        }

        if (type === 'file') {
            await API.files.delete(data.id);
        } else {
            const ok = await Components.confirm(
                TrashCopy.moveToTrashTitle,
                TrashCopy.singleMoveBody(data.name),
                TrashCopy.moveToTrashButton,
            );
            if (!ok) return;
            await API.folders.delete(data.id);
        }

        Components.toast(TrashCopy.movedToTrashToast, 'success', {
            actionText: 'Undo',
            onAction: async () => {
                try {
                    if (type === 'file') {
                        await API.files.restore(data.id);
                    } else {
                        await API.folders.restore(data.id);
                    }
                    refresh();
                } catch {
                    Components.toast('Undo failed', 'error');
                }
            },
            duration: 4000,
        });

        refresh();
    }

    function permissionToRole(permission) {
        const p = String(permission || 'read').toLowerCase();
        if (p === 'write' || p === 'upload') return 'editor';
        if (p === 'commenter') return 'commenter';
        return 'viewer';
    }

    function openShareModal(payload) {
        shareTarget = payload;
        shareDraft = [];
        document.getElementById('share-modal-title').textContent = `Share ${payload.data.name}`;

        const key = shareKey(payload.data.id, payload.type);
        const currentAccess = meta.general_access[key] || { access: 'restricted', role: 'viewer' };
        document.getElementById('share-general-access').value = currentAccess.access;
        document.getElementById('share-link-role').value = currentAccess.role;

        renderShareModalState();
        renderShareExisting();
        document.getElementById('share-modal-overlay').classList.remove('hidden');
        document.getElementById('share-people-input').focus();
    }

    function closeShareModal() {
        shareTarget = null;
        shareDraft = [];
        document.getElementById('share-modal-overlay').classList.add('hidden');
        document.getElementById('share-people-input').value = '';
        document.getElementById('share-suggestions').classList.add('hidden');
    }

    async function buildShareLink(itemId) {
        let link = `${location.origin}/#/open/${itemId}`;
        try {
            const key = await CryptoModule.getKey(itemId);
            if (key) {
                const exported = await CryptoModule.exportKey(key);
                link += `?k=${encodeURIComponent(exported)}`;
            }
        } catch {
            // If key export fails, still return base link.
        }
        return link;
    }

    async function copyCurrentShareLink() {
        if (!shareTarget) return;
        const access = document.getElementById('share-general-access')?.value;
        const role = document.getElementById('share-link-role')?.value || 'viewer';
        if (access === 'link' || access === 'anyone') {
            try {
                const payload = shareTarget.type === 'folder'
                    ? { folder_id: shareTarget.data.id, permission: role }
                    : { file_id: shareTarget.data.id, permission: role };
                const created = await API.shares.createLink(payload);
                const link = `${location.origin}/api/v1/public/share/${created.token}/download`;
                await navigator.clipboard.writeText(link);
                Components.toast('Share link copied', 'success');
                return;
            } catch (err) {
                Components.toast(err?.message || 'Failed to create share link', 'error');
                return;
            }
        }
        const me = getCurrentUser();
        const link = await buildShareLink(shareTarget.data.id);
        await navigator.clipboard.writeText(link);
        if (me.role === 'admin') {
            Components.toast('Link copied — only accessible while logged in', 'success');
        } else {
            Components.toast('Link copied to clipboard', 'success');
        }
    }

    function shareKey(itemId, itemType) {
        return `${itemType}:${itemId}`;
    }

    function renderShareSuggestions(query) {
        const box = document.getElementById('share-suggestions');
        if (!box) return;
        box.innerHTML = '';
        if (!query) {
            box.classList.add('hidden');
            return;
        }

        const lower = query.toLowerCase();
        const suggestions = usersCache.filter((u) => {
            return (u.email || '').toLowerCase().includes(lower)
                || (u.username || '').toLowerCase().includes(lower)
                || (u.label || '').toLowerCase().includes(lower);
        }).slice(0, 6);

        if (!suggestions.length) {
            box.classList.add('hidden');
            return;
        }

        suggestions.forEach((u) => {
            const el = document.createElement('button');
            el.className = 'share-suggestion';
            el.textContent = u.label;
            el.type = 'button';
            el.addEventListener('click', () => {
                addShareDraft(u.email || u.label, u.username || u.email, 'viewer', u.id);
                document.getElementById('share-people-input').value = '';
                renderShareSuggestions('');
            });
            box.appendChild(el);
        });

        box.classList.remove('hidden');
    }

    function addShareDraft(email, name, role, userId = '') {
        if (!email) return;
        const exists = shareDraft.some((s) => s.email === email);
        if (exists) return;
        shareDraft.push({ email, name, role, userId });

        const wrap = document.getElementById('share-added');
        const chip = document.createElement('div');
        chip.className = 'share-chip';
        chip.dataset.email = email;
        chip.innerHTML = `
            <span>${esc(name)}</span>
            <select>
                <option value="viewer">Viewer</option>
                <option value="commenter">Commenter</option>
                <option value="editor">Editor</option>
            </select>
            <button type="button" class="link-btn" style="font-size:11px;">Remove</button>
        `;
        chip.querySelector('select').value = role;
        chip.querySelector('select').addEventListener('change', (e) => {
            const found = shareDraft.find((s) => s.email === email);
            if (found) found.role = e.target.value;
        });
        chip.querySelector('button').addEventListener('click', () => {
            shareDraft = shareDraft.filter((s) => s.email !== email);
            chip.remove();
        });
        wrap.appendChild(chip);
    }

    async function renderShareExisting() {
        if (!shareTarget) return;
        const existingWrap = document.getElementById('share-existing');
        existingWrap.innerHTML = '';

        const me = getCurrentUser();

        const ownerRow = document.createElement('div');
        ownerRow.className = 'share-existing-entry';
        
        let savedPhoto = localStorage.getItem('fd_profile_photo');
        if (!savedPhoto) {
            try {
                const prefs = JSON.parse(localStorage.getItem('fd_user_prefs') || '{}');
                if (prefs.profileAvatar) savedPhoto = prefs.profileAvatar;
            } catch (e) {}
        }
        
        let ownerAvatarHtml = savedPhoto 
            ? `<img src="${esc(savedPhoto)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
            : Components.initials(currentUserLabel());

        ownerRow.innerHTML = `
            <div class="share-person">
                <span class="share-avatar">${ownerAvatarHtml}</span>
                <div>
                    <div class="share-name">${esc(currentUserLabel())} <span class="share-email">(${esc(me.email)})</span></div>
                    <div class="share-meta">Owner</div>
                </div>
            </div>
            <span class="owner-pill">Owner</span>
            <span class="share-actions-placeholder"></span>
        `;
        existingWrap.appendChild(ownerRow);

        let entries = [];
        try {
            const data = await API.shares.sharedByMe();
            entries = (data.items || []).filter((item) => {
                if (shareTarget.type === 'file') {
                    return item.item_type === 'file' && item.item_id === shareTarget.data.id;
                }
                return item.item_type === 'folder' && item.item_id === shareTarget.data.id;
            });
        } catch {
            entries = [];
        }

        entries.forEach((item) => {
            const share = item.share || {};
            const recipient = usersCache.find((u) => u.id === share.shared_with);
            const displayName = recipient?.label || recipient?.email || share.shared_with || 'User';
            const row = document.createElement('div');
            row.className = 'share-existing-entry';
            
            let userAvatarHtml = Components.initials(displayName);
            if (recipient?.avatar_url) {
                userAvatarHtml = `<img src="${esc(recipient.avatar_url)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
            }

            row.innerHTML = `
                <div class="share-person">
                    <span class="share-avatar">${userAvatarHtml}</span>
                    <div>
                        <div class="share-name">${esc(displayName)}</div>
                        <div class="share-meta">Shared · ${Components.formatDate(share.created_at)}</div>
                    </div>
                </div>
                <div class="share-existing-actions">
                    <select class="share-role-select">
                        <option value="viewer">Viewer</option>
                        <option value="commenter">Commenter</option>
                        <option value="editor">Editor</option>
                    </select>
                    <button class="link-btn danger share-remove-btn" type="button">Remove</button>
                </div>
            `;
            const sel = row.querySelector('select');
            sel.value = permissionToRole(share.permission);
            sel.addEventListener('change', async () => {
                try {
                    await API.shares.updateUserShare(share.id, { permission: sel.value });
                    Components.toast('Permission updated', 'success');
                } catch (err) {
                    Components.toast(err?.message || 'Failed to update permission', 'error');
                    sel.value = permissionToRole(share.permission);
                }
            });
            row.querySelector('button').addEventListener('click', async () => {
                try {
                    await API.shares.deleteUserShare(share.id);
                    Components.toast('Share removed', 'success');
                    await refreshSharedByMeCache();
                    if (isMyDrivePage()) {
                        renderItems(filteredFolders, filteredFiles);
                    }
                    renderShareExisting();
                } catch (err) {
                    Components.toast(err?.message || 'Failed to remove share', 'error');
                }
            });
            existingWrap.appendChild(row);
        });
    }

    function renderShareModalState() {
        const access = document.getElementById('share-general-access').value;
        const role = document.getElementById('share-link-role').value;
        if (!shareTarget) return;
        meta.general_access[shareKey(shareTarget.data.id, shareTarget.type)] = { access, role };
        saveMeta();
    }

    async function saveShareModal() {
        if (!shareTarget) return;

        const now = new Date().toISOString();
        try {
            for (const d of shareDraft) {
                const payload = {
                    permission: d.role || 'viewer',
                };
                if (d.userId) payload.shared_with = d.userId;
                if (d.email) payload.shared_email = d.email;
                if (shareTarget.type === 'folder') payload.folder_id = shareTarget.data.id;
                else payload.file_id = shareTarget.data.id;
                await API.shares.createUserShare(payload);
                createNotification(`${currentUserLabel()} shared a file with you: ${shareTarget.data.name}`, now, false, d.name || d.email);
            }

            addFileActivity(shareTarget.data.id, 'shared', shareTarget.data.name, now);
            await refreshSharedByMeCache();
            if (isMyDrivePage()) {
                renderItems(filteredFolders, filteredFiles);
            }
            Components.toast('Sharing updated', 'success');
            closeShareModal();
            await copyCurrentShareLink();
        } catch (err) {
            Components.toast(err?.message || 'Failed to save sharing', 'error');
        }
    }

    function createNotification(text, createdAt = new Date().toISOString(), read = false, actor = '') {
        meta.notifications.unshift({
            id: Components.uuid(),
            text,
            created_at: createdAt,
            read,
            actor,
        });
        if (meta.notifications.length > 200) {
            meta.notifications = meta.notifications.slice(0, 200);
        }
        saveMeta();
        refreshNotificationsBadge();
    }

    function refreshNotificationsBadge() {
        const badge = document.getElementById('notifications-badge');
        if (!badge) return;
        const unread = meta.notifications.filter((n) => !n.read).length;
        if (!unread) {
            badge.classList.add('hidden');
            return;
        }
        badge.textContent = String(unread);
        badge.classList.remove('hidden');
    }

    function toggleNotificationsPanel() {
        const panel = document.getElementById('notifications-panel');
        if (!panel) return;
        document.getElementById('details-panel')?.classList.add('hidden');
        document.querySelector('.app')?.classList.remove('details-open');
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) {
            syncNotificationsFromServer().then(() => renderNotifications());
        }
    }

    async function syncNotificationsFromServer() {
        try {
            const data = await API.activity.list(1, 40);
            const me = getCurrentUser();
            if (!me) return;
            const known = new Set(meta.notifications.map((n) => n.id));
            (data.activities || []).forEach((log) => {
                const id = `srv-${log.id}`;
                if (known.has(id)) return;
                const action = String(log.action || '').toLowerCase();
                if (!['login', 'failed_login', 'share', 'upload', 'download', 'delete'].some((k) => action.includes(k))) {
                    return;
                }
                if (log.user_id && log.user_id !== me.id && !action.includes('share')) return;
                const text = log.details || `${log.action} — ${log.target_name || log.target_type || 'item'}`;
                meta.notifications.push({
                    id,
                    text,
                    created_at: log.created_at || new Date().toISOString(),
                    read: false,
                    actor: log.username || '',
                    source: 'server',
                });
                known.add(id);
            });
            if (meta.notifications.length > 200) {
                meta.notifications = meta.notifications.slice(0, 200);
            }
            saveMeta();
            updateNotificationsBadge();
        } catch {
            // keep local notifications if activity fetch fails
        }
    }

    function notifIconType(text) {
        const t = String(text || '').toLowerCase();
        if (t.includes('upload'))   return 'upload';
        if (t.includes('download')) return 'download';
        if (t.includes('delete') || t.includes('trash') || t.includes('removed')) return 'delete';
        if (t.includes('share') || t.includes('access'))  return 'share';
        if (t.includes('login') || t.includes('sign in')) return 'login';
        return 'default';
    }

    const notifIcons = {
        upload:   `<svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/></svg>`,
        download: `<svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M5 20h14v-2H5m14-9h-4V3H9v6H5l7 7 7-7z"/></svg>`,
        delete:   `<svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`,
        share:    `<svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M18 16.08a2.9 2.9 0 0 0-1.96.77L8.91 12.7a2.9 2.9 0 0 0 0-1.39l7.05-4.11A2.99 2.99 0 1 0 15 5a2.9 2.9 0 0 0 .09.7L8.04 9.81A3 3 0 1 0 8 14.19l7.12 4.16a2.96 2.96 0 1 0 2.88-2.27z"/></svg>`,
        login:    `<svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>`,
        default:  `<svg width="18" height="18" fill="currentColor" viewBox="0 0 24 24"><path d="M12 22c1.1 0 1.99-.9 1.99-2h-4A2 2 0 0012 22zm6-6V11c0-3.07-1.63-5.64-4.5-6.32V4a1.5 1.5 0 00-3 0v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>`,
    };

    function renderNotifications() {
        const list = document.getElementById('notifications-list');
        if (!list) return;

        if (!meta.notifications.length) {
            list.innerHTML = `
                <div class="notif-empty">
                    <div class="notif-empty-icon">
                        <svg width="28" height="28" fill="currentColor" viewBox="0 0 24 24"><path d="M12 22c1.1 0 1.99-.9 1.99-2h-4A2 2 0 0012 22zm6-6V11c0-3.07-1.63-5.64-4.5-6.32V4a1.5 1.5 0 00-3 0v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>
                    </div>
                    <p>You're all caught up</p>
                    <span>No new notifications</span>
                </div>`;
            return;
        }

        const today     = new Date(); today.setHours(0,0,0,0);
        const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);

        const groups = { Today: [], Yesterday: [], Older: [] };
        meta.notifications.forEach((n) => {
            const d = new Date(n.created_at); d.setHours(0,0,0,0);
            if (d >= today)          groups.Today.push(n);
            else if (d >= yesterday) groups.Yesterday.push(n);
            else                     groups.Older.push(n);
        });

        list.innerHTML = '';

        let delayIndex = 0;
        Object.entries(groups).forEach(([label, items]) => {
            if (!items.length) return;

            const header = document.createElement('div');
            header.className = 'notif-group-label';
            header.textContent = label;
            header.style.setProperty('--fd-i', delayIndex++);
            list.appendChild(header);

            items.forEach((n) => {
                const type = notifIconType(n.text);
                const row = document.createElement('div');
                row.className = `notification-item ${n.read ? '' : 'unread'}`;
                row.innerHTML = `
                    <div class="notif-icon-wrap ${type}">${notifIcons[type]}</div>
                    <div class="notification-body">
                        ${esc(n.text)}
                        <div class="notification-time">${Components.formatDate(n.created_at)}</div>
                    </div>
                    ${n.read ? '' : '<span class="notif-unread-dot"></span>'}
                `;
                row.style.setProperty('--fd-i', delayIndex++);
                row.addEventListener('click', () => {
                    n.read = true;
                    saveMeta();
                    refreshNotificationsBadge();
                    row.classList.remove('unread');
                    row.querySelector('.notif-unread-dot')?.remove();
                });
                list.appendChild(row);
            });
        });
    }

    function markAllNotificationsRead() {
        meta.notifications.forEach((n) => { n.read = true; });
        saveMeta();
        refreshNotificationsBadge();
        renderNotifications();
        Components.toast('All notifications marked as read', 'success');
    }

    function addFileActivity(fileId, actionStr, filename, when = new Date().toISOString()) {
        if (!meta.file_activity[fileId]) meta.file_activity[fileId] = [];
        meta.file_activity[fileId].unshift({
            id: Components.uuid(),
            text: `${currentUserLabel()} ${actionStr} ${filename}`, // backward compat
            action: actionStr,
            filename: filename,
            created_at: when,
        });
        if (meta.file_activity[fileId].length > 100) {
            meta.file_activity[fileId] = meta.file_activity[fileId].slice(0, 100);
        }
        saveMeta();
    }

    async function bulkShare() {
        if (!selectedItems.size) return;
        const ids = Array.from(selectedItems);
        if (ids.length === 1) {
            const item = findSelectedPayload(ids[0]);
            if (item) openShareModal(item);
            return;
        }

        const email = await Components.prompt('Share selected items', '', 'name@example.com');
        if (!email) return;
        const role = await Components.prompt('Role (viewer/commenter/editor)', 'viewer');
        if (!role) return;

        const now = new Date().toISOString();
        try {
            for (const id of ids) {
                const payload = findSelectedPayload(id);
                if (!payload) continue;
                const body = {
                    permission: role,
                    shared_email: email,
                };
                if (payload.type === 'folder') body.folder_id = id;
                else body.file_id = id;
                await API.shares.createUserShare(body);
                addFileActivity(id, 'shared', payload.data.name, now);
            }
            Components.toast('Shared selected items', 'success');
        } catch (err) {
            Components.toast(err?.message || 'Failed to share items', 'error');
        }
    }

    async function bulkDownload() {
        const ids = Array.from(selectedItems);
        if (!ids.length) return;
        const payloads = ids.map((id) => findSelectedPayload(id)).filter(Boolean);
        await downloadPayloadListAsZip(payloads, `drive-selection-${Date.now()}.zip`);
    }

    async function bulkMove() {
        const ids = Array.from(selectedItems);
        if (!ids.length) return;
        const folderId = await Components.prompt('Move selected to folder ID', currentFolderId || '');
        if (folderId === null) return;
        for (const id of ids) {
            const payload = findSelectedPayload(id);
            if (!payload) continue;
            if (payload.type === 'file') {
                await API.files.update(id, { folder_id: folderId || '' });
            } else {
                await API.folders.update(id, { parent_id: folderId || '' });
            }
        }
        Components.toast('Moved selected items', 'success');
        refresh();
    }

    async function bulkDelete() {
        const ids = Array.from(selectedItems);
        if (!ids.length) return;

        if (currentPage === 'computers' && !currentFolderId) {
            const devices = ids
                .map((id) => findSelectedPayload(id))
                .filter((payload) => payload && isComputerListEntry(payload.data));
            if (!devices.length) return;
            const ok = await Components.confirm(
                'Remove devices?',
                `Remove ${devices.length} device(s) and all synced files from FreeDrive? This cannot be undone.`,
                'Remove devices',
            );
            if (!ok) return;
            for (const payload of devices) {
                await API.computers.delete(payload.data.computer_id);
            }
            clearSelection();
            Components.toast('Devices removed', 'success');
            refresh();
            return;
        }

        if (inTrashView()) {
            const count = ids.length;
            const ok = await Components.confirm(
                TrashCopy.deleteForeverTitle,
                TrashCopy.bulkDeleteBody(count),
                TrashCopy.deleteForeverButton,
            );
            if (!ok) return;
            for (const id of ids) {
                const payload = findSelectedPayload(id);
                if (payload && payload.type === 'folder') {
                    await API.folders.permanentDelete(id);
                } else {
                    await API.files.permanentDelete(id);
                    await CryptoModule.deleteKey(id);
                }
            }
            clearSelection();
            Components.toast(TrashCopy.deleteForeverToast, 'success');
            refresh();
            return;
        }

        const ok = await Components.confirm(
            TrashCopy.moveToTrashTitle,
            TrashCopy.bulkMoveBody(),
            TrashCopy.moveToTrashButton,
        );
        if (!ok) return;
        for (const id of ids) {
            const payload = findSelectedPayload(id);
            if (!payload) continue;
            if (payload.type === 'file') {
                await API.files.delete(id);
            } else {
                await API.folders.delete(id);
            }
        }
        clearSelection();
        Components.toast(TrashCopy.movedToTrashToast, 'success');
        refresh();
        if (currentPage === 'files') SidebarTree.refresh(currentFolderId || null);
    }

    async function bulkRestore() {
        const ids = Array.from(selectedItems);
        if (!ids.length) return;
        for (const id of ids) {
            const payload = findSelectedPayload(id);
            if (payload && payload.type === 'folder') {
                await API.folders.restore(id);
            } else {
                await API.files.restore(id);
            }
        }
        clearSelection();
        Components.toast(TrashCopy.restoredToast(ids.length), 'success');
        refresh();
    }

    function findSelectedPayload(id) {
        const inFolders = filteredFolders.find((f) => f.id === id);
        if (inFolders) return { type: 'folder', data: inFolders, isTrash: currentPage === 'trash' };
        const inFiles = filteredFiles.find((f) => f.id === id);
        if (inFiles) return { type: 'file', data: inFiles, isTrash: currentPage === 'trash' };
        return null;
    }

    function getIconLarge(type, mime, name = '') {
        const group = getMimeGroup(mime, type, name);
        const colors = {
            folder:   ['#5f6368', '#5f6368'],
            image:    ['#34a853', '#2d9248'],
            video:    ['#ea4335', '#d33427'],
            audio:    ['#a142f4', '#8e35d9'],
            pdf:      ['#ea4335', '#d33427'],
            sheet:    ['#34a853', '#2d9248'],
            text:     ['#4285f4', '#3367d6'],
            document: ['#5f6368', '#5f6368'],
        };
        const c = colors[group] || colors.document;

        const svgs = {
            folder: `<svg viewBox="0 0 24 24" width="48" height="48"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" fill="${c[0]}"/></svg>`,
            image:  `<svg viewBox="0 0 24 24" width="48" height="48"><path d="M21 19V5c0-1.1-.9-2-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5A1.5 1.5 0 1 1 8.5 10a1.5 1.5 0 0 1 0 3.5zM5 18l3.5-4.5 2.5 3 3.5-4.5 4.5 6H5z" fill="${c[0]}"/></svg>`,
            video:  `<svg viewBox="0 0 24 24" width="48" height="48"><path d="M17 10.5V7c0-1.1-.9-2-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10c1.1 0 2-.9 2-2v-3.5l4 4v-11l-4 4z" fill="${c[0]}"/></svg>`,
            audio:  `<svg viewBox="0 0 24 24" width="48" height="48"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55a4 4 0 1 0 4 4V7h4V3h-6z" fill="${c[0]}"/></svg>`,
            pdf:    `<svg viewBox="0 0 24 24" width="48" height="48"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z" fill="${c[0]}"/><path d="M14 3.5V9h5.5" fill="rgba(255,255,255,0.6)"/><text x="6" y="20" font-size="5" font-family="Arial" font-weight="bold" fill="white">PDF</text></svg>`,
            sheet:  `<svg viewBox="0 0 24 24" width="48" height="48"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z" fill="${c[0]}"/><path d="M14 3.5V9h5.5" fill="rgba(255,255,255,0.6)"/><path d="M8 11h8v2H8zm0 3h8v2H8zm0 3h5v2H8z" fill="rgba(255,255,255,0.9)"/></svg>`,
            text:   `<svg viewBox="0 0 24 24" width="48" height="48"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z" fill="${c[0]}"/><path d="M14 3.5V9h5.5" fill="rgba(255,255,255,0.6)"/><path d="M8 12h8v1.6H8zm0 3h8v1.6H8zm0 3h5v1.6H8z" fill="rgba(255,255,255,0.9)"/></svg>`,
            document:`<svg viewBox="0 0 24 24" width="48" height="48"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z" fill="${c[0]}"/><path d="M14 3.5V9h5.5" fill="rgba(255,255,255,0.6)"/><path d="M8 12h8v1.6H8zm0 3h8v1.6H8zm0 3h5v1.6H8z" fill="rgba(255,255,255,0.9)"/></svg>`,
        };
        const ext = getFileExtension(name);
        const codeExts = {
            js: { bg: '#fbbc05', label: 'JS' },
            ts: { bg: '#3178c6', label: 'TS' },
            jsx: { bg: '#61dafb', label: 'JSX' },
            tsx: { bg: '#3178c6', label: 'TSX' },
            py: { bg: '#3572A5', label: 'PY' },
            css: { bg: '#264de4', label: 'CSS' },
            html: { bg: '#e34c26', label: 'HTML' },
            json: { bg: '#4285f4', label: 'JSON' },
            yml: { bg: '#6f7378', label: 'YML' },
            yaml: { bg: '#6f7378', label: 'YAML' },
            sh: { bg: '#4eaa25', label: 'SH' },
            go: { bg: '#00add8', label: 'GO' },
            rs: { bg: '#dea584', label: 'RS' },
            md: { bg: '#083fa1', label: 'MD' },
            txt: { bg: '#5f6368', label: 'TXT' },
        };
        if (type === 'file' && codeExts[ext]) {
            const ce = codeExts[ext];
            return `<div class="details-preview-icon">
                <svg viewBox="0 0 80 100" width="80" height="100">
                    <path d="M50 0H10a6 6 0 0 0-6 6v88a6 6 0 0 0 6 6h60a6 6 0 0 0 6-6V26L50 0z" fill="${ce.bg}"/>
                    <path d="M50 0v20a6 6 0 0 0 6 6h20" fill="rgba(255,255,255,0.3)"/>
                    <rect x="14" y="38" width="36" height="3" rx="1.5" fill="rgba(255,255,255,0.7)"/>
                    <rect x="14" y="46" width="28" height="3" rx="1.5" fill="rgba(255,255,255,0.5)"/>
                    <rect x="14" y="54" width="42" height="3" rx="1.5" fill="rgba(255,255,255,0.7)"/>
                    <rect x="14" y="62" width="20" height="3" rx="1.5" fill="rgba(255,255,255,0.5)"/>
                    <rect x="14" y="70" width="32" height="3" rx="1.5" fill="rgba(255,255,255,0.7)"/>
                    <rect x="14" y="78" width="24" height="3" rx="1.5" fill="rgba(255,255,255,0.5)"/>
                    <rect x="28" y="86" width="44" height="13" rx="3" fill="rgba(0,0,0,0.25)"/>
                    <text x="50" y="96" font-size="9" font-family="Google Sans,Arial" font-weight="700" fill="#fff" text-anchor="middle">${ce.label}</text>
                </svg>
            </div>`;
        }
        return `<div class="details-preview-icon">${svgs[group] || svgs.document}</div>`;
    }

    async function openDetailsPanel(payload) {
        if (!payload) return;
        const panel = document.getElementById('details-panel');
        if (!panel) return;
        document.getElementById('notifications-panel')?.classList.add('hidden');
        panel.classList.remove('hidden');
        document.querySelector('.app')?.classList.add('details-open');

        const { data, type } = payload;
        const preview = document.getElementById('details-preview');
        const nameInput = document.getElementById('details-name');
        nameInput.value = data.name;
        nameInput.removeAttribute('readonly');

        const headerIcon = document.getElementById('details-header-icon');
        if (headerIcon) headerIcon.innerHTML = getIcon(type, data.mime_type, data.name);

        // show large icon initially
        preview.innerHTML = getIconLarge(type, data.mime_type, data.name);
        
        // Ensure old listeners are cleared by cloning and replacing
        const newPreview = preview.cloneNode(true);
        preview.parentNode.replaceChild(newPreview, preview);
        newPreview.style.cursor = 'pointer';
        newPreview.addEventListener('click', () => {
            if (type === 'file') {
                openFile(data);
            } else if (type === 'folder') {
                window.location.hash = `#/files/${data.id}`;
            }
        });

        // load image thumbnail if applicable
        if (type === 'file' && getMimeGroup(data.mime_type, type, data.name) === 'image') {
            try {
                const blob = await decryptFileBlob(data);
                const url = URL.createObjectURL(blob);
                newPreview.innerHTML = `<img src="${url}" alt="${esc(data.name)}">`;
            } catch {
                // keep icon fallback
            }
        }

        // hide delete/rename for read-only shared items
        const isOwned = !data.shared_by_name;
        const isTrash = isTrashMode(payload);
        const detailsShareBtn = document.getElementById('details-share-btn');
        const detailsShareBtn2 = document.getElementById('details-share-btn2');
        document.getElementById('details-rename-btn')?.style.setProperty('display', isOwned && !isTrash ? '' : 'none');
        document.getElementById('details-delete-btn')?.style.setProperty('display', isOwned ? '' : 'none');
        if (!isOwned) nameInput.setAttribute('readonly', '');
        if (detailsShareBtn) detailsShareBtn.style.setProperty('display', isTrash ? 'none' : '');
        if (detailsShareBtn2) detailsShareBtn2.style.setProperty('display', isTrash ? 'none' : '');
        syncTrashActionLabels(payload);

        // hide download for folders
        document.getElementById('details-download-btn')?.style.setProperty('display', type === 'folder' ? 'none' : '');

        renderAccessAvatars(data.id, type);
        renderDetailsProperties(payload);
        renderDetailsActivity(payload);

        // reset to Details tab
        document.querySelectorAll('.m3-details-tabs .tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelector('.m3-details-tabs [data-tab="properties"]')?.classList.add('active');
        document.getElementById('details-properties')?.classList.remove('hidden');
        document.getElementById('details-activity')?.classList.add('hidden');
    }

    function hideDetailsPanel() {
        document.getElementById('details-panel')?.classList.add('hidden');
        document.querySelector('.app')?.classList.remove('details-open');
    }

    async function renderAccessAvatars(itemId, itemType) {
        const wrap = document.getElementById('access-avatars');
        if (!wrap) return;
        wrap.innerHTML = '';

        const me = getCurrentUser();
        let entries = [];
        try {
            const data = await API.shares.sharedByMe();
            entries = (data.items || []).filter((item) => {
                if (itemType === 'file') return item.item_type === 'file' && item.item_id === itemId;
                return item.item_type === 'folder' && item.item_id === itemId;
            });
        } catch {
            entries = [];
        }

        const names = [currentUserLabel()].concat(entries.map((item) => {
            const recipient = usersCache.find((u) => u.id === item.share?.shared_with);
            return recipient?.label || recipient?.email || 'User';
        }));

        names.slice(0, 6).forEach((name) => {
            const el = document.createElement('div');
            el.className = 'access-avatar';
            el.title = name;
            el.textContent = Components.initials(name);
            wrap.appendChild(el);
        });

        const descEl = document.getElementById('access-desc');
        if (descEl) {
            if (entries.length) {
                const extra = names.length > 6 ? ` +${names.length - 6} more` : '';
                descEl.textContent = `Shared with ${entries.length} person${entries.length > 1 ? 's' : ''}${extra}`;
            } else {
                descEl.textContent = me.role === 'admin' ? 'Only you (admin) have access' : 'Only you have access';
            }
        }
    }

    function renderDetailsProperties(payload) {
        const box = document.getElementById('details-properties');
        if (!box) return;
        const { data, type } = payload;
        const desc = meta.descriptions[data.id] || '';
        const locationLabel = buildLocationLabel(data.folder_id);
        const ownerName = data.last_modified_by || itemOwner(data);
        const isFolder = type === 'folder';
        const stats = isFolder ? folderStatsCache.get(data.id) : null;
        // sharedRows uses propRow — defined later in this function
        const ICON_PERSON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`;
        const ICON_CLOCK  = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`;
        const ICON_KEY    = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12.65 10A6 6 0 1 0 13 16h7v-2h-2v-2h-2v2h-1.35A6.003 6.003 0 0 0 12.65 10zM7 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>`;
        function sharedPropRow(iconSvg, label, valueHTML) {
            return `<div class="property-item"><span class="property-icon">${iconSvg}</span><span class="property-content"><span class="property-label">${label}</span><span class="property-value">${valueHTML}</span></span></div>`;
        }
        const sharedRows = currentPage === 'shared-with'
            ? sharedPropRow(ICON_PERSON, 'Shared by',   esc(data.shared_by_name || 'User'))
              + sharedPropRow(ICON_CLOCK,  'Date shared', Components.formatAbsoluteDate(data.shared_at || data.updated_at || data.created_at))
              + sharedPropRow(ICON_KEY,    'Access',      esc(capitalizeRole(data.share_role || 'viewer')))
            : '';

        function formatMimeType(mime, filename) {
            if (!mime) return 'File';
            const m = mime.toLowerCase();
            const n = (filename || '').toLowerCase();
            if (m.includes('python') || n.endsWith('.py')) return 'Python Script';
            if (m.includes('javascript') || n.endsWith('.js')) return 'JavaScript File';
            if (m.includes('octet-stream') || m.includes('binary')) {
                if (n.includes('.')) return n.split('.').pop().toUpperCase() + ' File';
                return 'Configuration File'; // Often dockerignore, gitignore, etc.
            }
            if (m.includes('text/plain')) return 'Text File';
            if (m.includes('markdown') || n.endsWith('.md')) return 'Markdown Document';
            if (m.includes('html')) return 'HTML Document';
            if (m.includes('json') || n.endsWith('.json')) return 'JSON File';
            if (m.includes('yaml') || m.includes('yml') || n.endsWith('.yml')) return 'YAML Configuration';
            if (m.includes('shell') || m.includes('sh') || m.includes('bash') || n.endsWith('.sh')) return 'Shell Script';
            if (m.includes('image/jpeg') || m.includes('jpg')) return 'JPEG Image';
            if (m.includes('image/png')) return 'PNG Image';
            if (m.includes('image/gif')) return 'GIF Image';
            if (m.includes('image/')) return 'Image File';
            if (m.includes('pdf')) return 'PDF Document';
            if (m.includes('audio/')) return 'Audio File';
            if (m.includes('video/')) return 'Video File';
            if (m.includes('zip') || m.includes('archive')) return 'ZIP Archive';
            if (m.includes('msword') || m.includes('wordprocessing')) return 'Word Document';
            if (m.includes('excel') || m.includes('spreadsheet')) return 'Excel Spreadsheet';
            if (m.includes('powerpoint') || m.includes('presentation')) return 'PowerPoint Presentation';
            return mime;
        }

        const typeValue = isFolder
            ? (stats
                ? `Folder · ${stats.folders} folder${stats.folders === 1 ? '' : 's'} · ${stats.files} file${stats.files === 1 ? '' : 's'}`
                : 'Folder')
            : formatMimeType(data.mime_type, data.name);

        const folderSizeValue = isFolder
            ? (stats ? formatSizeStrict(stats.bytes) : 'Calculating...')
            : formatSizeStrict(data.size);

        const ICONS = {
            type:     `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`,
            size:     `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V6h5.17l2 2H20v10z"/></svg>`,
            location: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`,
            owner:    `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`,
            modified: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`,
            created:  `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`,
            desc:     `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M14 17H4v2h10v-2zm6-8H4v2h16V9zM4 15h16v-2H4v2zM4 5v2h16V5H4z"/></svg>`,
            access:   `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zM8 11c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.98 1.97 3.45V19h7v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`,
        };

        function propRow(iconKey, label, valueHTML) {
            return `<div class="property-item">
                <span class="property-icon">${ICONS[iconKey]}</span>
                <span class="property-content">
                    <span class="property-label">${label}</span>
                    <span class="property-value">${valueHTML}</span>
                </span>
            </div>`;
        }

        box.innerHTML = `
            <div class="details-section-title">Details</div>
            ${propRow('type',     'Type',         esc(typeValue))}
            ${propRow('size',     'Size',         esc(folderSizeValue))}
            ${propRow('location', 'Location',     `<a href="#/files${data.folder_id ? `/${data.folder_id}` : ''}">${esc(locationLabel)}</a>`)}
            ${propRow('owner',    'Owner',        esc(itemOwner(data)))}
            ${sharedRows}
            ${propRow('modified', 'Modified',     `${Components.formatAbsoluteDate(data.updated_at || data.created_at)}<br><span style="color:#5f6368;font-size:12px;">by ${esc(ownerName)}</span>`)}
            ${propRow('created',  'Created',      Components.formatAbsoluteDate(data.created_at))}
            <div class="panel-sep"></div>
            <div class="property-item">
                <span class="property-icon">${ICONS.desc}</span>
                <span class="property-content">
                    <span class="property-label">Description</span>
                    <textarea id="details-description" placeholder="Add a description">${esc(desc)}</textarea>
                </span>
            </div>
        `;

        document.getElementById('details-description')?.addEventListener('change', (e) => {
            meta.descriptions[data.id] = e.target.value;
            saveMeta();
        });

        if (isFolder && !folderStatsCache.has(data.id)) {
            calculateFolderStats(data.id)
                .then(() => {
                    if (!selectedPrimary || selectedPrimary.type !== 'folder' || selectedPrimary.data.id !== data.id) return;
                    renderDetailsProperties({ type: selectedPrimary.type, data: selectedPrimary.data, isTrash: selectedPrimary.isTrash });
                })
                .catch(() => {
                    if (!selectedPrimary || selectedPrimary.type !== 'folder' || selectedPrimary.data.id !== data.id) return;
                    folderStatsCache.set(data.id, { bytes: 0, files: 0, folders: 0 });
                    renderDetailsProperties({ type: selectedPrimary.type, data: selectedPrimary.data, isTrash: selectedPrimary.isTrash });
                });
        }
    }

    async function renderDetailsActivity(payload) {
        const box = document.getElementById('details-activity');
        if (!box) return;
        const { data, type } = payload;
        const list = meta.file_activity[data.id] || [];
        const me = getCurrentUser();

        let html = `<div class="details-section-title">Activity</div>`;
        if (!list.length) {
            html += `<div style="padding:16px;color:#5f6368;font-size:13px;font-family:'Roboto',Arial,sans-serif;">No local activity yet.</div>`;
        } else {
            html += list.map((a) => `
                <div class="activity-item">
                    <div class="activity-avatar">${Components.initials(a.text)}</div>
                    <div class="activity-body">
                        <div class="activity-text">${esc(a.text)}</div>
                        <div class="activity-time">${Components.formatDate(a.created_at)}</div>
                    </div>
                </div>
            `).join('');
        }

        if (type === 'file') {
            html += `<div class="details-section-title" style="margin-top:16px;">Comments</div>`;
            let comments = [];
            try {
                const res = await API.comments.list(data.id);
                comments = res.comments || [];
                if (!comments.length) {
                    html += `<div style="padding:8px 16px;color:#5f6368;font-size:13px;">No comments yet.</div>`;
                } else {
                    html += comments.map((c) => {
                        const canDelete = me && (c.user_id === me.id || canWriteFileItem(data));
                        const assigneeBadge = c.assigned_to_username || c.assigned_to
                            ? `<span style="font-size:11px;color:#5f6368;margin-left:6px;">→ ${esc(c.assigned_to_username || lookupUserLabel(c.assigned_to))}</span>`
                            : '';
                        return `
                        <div class="activity-item" data-comment-id="${esc(c.id)}">
                            <div class="activity-avatar">${Components.initials(c.username || 'U')}</div>
                            <div class="activity-body" style="flex:1;">
                                <div class="activity-text">${esc(c.content)}${assigneeBadge}</div>
                                <div class="activity-time">${Components.formatDate(c.created_at)}</div>
                            </div>
                            ${canDelete ? `<button class="btn-icon comment-delete-btn" data-id="${esc(c.id)}" title="Delete comment" aria-label="Delete comment" style="align-self:flex-start;">✕</button>` : ''}
                        </div>`;
                    }).join('');
                }
                html += `
                    <div style="padding:16px;">
                        <textarea id="detail-comment-input" placeholder="Add a comment..." style="width:100%;min-height:64px;border-radius:8px;border:1px solid var(--fd-border);padding:8px;font-family:inherit;"></textarea>
                        <input id="detail-comment-assignee" type="email" placeholder="Assign to (email, optional)" style="width:100%;margin-top:8px;border-radius:8px;border:1px solid var(--fd-border);padding:8px;font-family:inherit;" autocomplete="off">
                        <button class="btn btn-primary btn-sm" id="detail-comment-submit" style="margin-top:8px;">Comment</button>
                    </div>`;
            } catch {
                html += `<div style="padding:8px 16px;color:#5f6368;font-size:13px;">Comments unavailable.</div>`;
            }

            try {
                const approvalRes = await API.approvals.list('');
                const fileApprovals = (approvalRes.approvals || []).filter((a) => a.file_id === data.id);
                const hasPending = fileApprovals.some((a) => a.status === 'pending');
                const canRequest = canWriteFileItem(data) && !hasPending;

                html += `<div class="details-section-title" style="margin-top:16px;">Approvals</div>`;
                if (!fileApprovals.length) {
                    html += `<div style="padding:8px 16px;color:#5f6368;font-size:13px;">No approval requests yet.</div>`;
                } else {
                    fileApprovals.forEach((a) => {
                        const status = String(a.status || 'pending').toLowerCase();
                        const canResolve = me && a.approver_id === me.id && status === 'pending';
                        const isRequester = me && a.requested_by === me.id;
                        let statusText = status.charAt(0).toUpperCase() + status.slice(1);
                        if (status === 'pending' && isRequester) {
                            statusText = `Awaiting ${esc(lookupUserLabel(a.approver_id))}`;
                        } else if (status === 'pending') {
                            statusText = `Pending — approver: ${esc(lookupUserLabel(a.approver_id))}`;
                        }
                        html += `
                            <div class="activity-item" data-approval-id="${esc(a.id)}">
                                <div class="activity-body">
                                    <div class="activity-text">${statusText}</div>
                                    <div class="activity-time">${Components.formatDate(a.created_at)}</div>
                                    ${canResolve ? `
                                        <div style="margin-top:8px;display:flex;gap:8px;">
                                            <button class="btn btn-primary btn-sm approval-approve-btn" data-id="${esc(a.id)}">Approve</button>
                                            <button class="btn btn-secondary btn-sm approval-reject-btn" data-id="${esc(a.id)}">Reject</button>
                                        </div>` : ''}
                                </div>
                            </div>`;
                    });
                }
                if (canRequest) {
                    html += `
                        <div style="padding:8px 16px 16px;">
                            <button class="btn btn-secondary btn-sm" id="detail-request-approval-btn">Request approval</button>
                        </div>`;
                }
            } catch {
                // approvals optional
            }
        }

        box.innerHTML = html;

        document.getElementById('detail-comment-submit')?.addEventListener('click', async () => {
            const input = document.getElementById('detail-comment-input');
            const assigneeInput = document.getElementById('detail-comment-assignee');
            const content = String(input?.value || '').trim();
            if (!content) return;
            const body = { content };
            const assigneeEmail = String(assigneeInput?.value || '').trim();
            if (assigneeEmail) body.assigned_to_email = assigneeEmail;
            try {
                await API.comments.create(data.id, body);
                input.value = '';
                if (assigneeInput) assigneeInput.value = '';
                await renderDetailsActivity(payload);
                Components.toast('Comment added', 'success');
            } catch (err) {
                Components.toast(err?.message || 'Failed to add comment', 'error');
            }
        });

        box.querySelectorAll('.comment-delete-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                try {
                    await API.comments.delete(data.id, btn.dataset.id);
                    Components.toast('Comment deleted', 'success');
                    await renderDetailsActivity(payload);
                } catch (err) {
                    Components.toast(err?.message || 'Failed to delete comment', 'error');
                }
            });
        });

        document.getElementById('detail-request-approval-btn')?.addEventListener('click', async () => {
            await requestApprovalForFile(data);
            await renderDetailsActivity(payload);
        });

        box.querySelectorAll('.approval-approve-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                try {
                    await API.approvals.update(btn.dataset.id, { status: 'approved' });
                    Components.toast('Approval granted', 'success');
                    await renderDetailsActivity(payload);
                } catch (err) {
                    Components.toast(err?.message || 'Failed to approve', 'error');
                }
            });
        });
        box.querySelectorAll('.approval-reject-btn').forEach((btn) => {
            btn.addEventListener('click', async () => {
                try {
                    await API.approvals.update(btn.dataset.id, { status: 'rejected' });
                    Components.toast('Approval rejected', 'success');
                    await renderDetailsActivity(payload);
                } catch (err) {
                    Components.toast(err?.message || 'Failed to reject', 'error');
                }
            });
        });
    }

    function buildLocationLabel(folderId) {
        if (!folderId) return currentPage === 'computers' ? 'Computers' : 'My Drive';
        if (currentComputerContext) {
            const folder = allFolders.find((f) => f.id === folderId);
            if (folder) return `Computers > ${currentComputerContext.name} > ${folder.name}`;
            if (folderId === currentComputerContext.root_folder_id) {
                return `Computers > ${currentComputerContext.name}`;
            }
        }
        const folder = allFolders.find((f) => f.id === folderId);
        if (!folder) return 'My Drive';
        return `My Drive > ${folder.name}`;
    }

    async function loadActivity() {
        currentPage = 'activity';
        currentFolderId = null;
        clearSelection();
        showActivityView();

        const filter = document.getElementById('activity-filter')?.value || 'all';
        const list = document.getElementById('activity-list');
        list.innerHTML = '<div class="loading-state" style="min-height:180px;"><div class="spinner"></div></div>';

        const me = getCurrentUser() || { id: 'unknown' };
        const isAdmin = String(me.role || '').toLowerCase() === 'admin';

        // Fetch server activity. Only fall back to the admin endpoint for admins
        // (a non-admin would get 403 there and double-fault).
        let logs = [];
        try {
            const data = await API.activity.list(1, 120);
            logs = data.activities || [];
        } catch (err) {
            console.error('loadActivity fetch error (/activity):', err);
            if (isAdmin) {
                try {
                    const data = await API.admin.activity(1, 120);
                    logs = data.activities || [];
                } catch (err2) {
                    console.error('loadActivity fetch error (/admin/activity):', err2);
                    list.innerHTML = '';
                    Components.toast('Failed to load activity', 'error');
                    setBreadcrumbText('Activity');
                    return;
                }
            } else {
                list.innerHTML = '';
                Components.toast('Failed to load activity', 'error');
                setBreadcrumbText('Activity');
                return;
            }
        }

        try {
            const extra = Object.values(meta.file_activity || {})
                .flat()
                .map((it) => ({
                    username: currentUserLabel(),
                    action: it.action || 'local_event',
                    target_name: it.filename || it.text,
                    created_at: it.created_at,
                    user_id: me.id,
                }));

            let merged = logs.concat(extra).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

            if (filter === 'me') {
                merged = merged.filter((a) => a.user_id === me.id || a.username === currentUserLabel());
            }
            if (filter === 'others') {
                merged = merged.filter((a) => a.user_id && a.user_id !== me.id);
            }

            if (!merged.length) {
                list.innerHTML = '<div class="empty-state" style="min-height:220px;"><p>No activity yet</p></div>';
                return;
            }
            let myAvatar = '';
            try {
                myAvatar = JSON.parse(localStorage.getItem('fd_user_prefs') || '{}').profileAvatar || '';
            } catch {}

            // The activity feed only needs recent items; capping also prevents a
            // huge joined string (RangeError: Invalid string length).
            const MAX_ACTIVITY_ROWS = 100;
            merged = merged.slice(0, MAX_ACTIVITY_ROWS);

            // Inject the (potentially large base64) avatar ONCE via a scoped CSS
            // rule instead of inlining it into every row's style attribute.
            const meAvatarCss = myAvatar
                ? `#activity-list .activity-avatar.is-me{background-image:url("${myAvatar}");background-size:cover;background-position:center;color:transparent;}`
                : '';

            const rows = merged.map((a) => {
                try {
                    const actor = a.username || 'User';
                    const isMe = a.user_id === me.id || actor === currentUserLabel();
                    const showPhoto = isMe && myAvatar;

                    let textHtml = '';
                    if (a.action === 'local_event') {
                        // old format backwards compatibility
                        textHtml = `<div class="activity-text">${esc(a.target_name)}</div>`;
                    } else {
                        const action = formatAction(a.action);
                        textHtml = `<div class="activity-text"><strong>${esc(actor)}</strong> ${esc(action)} <strong>${esc(a.target_name || 'item')}</strong></div>`;
                    }

                    return `
                    <div class="activity-item">
                        <div class="activity-avatar${showPhoto ? ' is-me' : ''}">${showPhoto ? '' : esc(Components.initials(actor))}</div>
                        <div>
                            ${textHtml}
                            <div class="activity-time">${Components.formatAbsoluteDate(a.created_at)}</div>
                        </div>
                    </div>
                `;
                } catch (rowErr) {
                    console.error('loadActivity row error:', rowErr, a);
                    return '';
                }
            }).join('');

            list.innerHTML = `<style>${meAvatarCss}</style>` + rows;
        } catch (err) {
            console.error('loadActivity error:', err);
            list.innerHTML = '';
            Components.toast('Failed to load activity', 'error');
        }

        setBreadcrumbText('Activity');
    }

    function formatAction(action) {
        const map = {
            upload: 'uploaded',
            view: 'viewed',
            download: 'downloaded',
            share: 'shared',
            move: 'moved',
            delete: 'deleted',
            rename: 'renamed',
            restore: 'restored',
            edited: 'edited',
        };
        return map[action] || action;
    }

    async function loadStoragePage() {
        currentPage = 'storage';
        clearSelection();
        showStorageView();
        setBreadcrumbText('Storage');

        try {
            const pageSize = 500;
            const firstResp = await Promise.all([
                API.myStorage(),
                API.files.list({ page: '1', page_size: String(pageSize) }),
            ]);
            const disk = firstResp[0];
            const firstList = firstResp[1];

            // Fetch ALL non-trashed files (paginate) so breakdown, count and
            // "largest files" reflect the full picture, not just the first page.
            const totalFiles = Number(firstList.total || (firstList.files || []).length);
            let files = firstList.files || [];
            if (totalFiles > files.length) {
                const pages = Math.ceil(totalFiles / pageSize);
                const rest = [];
                for (let p = 2; p <= pages; p++) {
                    rest.push(API.files.list({ page: String(p), page_size: String(pageSize) }));
                }
                const restResp = await Promise.all(rest);
                restResp.forEach((r) => { files = files.concat(r.files || []); });
            }

            const used = Number(disk.used_bytes || 0);
            const total = Number(disk.total_bytes || 1);
            const arcPct = storageQuotaPercentRaw(used, total);
            const targetDeg = arcPct * 3.6;

            const circle = document.getElementById('storage-circle');
            circle.style.setProperty('--storage-target-deg', `${targetDeg}deg`);

            // Smooth animation using requestAnimationFrame
            let startTime = null;
            const duration = 1200; // ms
            const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

            function animate(timestamp) {
                if (!startTime) startTime = timestamp;
                const elapsed = timestamp - startTime;
                const progress = Math.min(elapsed / duration, 1);
                const easedProgress = easeOutCubic(progress);
                const currentDeg = targetDeg * easedProgress;
                circle.style.setProperty('--storage-deg', `${currentDeg}deg`);
                if (progress < 1) {
                    requestAnimationFrame(animate);
                }
            }
            requestAnimationFrame(animate);

            // Two-line text: percentage + used/total
            const usedStr  = Components.formatSize(used);
            const totalStr = Components.formatSize(total);
            document.getElementById('storage-circle-text').innerHTML = `
                <div class="storage-circle-inner">
                    <span class="storage-circle-pct">${formatStoragePercentRounded(used, total)}%</span>
                    <span class="storage-circle-label">${usedStr} of ${totalStr}</span>
                </div>
            `;

            const free = Math.max(total - used, 0);
            const freeEl = document.getElementById('storage-free-space');
            const filesEl = document.getElementById('storage-total-files');
            if (freeEl) freeEl.textContent = Components.formatSize(free);
            if (filesEl) filesEl.textContent = String(totalFiles);
            // Use the backend breakdown, computed over the same (non-trashed)
            // file set as used_bytes, so the four categories add up exactly to
            // "used" shown in the ring. Falls back to client-side categorization
            // only if the API did not return a breakdown.
            const b = disk.breakdown;
            let buckets;
            if (b && typeof b === 'object') {
                buckets = {
                    Images: Number(b.images || 0),
                    Videos: Number(b.videos || 0),
                    Documents: Number(b.documents || 0),
                    Other: Number(b.other || 0),
                };
            } else {
                buckets = { Images: 0, Videos: 0, Documents: 0, Other: 0 };
                files.forEach((f) => {
                    const bytes = Number(f.encrypted_size || f.size || 0);
                    buckets[getStorageCategory(f.mime_type, f.name)] += bytes;
                });
            }

            document.getElementById('storage-breakdown').innerHTML = `
                ${renderBreakdownItem('Images',    buckets.Images,    '#ea4335', total)}
                ${renderBreakdownItem('Videos',    buckets.Videos,    '#fbbc04', total)}
                ${renderBreakdownItem('Documents', buckets.Documents, '#4285f4', total)}
                ${renderBreakdownItem('Other',     buckets.Other,     '#a142f4', total)}
            `;

            const largest = [...files].sort((a, b) => Number(b.size || 0) - Number(a.size || 0)).slice(0, 20);
            window.__fdLargestFiles = largest;
            showLargestFiles();
        } catch {
            Components.toast('Failed to load storage details', 'error');
        }
    }

    function renderBreakdownItem(name, bytes, color, quota) {
        const widthPct = storageQuotaPercentRaw(bytes, quota);
        const pctLabel = formatStoragePercentRounded(bytes, quota);
        const activeClass = bytes > 0 ? ' break-bar-fill--active' : '';
        const icons = {
            Images: '<svg viewBox="0 0 24 24" width="18" height="18" fill="' + color + '"><path d="M21 19V5c0-1.1-.9-2-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>',
            Videos: '<svg viewBox="0 0 24 24" width="18" height="18" fill="' + color + '"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>',
            Documents: '<svg viewBox="0 0 24 24" width="18" height="18" fill="' + color + '"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
            Other: '<svg viewBox="0 0 24 24" width="18" height="18" fill="' + color + '"><path d="M6 2c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z"/></svg>',
        };
        return `
            <div class="break-item">
                <div class="break-item-top">
                    <div class="break-tag">
                        ${icons[name] || ''}<span>${name}</span>
                    </div>
                    <span class="break-size">${bytes > 0 ? `${Components.formatSize(bytes)} · ${pctLabel}%` : '—'}</span>
                </div>
                <div class="break-bar-track">
                    <div class="break-bar-fill${activeClass}" style="width:${widthPct}%; background:${color};"></div>
                </div>
            </div>
        `;
    }

    function showLargestFiles() {
        const box = document.getElementById('largest-files');
        const list = window.__fdLargestFiles || [];
        if (!list.length) {
            box.innerHTML = '';
            return;
        }

        const svgIcons = {
            image: '<svg viewBox="0 0 24 24" width="18" height="18" fill="#ea4335"><path d="M21 19V5c0-1.1-.9-2-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>',
            video: '<svg viewBox="0 0 24 24" width="18" height="18" fill="#fbbc04"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>',
            audio: '<svg viewBox="0 0 24 24" width="18" height="18" fill="#a142f4"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>',
            pdf: '<svg viewBox="0 0 24 24" width="18" height="18" fill="#ea4335"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z"/></svg>',
            document: '<svg viewBox="0 0 24 24" width="18" height="18" fill="#4285f4"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
            sheet: '<svg viewBox="0 0 24 24" width="18" height="18" fill="#0f9d58"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 2v3H5V5h14zM5 19v-3h4v3H5zm0-5v-3h4v3H5zm6 5v-3h8v3h-8zm8-5h-8v-3h8v3z"/></svg>',
            text: '<svg viewBox="0 0 24 24" width="18" height="18" fill="#4285f4"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
        };
        const defaultIcon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="#5f6368"><path d="M6 2c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z"/></svg>';

        box.innerHTML = `
            <div class="largest-files-header">Largest files</div>
            ${list.map((f) => {
                const g = getMimeGroup(f.mime_type, 'file', f.name);
                const icon = svgIcons[g] || defaultIcon;
                return `
                    <div class="largest-item">
                        <span style="display:inline-flex; flex-shrink:0; align-items:center;">${icon}</span>
                        <span class="largest-item-name" title="${esc(f.name)}">${esc(f.name)}</span>
                        <span class="largest-item-size">${Components.formatSize(f.size)}</span>
                    </div>
                `;
            }).join('')}
        `;
    }

    async function loadAdminPanel() {
        currentPage = 'admin';
        clearSelection();
        await AdminPanel.load('dashboard');
    }

    async function openFile(file) {
        try {
            const group = getMimeGroup(file.mime_type, 'file', file.name);
            if (group === 'image') return await openImageEditor(file);
            if (isJsonMimeOrName(file.mime_type, file.name)) return await openJsonViewer(file);
            if (group === 'text' || file.mime_type === 'text/markdown') return await openTextEditor(file);
            if (group === 'pdf') return await openPdfViewer(file);
            if (group === 'video') return await openVideoPlayer(file);
            if (group === 'audio') return await openAudioPlayer(file);
            if (group === 'sheet') return await openSheetViewer(file);
            return downloadFile(file);
        } catch (err) {
            console.error('Failed to open file:', err);
            Components.toast('Failed to open file: ' + err.message, 'error');
        }
    }

    function showOpenWithDialog(file) {
        document.querySelector('.open-with-overlay')?.remove();

        const group = getMimeGroup(file.mime_type, 'file', file.name);
        const apps = [];
        const addApp = (id, label, description, icon, action, recommended = false) => {
            apps.push({ id, label, description, icon, action, recommended });
        };

        if (group === 'image') {
            addApp('image', 'FreeDrive Photos', 'View and edit the image', 'photo', () => openImageEditor(file), true);
        } else if (isJsonMimeOrName(file.mime_type, file.name)) {
            addApp('json', 'FreeDrive JSON Viewer', 'Structured JSON editor', 'data_object', () => openJsonViewer(file), true);
            addApp('text', 'FreeDrive Text Editor', 'Open as plain text', 'description', () => openTextEditor(file));
        } else if (group === 'text' || file.mime_type === 'text/markdown') {
            addApp('text', 'FreeDrive Docs', 'Edit text and documents', 'description', () => openTextEditor(file), true);
        } else if (group === 'pdf') {
            addApp('pdf', 'FreeDrive PDF Viewer', 'Read the PDF document', 'picture_as_pdf', () => openPdfViewer(file), true);
        } else if (group === 'video') {
            addApp('video', 'FreeDrive Video Player', 'Play the video', 'movie', () => openVideoPlayer(file), true);
        } else if (group === 'audio') {
            addApp('audio', 'FreeDrive Audio Player', 'Play the audio file', 'music_note', () => openAudioPlayer(file), true);
        } else if (group === 'sheet') {
            addApp('sheet', 'FreeDrive Sheets', 'View and edit the spreadsheet', 'table_chart', () => openSheetViewer(file), true);
        }

        if (!apps.length) {
            addApp('download', 'Download', 'Download and open on this device', 'download', () => downloadFile(file), true);
        }

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay open-with-overlay';
        overlay.innerHTML = `
            <div class="modal open-with-modal" role="dialog" aria-modal="true" aria-labelledby="open-with-title">
                <div class="modal-header">
                    <div>
                        <h3 id="open-with-title">Open with</h3>
                        <p class="open-with-filename">${esc(file.name || 'File')}</p>
                    </div>
                    <button type="button" class="btn-icon open-with-close" aria-label="Close"><span class="material-icons-outlined">close</span></button>
                </div>
                <div class="modal-body open-with-apps">
                    ${apps.map((app) => `
                        <button type="button" class="open-with-app" data-open-app="${app.id}">
                            <span class="open-with-app-icon material-icons-outlined">${app.icon}</span>
                            <span class="open-with-app-copy">
                                <span class="open-with-app-title">${esc(app.label)}</span>
                                <span class="open-with-app-description">${esc(app.description)}</span>
                            </span>
                            ${app.recommended ? '<span class="open-with-recommended">Recommended</span>' : ''}
                        </button>
                    `).join('')}
                </div>
            </div>
        `;

        const close = () => {
            document.removeEventListener('keydown', onKeyDown);
            overlay.remove();
        };
        const onKeyDown = (event) => {
            if (event.key === 'Escape') close();
        };

        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close();
        });
        overlay.querySelector('.open-with-close').addEventListener('click', close);
        overlay.querySelectorAll('[data-open-app]').forEach((button) => {
            button.addEventListener('click', async () => {
                const app = apps.find((candidate) => candidate.id === button.dataset.openApp);
                if (!app) return;
                close();
                try {
                    await app.action();
                } catch (err) {
                    console.error('Failed to open file with selected app:', err);
                    Components.toast('Failed to open file: ' + (err.message || 'Unknown error'), 'error');
                }
            });
        });
        document.addEventListener('keydown', onKeyDown);
        document.body.appendChild(overlay);
        overlay.querySelector('.open-with-app')?.focus();
    }

    function openFileById(file) {
        openFile(file);
    }

    async function decryptFileBlob(file) {
        try {
            const { blob, iv, mime } = await API.downloadBlob(file.id);
            const cryptoModule = window.CryptoModule;
            if (!cryptoModule?.getKey || !cryptoModule?.decryptFile || !iv) return blob;

            const key = await (window.CryptoSync?.ensureFileKey
                ? CryptoSync.ensureFileKey(file.id)
                : cryptoModule.getKey(file.id));
            if (!key) {
                throw new Error(
                    window.CryptoSync?.describeFileKeyError
                        ? CryptoSync.describeFileKeyError({ code: CryptoSync.ERR_UNLOCK_REQUIRED })
                        : 'Sign out and sign in again with your password.',
                );
            }
            if (!iv) return blob;

            const encrypted = await blob.arrayBuffer();
            const plain = await cryptoModule.decryptFile(encrypted, key, cryptoModule.base64ToUint8(iv));
            return new Blob([plain], { type: mime || file.mime_type || blob.type });
        } catch (err) {
            const message = window.CryptoSync?.describeFileKeyError
                ? CryptoSync.describeFileKeyError(err)
                : (err?.message || 'Decryption failed');
            throw new Error(message);
        }
    }

    async function downloadFile(file) {
        try {
            const blob = await decryptFileBlob(file);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = file.name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1200);
            Components.toast('Download started', 'info');
            addFileActivity(file.id, 'downloaded', file.name);
        } catch (err) {
            Components.toast(`Download failed: ${err.message}`, 'error');
        }
    }

    function crc32(bytes) {
        let crc = 0xffffffff;
        for (let i = 0; i < bytes.length; i += 1) {
            crc = zipCrcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
    }

    function dosDateTime(dateInput) {
        const d = new Date(dateInput || Date.now());
        const year = Math.max(1980, d.getFullYear());
        const month = d.getMonth() + 1;
        const day = d.getDate();
        const hour = d.getHours();
        const minute = d.getMinutes();
        const second = Math.floor(d.getSeconds() / 2);
        const time = (hour << 11) | (minute << 5) | second;
        const date = ((year - 1980) << 9) | (month << 5) | day;
        return { time, date };
    }

    function sanitizeZipPath(input, asDirectory = false) {
        const safe = String(input || '')
            .replace(/\\/g, '/')
            .split('/')
            .filter((s) => s && s !== '.' && s !== '..')
            .join('/');
        if (asDirectory) return `${safe || 'folder'}/`;
        return safe || 'file';
    }

    function uniqueZipPath(path, used) {
        const isDir = String(path || '').endsWith('/');
        const normalized = sanitizeZipPath(path, isDir);
        if (!used.has(normalized)) {
            used.add(normalized);
            return normalized;
        }

        if (isDir) {
            const baseDir = normalized.slice(0, -1);
            let i = 2;
            while (used.has(`${baseDir} (${i})/`)) i += 1;
            const out = `${baseDir} (${i})/`;
            used.add(out);
            return out;
        }

        const slash = normalized.lastIndexOf('/');
        const dir = slash >= 0 ? normalized.slice(0, slash + 1) : '';
        const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let i = 2;
        while (used.has(`${dir}${base} (${i})${ext}`)) i += 1;
        const out = `${dir}${base} (${i})${ext}`;
        used.add(out);
        return out;
    }

    function concatUint8(chunks) {
        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        chunks.forEach((c) => {
            out.set(c, offset);
            offset += c.length;
        });
        return out;
    }

    function createZipBlob(entries) {
        const encoder = new TextEncoder();
        const fileChunks = [];
        const centralChunks = [];
        let offset = 0;

        entries.forEach((entry) => {
            const nameBytes = encoder.encode(entry.path);
            const dataBytes = entry.data || new Uint8Array(0);
            const { time, date } = dosDateTime(entry.modifiedAt);
            const crc = crc32(dataBytes);

            const local = new Uint8Array(30 + nameBytes.length);
            const localView = new DataView(local.buffer);
            localView.setUint32(0, 0x04034b50, true);
            localView.setUint16(4, 20, true);
            localView.setUint16(6, 0, true);
            localView.setUint16(8, 0, true);
            localView.setUint16(10, time, true);
            localView.setUint16(12, date, true);
            localView.setUint32(14, crc, true);
            localView.setUint32(18, dataBytes.length, true);
            localView.setUint32(22, dataBytes.length, true);
            localView.setUint16(26, nameBytes.length, true);
            localView.setUint16(28, 0, true);
            local.set(nameBytes, 30);

            fileChunks.push(local);
            fileChunks.push(dataBytes);

            const central = new Uint8Array(46 + nameBytes.length);
            const centralView = new DataView(central.buffer);
            centralView.setUint32(0, 0x02014b50, true);
            centralView.setUint16(4, 20, true);
            centralView.setUint16(6, 20, true);
            centralView.setUint16(8, 0, true);
            centralView.setUint16(10, 0, true);
            centralView.setUint16(12, time, true);
            centralView.setUint16(14, date, true);
            centralView.setUint32(16, crc, true);
            centralView.setUint32(20, dataBytes.length, true);
            centralView.setUint32(24, dataBytes.length, true);
            centralView.setUint16(28, nameBytes.length, true);
            centralView.setUint16(30, 0, true);
            centralView.setUint16(32, 0, true);
            centralView.setUint16(34, 0, true);
            centralView.setUint16(36, 0, true);
            centralView.setUint32(38, entry.path.endsWith('/') ? 0x10 : 0, true);
            centralView.setUint32(42, offset, true);
            central.set(nameBytes, 46);
            centralChunks.push(central);

            offset += local.length + dataBytes.length;
        });

        const centralData = concatUint8(centralChunks);
        const eocd = new Uint8Array(22);
        const eocdView = new DataView(eocd.buffer);
        eocdView.setUint32(0, 0x06054b50, true);
        eocdView.setUint16(4, 0, true);
        eocdView.setUint16(6, 0, true);
        eocdView.setUint16(8, entries.length, true);
        eocdView.setUint16(10, entries.length, true);
        eocdView.setUint32(12, centralData.length, true);
        eocdView.setUint32(16, offset, true);
        eocdView.setUint16(20, 0, true);

        const all = [...fileChunks, centralData, eocd];
        return new Blob(all, { type: 'application/zip' });
    }

    async function collectFolderEntries(folderId, basePath, out, used, visited = new Set()) {
        if (!folderId || visited.has(folderId)) return;
        visited.add(folderId);
        const contents = await API.folders.getAll(folderId);
        const folders = Array.isArray(contents.folders) ? contents.folders : [];
        const files = Array.isArray(contents.files) ? contents.files : [];

        if (!folders.length && !files.length) {
            const emptyPath = uniqueZipPath(`${basePath}/`, used);
            out.push({ path: emptyPath, data: new Uint8Array(0), modifiedAt: new Date() });
            return;
        }

        for (const f of files) {
            const blob = await decryptFileBlob(f);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const filePath = uniqueZipPath(`${basePath}/${f.name}`, used);
            out.push({ path: filePath, data: bytes, modifiedAt: f.updated_at || f.created_at || new Date() });
        }

        for (const folder of folders) {
            const dirPath = uniqueZipPath(`${basePath}/${folder.name}/`, used);
            out.push({ path: dirPath, data: new Uint8Array(0), modifiedAt: folder.updated_at || folder.created_at || new Date() });
            await collectFolderEntries(folder.id, dirPath.replace(/\/$/, ''), out, used, visited);
        }
    }

    async function buildZipEntriesForPayload(payload, entries, used) {
        if (!payload) return;
        if (payload.type === 'file') {
            const blob = await decryptFileBlob(payload.data);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const path = uniqueZipPath(payload.data.name, used);
            entries.push({
                path,
                data: bytes,
                modifiedAt: payload.data.updated_at || payload.data.created_at || new Date(),
            });
            return;
        }
        const rootPath = sanitizeZipPath(payload.data.name || 'folder');
        const rootDirPath = uniqueZipPath(`${rootPath}/`, used);
        entries.push({ path: rootDirPath, data: new Uint8Array(0), modifiedAt: payload.data.updated_at || payload.data.created_at || new Date() });
        await collectFolderEntries(payload.data.id, rootDirPath.replace(/\/$/, ''), entries, used);
    }

    function triggerBlobDownload(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
    }

    async function downloadPayloadListAsZip(payloads, zipName) {
        if (!payloads.length) return;
        try {
            Components.toast('Preparing ZIP download...', 'info');
            const entries = [];
            const used = new Set();
            for (const payload of payloads) {
                await buildZipEntriesForPayload(payload, entries, used);
            }
            const zipBlob = createZipBlob(entries);
            triggerBlobDownload(zipBlob, zipName || `drive-download-${Date.now()}.zip`);
            Components.toast('ZIP download started', 'success');
        } catch (err) {
            Components.toast(`ZIP download failed: ${err.message}`, 'error');
        }
    }

    async function downloadPayloadAsZip(payload) {
        if (!payload) return;
        const base = payload.type === 'folder' ? payload.data.name : payload.data.name.replace(/\.[^/.]+$/, '') || payload.data.name;
        const zipName = `${sanitizeZipPath(base)}.zip`;
        await downloadPayloadListAsZip([payload], zipName);
        if (payload.type === 'file') {
            addFileActivity(payload.data.id, 'downloaded', payload.data.name);
        }
        if (payload.type === 'folder') {
            addFileActivity(payload.data.id, 'downloaded', payload.data.name);
        }
    }

    function capitalizeRole(role) {
        const value = String(role || 'viewer');
        return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    }

    function setSortColLabel(selector, label) {
        const el = document.querySelector(`#file-list-header ${selector}`);
        if (!el) return;
        const arrow = el.querySelector('.sort-arrow');
        const arrowHtml = arrow ? arrow.outerHTML : '';
        el.innerHTML = `${esc(label)} ${arrowHtml}`;
    }

    function updateListHeaderLabels() {
        if (currentPage === 'shared-with') {
            setSortColLabel('.col-name', 'Name');
            setSortColLabel('.col-owner', 'Shared by');
            setSortColLabel('.col-date', 'Date shared');
            setSortColLabel('.col-size', 'Access');
            return;
        }
        setSortColLabel('.col-name', 'Name');
        setSortColLabel('.col-owner', 'Owner');
        setSortColLabel('.col-date', 'Last modified');
        setSortColLabel('.col-size', 'File size');
    }

    async function createQuickFile(name, mimeType, textContent) {
        if (!canAcceptUploads()) {
            Components.toast('Connect a computer to add files here', 'info');
            return;
        }
        const blob = new Blob([textContent || ''], { type: mimeType || 'text/plain' });
        try {
            const created = await uploadEncryptedBlob(blob, name, mimeType, currentFolderId);
            Components.toast('File created', 'success');
            if (currentPage !== 'files' && currentPage !== 'home' && currentPage !== 'computers') {
                window.location.hash = currentFolderId
                    ? (currentPage === 'computers' ? `#/computers/${currentFolderId}` : `#/files/${currentFolderId}`)
                    : '#/files';
                return;
            }
            refresh();
            if (created?.id) {
                setTimeout(async () => {
                    const row = document.querySelector(`[data-item-id="${created.id}"]`);
                    if (row && row.scrollIntoView) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    const mime = (mimeType || created.mime_type || '').toLowerCase();
                    const fileName = (name || created.name || '').toLowerCase();
                    const isSheet = mime.includes('csv')
                        || mime.includes('spreadsheet')
                        || fileName.endsWith('.csv')
                        || fileName.endsWith('.xlsx')
                        || fileName.endsWith('.xls');
                    try {
                        if (isSheet) await openSheetViewer(created);
                        else await openTextEditor(created);
                    } catch (err) {
                        Components.toast(`Open failed: ${err.message || err}`, 'error');
                    }
                }, 120);
            }
        } catch (err) {
            Components.toast(`Create failed: ${err.message}`, 'error');
        }
    }

    async function uploadEncryptedBlob(blob, fileName, mimeType, folderId) {
        const cryptoModule = window.CryptoModule;
        const canEncrypt = Boolean(cryptoModule?.canEncrypt?.() && cryptoModule?.generateKey);

        let key = null;
        let payload;
        let ivB64 = '';
        const originalSize = blob.size;

        if (canEncrypt) {
            key = await cryptoModule.generateKey();
            const data = await blob.arrayBuffer();
            const { ciphertext, iv } = await cryptoModule.encryptFile(data, key);
            payload = ciphertext;
            ivB64 = cryptoModule.uint8ToBase64(iv);
        } else {
            if (!insecureUploadNoticeShown) {
                insecureUploadNoticeShown = true;
                Components.toast('HTTPS is not enabled, so files will be uploaded without browser encryption.', 'info', { duration: 7000 });
            }
            payload = await blob.arrayBuffer();
        }

        const result = await API.uploadBytes({
            data: payload,
            name: fileName,
            mimeType: mimeType || blob.type || 'application/octet-stream',
            originalSize,
            iv: ivB64,
            folderId: folderId || undefined,
        });
        if (key) {
            await cryptoModule.storeKey(result.id, key);
            if (window.CryptoSync?.pushFileKey) await CryptoSync.pushFileKey(result.id, key);
        }
        addFileActivity(result.id, 'uploaded', result.name);
        createNotification('File uploaded successfully', new Date().toISOString(), true, currentUserLabel());
        return result;
    }

    async function saveBlobToExistingFile(file, blob, mimeType, newName) {
        const oldName = file.name;
        const nameToUse = newName || file.name;
        const cryptoModule = window.CryptoModule;
        const canEncrypt = Boolean(cryptoModule?.canEncrypt?.() && cryptoModule?.generateKey);

        let key = null;
        let payload;
        let ivB64 = '';
        const originalSize = blob.size;

        if (canEncrypt) {
            key = (await cryptoModule.getKey(file.id)) || (await cryptoModule.generateKey());
            const plain = await blob.arrayBuffer();
            const { ciphertext, iv } = await cryptoModule.encryptFile(plain, key);
            payload = ciphertext;
            ivB64 = cryptoModule.uint8ToBase64(iv);
        } else {
            if (!insecureUploadNoticeShown) {
                insecureUploadNoticeShown = true;
                Components.toast('HTTPS is not enabled, so this file will be saved without browser encryption.', 'info', { duration: 7000 });
            }
            payload = await blob.arrayBuffer();
        }

        try {
            await API.uploadBytes({
                data: payload,
                name: nameToUse,
                mimeType: mimeType || file.mime_type || blob.type || 'application/octet-stream',
                originalSize,
                iv: ivB64,
                fileId: file.id,
            });
            if (key) {
                await cryptoModule.storeKey(file.id, key);
                if (window.CryptoSync?.pushFileKey) await CryptoSync.pushFileKey(file.id, key);
            }
            if (nameToUse !== oldName) {
                await API.files.update(file.id, { name: nameToUse });
            }
            addFileActivity(file.id, 'edited', file.name);
            createNotification(`${currentUserLabel()} edited ${nameToUse}`, new Date().toISOString(), true, currentUserLabel());
            return true;
        } catch (err) {
            Components.toast(`Save failed: ${err.message}`, 'error');
            return false;
        }
    }

    function handleEditorOverlayClick(e) {
        if (e.target === e.currentTarget) closeEditor();
    }

    function openEditorShell(file, titleStatus = 'Saved') {
        const overlay = document.getElementById('editor-overlay');
        const shell = document.getElementById('editor-shell');

        overlay.classList.remove('hidden');
        overlay.removeEventListener('click', handleEditorOverlayClick);
        overlay.addEventListener('click', handleEditorOverlayClick);
        shell.innerHTML = `
            <div class="editor-toolbar">
                <div class="editor-title">
                    <input id="editor-file-name" value="${esc(file.name)}" />
                    <span class="editor-status" id="editor-save-status">${esc(titleStatus)}</span>
                </div>
                <div class="editor-controls" id="editor-main-controls">
                    <button class="btn btn-secondary btn-sm" id="editor-version-history">Version history</button>
                    <button class="btn btn-secondary btn-sm" id="editor-undo">Undo</button>
                    <button class="btn btn-secondary btn-sm" id="editor-redo">Redo</button>
                    <button class="btn btn-secondary btn-sm" id="editor-reset">Reset</button>
                    <button class="btn btn-primary btn-sm" id="editor-save">Save</button>
                    <button class="btn btn-secondary btn-sm" id="editor-download">Download</button>
                    <button class="btn btn-secondary btn-sm" id="editor-close">Close</button>
                    <button class="btn-icon" id="editor-close-icon" aria-label="Close editor"><span class="material-icons-outlined">close</span></button>
                </div>
            </div>
        `;

        editorState = {
            file,
            unsaved: false,
            undo: [],
            redo: [],
            onSave: null,
            onUndo: null,
            onRedo: null,
            onReset: null,
        };

        shell.querySelector('#editor-download')?.addEventListener('click', () => downloadFile(file));
        shell.querySelector('#editor-close')?.addEventListener('click', closeEditor);
        shell.querySelector('#editor-close-icon')?.addEventListener('click', closeEditor);
        shell.querySelector('#editor-version-history')?.addEventListener('click', () => openVersionHistory(file));

        shell.querySelector('#editor-undo')?.addEventListener('click', () => {
            if (editorState?.onUndo) editorState.onUndo();
        });
        shell.querySelector('#editor-redo')?.addEventListener('click', () => {
            if (editorState?.onRedo) editorState.onRedo();
        });
        shell.querySelector('#editor-reset')?.addEventListener('click', () => {
            if (editorState?.onReset) editorState.onReset();
        });

        shell.querySelector('#editor-save')?.addEventListener('click', async (e) => {
            if (editorState?.onSave) {
                const btn = e.currentTarget;
                const status = document.getElementById('editor-save-status');
                
                const originalText = btn.textContent;
                btn.textContent = 'Saving...';
                btn.disabled = true;
                if (status) status.textContent = 'Saving...';
                
                try {
                    const ok = await editorState.onSave();
                    if (ok) {
                        setEditorSaved(true);
                        Components.toast('File saved successfully', 'success');
                    } else {
                        if (status) status.textContent = 'Save failed';
                    }
                } catch (err) {
                    if (status) status.textContent = 'Save error';
                    Components.toast(err.message || 'Error saving file', 'error');
                } finally {
                    btn.textContent = originalText;
                    btn.disabled = false;
                }
            }
        });

        document.addEventListener('keydown', editorGlobalShortcuts);
        return shell;
    }

    function closeEditor() {
        if (editorState?.unsaved) {
            Components.showModal(
                'Unsaved changes',
                'Unsaved changes. Save before closing?',
                [
                    { text: 'Cancel' },
                    {
                        text: 'Discard',
                        class: 'btn-secondary',
                        action: () => {
                            forceCloseEditor();
                        },
                    },
                    {
                        text: 'Save',
                        class: 'btn-primary',
                        action: async () => {
                            if (editorState?.onSave) {
                                const ok = await editorState.onSave();
                                if (ok) {
                                    Components.toast('File saved successfully', 'success');
                                    forceCloseEditor();
                                }
                            }
                        },
                    },
                ]
            );
            return;
        }
        forceCloseEditor();
    }

    function forceCloseEditor() {
        if (editorState?.cleanup) {
            try { editorState.cleanup(); } catch {}
        }
        const overlay = document.getElementById('editor-overlay');
        overlay?.removeEventListener('click', handleEditorOverlayClick);
        overlay?.classList.add('hidden');
        document.getElementById('editor-shell').innerHTML = '';
        document.removeEventListener('keydown', editorGlobalShortcuts);
        editorState = null;
        refresh();
    }

    function setEditorSaved(saved) {
        if (!editorState) return;
        editorState.unsaved = !saved;
        const status = document.getElementById('editor-save-status');
        if (!status) return;
        status.textContent = saved ? 'Saved' : 'Unsaved changes';
    }

    function editorGlobalShortcuts(e) {
        if (!editorState) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            document.getElementById('editor-save')?.click();
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            document.getElementById('editor-undo')?.click();
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
            e.preventDefault();
            document.getElementById('editor-redo')?.click();
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
            e.preventDefault();
            document.getElementById('editor-download')?.click();
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            closeEditor();
        }
    }

    async function openImageEditor(file) {
        const blob = await decryptFileBlob(file);
        const shell = openEditorShell(file);

        const layout = document.createElement('div');
        layout.className = 'image-editor-wrap';
        layout.innerHTML = `
            <div class="image-toolbar" id="image-toolbar">
                <div class="tool-list" id="img-tool-list">
                    <button type="button" class="tool-btn tool-btn-icon active" data-tool="pen" title="Pen"><span class="material-icons-outlined">edit</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-tool="brush" title="Brush"><span class="material-icons-outlined">brush</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-tool="eraser" title="Eraser"><span class="material-icons-outlined">auto_fix_off</span></button>
                    <span class="tool-sep" aria-hidden="true"></span>
                    <button type="button" class="tool-btn tool-btn-icon" data-tool="line" title="Line"><span class="material-icons-outlined">show_chart</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-tool="arrow" title="Arrow"><span class="material-icons-outlined">north_east</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-tool="rect" title="Rectangle"><span class="material-icons-outlined">crop_square</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-tool="circle" title="Circle"><span class="material-icons-outlined">circle</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-tool="triangle" title="Triangle"><span class="material-icons-outlined">change_history</span></button>
                    <span class="tool-sep" aria-hidden="true"></span>
                    <button type="button" class="tool-btn tool-btn-icon" data-tool="text" title="Text"><span class="material-icons-outlined">title</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-tool="emoji" title="Sticker"><span class="material-icons-outlined">emoji_emotions</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-tool="blur" title="Blur"><span class="material-icons-outlined">blur_on</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-tool="crop" title="Crop"><span class="material-icons-outlined">crop</span></button>
                </div>
                <span class="tool-sep" aria-hidden="true"></span>
                <button type="button" class="tool-btn tool-btn-icon" id="img-rot-l" title="Rotate left"><span class="material-icons-outlined">rotate_left</span></button>
                <button type="button" class="tool-btn tool-btn-icon" id="img-rot-r" title="Rotate right"><span class="material-icons-outlined">rotate_right</span></button>
                <button type="button" class="tool-btn tool-btn-icon" id="img-flip-h" title="Flip horizontal"><span class="material-icons-outlined">flip</span></button>
                <button type="button" class="tool-btn tool-btn-icon" id="img-flip-v" title="Flip vertical"><span class="material-icons-outlined img-flip-v-icon">flip</span></button>
                <span class="tool-sep" aria-hidden="true"></span>
                <button type="button" class="tool-btn tool-btn-icon" id="img-btn-tune" title="Adjustments" data-panel="adjust"><span class="material-icons-outlined">tune</span></button>
                <button type="button" class="tool-btn tool-btn-icon" id="img-btn-filters" title="Filters" data-panel="filters"><span class="material-icons-outlined">photo_filter</span></button>
            </div>
            <div class="image-editor-body">
                <div class="editor-canvas-wrap" id="img-canvas-wrap">
                    <canvas id="img-editor-canvas"></canvas>
                    <div class="zoom-indicator" id="img-zoom-indicator">100%</div>
                    <div class="selection-indicator" id="img-selection-indicator">0 × 0 px</div>
                </div>
                <aside class="image-panel" id="img-panel-adjust" hidden>
                    <div class="image-panel-header">
                        <h5>Adjustments</h5>
                        <button type="button" class="tool-btn tool-btn-icon image-panel-close" data-close-panel="adjust" title="Close"><span class="material-icons-outlined">close</span></button>
                    </div>
                    <div class="image-panel-body">
                        ${renderAdjustSlider('brightness', -100, 100, 0)}
                        ${renderAdjustSlider('contrast', -100, 100, 0)}
                        ${renderAdjustSlider('saturation', -100, 100, 0)}
                        ${renderAdjustSlider('sharpness', 0, 100, 0)}
                        ${renderAdjustSlider('blur', 0, 20, 0)}
                        ${renderAdjustSlider('opacity', 0, 100, 100)}
                    </div>
                </aside>
                <aside class="image-panel" id="img-panel-filters" hidden>
                    <div class="image-panel-header">
                        <h5>Filters</h5>
                        <button type="button" class="tool-btn tool-btn-icon image-panel-close" data-close-panel="filters" title="Close"><span class="material-icons-outlined">close</span></button>
                    </div>
                    <div class="image-panel-body">
                        <div class="tool-list img-preset-list">
                            <button type="button" class="tool-btn img-preset" data-preset="original">Original</button>
                            <button type="button" class="tool-btn img-preset" data-preset="grayscale">Grayscale</button>
                            <button type="button" class="tool-btn img-preset" data-preset="sepia">Sepia</button>
                            <button type="button" class="tool-btn img-preset" data-preset="vivid">Vivid</button>
                            <button type="button" class="tool-btn img-preset" data-preset="cool">Cool</button>
                            <button type="button" class="tool-btn img-preset" data-preset="warm">Warm</button>
                            <button type="button" class="tool-btn img-preset" data-preset="fade">Fade</button>
                            <button type="button" class="tool-btn img-preset" data-preset="dramatic">Dramatic</button>
                        </div>
                    </div>
                </aside>
            </div>
        `;
        shell.appendChild(layout);

        const canvas = document.getElementById('img-editor-canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const img = new Image();
        const imageURL = URL.createObjectURL(blob);
        const wrap = document.getElementById('img-canvas-wrap');

        let tool = 'pen';
        let drawing = false;
        let start = null;
        let zoom = 1;
        let panX = 0;
        let panY = 0;
        let baseSnapshot = null;
        let transformState = { rotate: 0, flipH: false, flipV: false };

        const adjustment = {
            brightness: 0,
            contrast: 0,
            saturation: 0,
            sharpness: 0,
            blur: 0,
            opacity: 100,
        };

        img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
            pushCanvasHistory(canvas);
            applyImageTransform();
        };
        img.src = imageURL;

        function applyImageTransform() {
            const f = `brightness(${100 + adjustment.brightness}%) contrast(${100 + adjustment.contrast}%) saturate(${100 + adjustment.saturation}%) blur(${adjustment.blur}px) opacity(${adjustment.opacity}%)`;
            canvas.style.filter = f;
            canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
            document.getElementById('img-zoom-indicator').textContent = `${Math.round(zoom * 100)}%`;
        }

        function currentPoint(e) {
            const r = canvas.getBoundingClientRect();
            return {
                x: (e.clientX - r.left) * (canvas.width / r.width),
                y: (e.clientY - r.top) * (canvas.height / r.height),
            };
        }

        function drawShapePreview(p1, p2, shape) {
            if (!baseSnapshot) return;
            ctx.putImageData(baseSnapshot, 0, 0);
            ctx.strokeStyle = '#7c5cfc';
            ctx.fillStyle = 'rgba(124,92,252,0.2)';
            ctx.lineWidth = 3;

            if (shape === 'line' || shape === 'arrow') {
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.stroke();
                if (shape === 'arrow') {
                    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
                    const len = 12;
                    ctx.beginPath();
                    ctx.moveTo(p2.x, p2.y);
                    ctx.lineTo(p2.x - len * Math.cos(angle - Math.PI / 6), p2.y - len * Math.sin(angle - Math.PI / 6));
                    ctx.moveTo(p2.x, p2.y);
                    ctx.lineTo(p2.x - len * Math.cos(angle + Math.PI / 6), p2.y - len * Math.sin(angle + Math.PI / 6));
                    ctx.stroke();
                }
            } else if (shape === 'rect' || shape === 'crop') {
                const w = p2.x - p1.x;
                const h = p2.y - p1.y;
                if (shape === 'crop') {
                    ctx.setLineDash([6, 4]);
                }
                ctx.strokeRect(p1.x, p1.y, w, h);
                ctx.setLineDash([]);
                document.getElementById('img-selection-indicator').textContent = `${Math.abs(Math.round(w))} × ${Math.abs(Math.round(h))} px`;
            } else if (shape === 'circle') {
                const rx = (p2.x - p1.x) / 2;
                const ry = (p2.y - p1.y) / 2;
                const cx = p1.x + rx;
                const cy = p1.y + ry;
                ctx.beginPath();
                ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
                ctx.stroke();
            } else if (shape === 'triangle') {
                ctx.beginPath();
                ctx.moveTo((p1.x + p2.x) / 2, p1.y);
                ctx.lineTo(p1.x, p2.y);
                ctx.lineTo(p2.x, p2.y);
                ctx.closePath();
                ctx.stroke();
            }
        }

        canvas.addEventListener('mousedown', (e) => {
            drawing = true;
            start = currentPoint(e);
            baseSnapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);

            if (tool === 'text') {
                const text = prompt('Text:');
                if (text) {
                    ctx.fillStyle = '#ffffff';
                    ctx.font = 'bold 24px Manrope';
                    ctx.fillText(text, start.x, start.y);
                    pushCanvasHistory(canvas);
                    setEditorSaved(false);
                }
                drawing = false;
            }

            if (tool === 'emoji') {
                const emoji = prompt('Emoji:', '😀') || '😀';
                ctx.font = '36px serif';
                ctx.fillText(emoji, start.x, start.y);
                pushCanvasHistory(canvas);
                setEditorSaved(false);
                drawing = false;
            }
        });

        canvas.addEventListener('mousemove', (e) => {
            if (!drawing) return;
            const p = currentPoint(e);

            if (tool === 'pen' || tool === 'brush' || tool === 'eraser' || tool === 'blur') {
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.lineWidth = tool === 'brush' ? 8 : 2;
                if (tool === 'eraser') {
                    ctx.globalCompositeOperation = 'destination-out';
                    ctx.lineWidth = 16;
                } else {
                    ctx.globalCompositeOperation = 'source-over';
                    ctx.strokeStyle = tool === 'blur' ? 'rgba(0,0,0,0.2)' : '#7c5cfc';
                }
                ctx.beginPath();
                ctx.moveTo(start.x, start.y);
                ctx.lineTo(p.x, p.y);
                ctx.stroke();
                start = p;
                return;
            }

            drawShapePreview(start, p, tool);
        });

        canvas.addEventListener('mouseup', (e) => {
            if (!drawing) return;
            drawing = false;
            ctx.globalCompositeOperation = 'source-over';
            const end = currentPoint(e);

            if (tool === 'crop' && baseSnapshot) {
                const x = Math.min(start.x, end.x);
                const y = Math.min(start.y, end.y);
                const w = Math.max(1, Math.abs(end.x - start.x));
                const h = Math.max(1, Math.abs(end.y - start.y));
                const cropped = ctx.getImageData(x, y, w, h);
                canvas.width = w;
                canvas.height = h;
                ctx.putImageData(cropped, 0, 0);
            }

            pushCanvasHistory(canvas);
            setEditorSaved(false);
        });

        wrap.addEventListener('wheel', (e) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            zoom += e.deltaY < 0 ? 0.08 : -0.08;
            zoom = Math.max(0.2, Math.min(zoom, 4));
            applyImageTransform();
        }, { passive: false });

        let panning = false;
        let panStart = null;
        let spaceHeld = false;
        const onKeyDown = (ev) => { if (ev.code === 'Space') spaceHeld = true; };
        const onKeyUp = (ev) => { if (ev.code === 'Space') spaceHeld = false; };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('keyup', onKeyUp);
        wrap.addEventListener('mousedown', (e) => {
            if (!spaceHeld && !e.shiftKey && e.button !== 1) return;
            panning = true;
            panStart = { x: e.clientX - panX, y: e.clientY - panY };
        });
        wrap.addEventListener('mousemove', (e) => {
            if (!panning) return;
            panX = e.clientX - panStart.x;
            panY = e.clientY - panStart.y;
            applyImageTransform();
        });
        wrap.addEventListener('mouseup', () => { panning = false; });

        document.querySelectorAll('#img-tool-list .tool-btn').forEach((b) => {
            b.addEventListener('click', () => {
                document.querySelectorAll('#img-tool-list .tool-btn').forEach((x) => x.classList.remove('active'));
                b.classList.add('active');
                tool = b.dataset.tool;
            });
        });

        const panelAdjust = document.getElementById('img-panel-adjust');
        const panelFilters = document.getElementById('img-panel-filters');
        const btnTune = document.getElementById('img-btn-tune');
        const btnFilters = document.getElementById('img-btn-filters');

        function setImagePanel(name) {
            const showAdjust = name === 'adjust';
            const showFilters = name === 'filters';
            panelAdjust.hidden = !showAdjust;
            panelFilters.hidden = !showFilters;
            panelAdjust.classList.toggle('open', showAdjust);
            panelFilters.classList.toggle('open', showFilters);
            btnTune.classList.toggle('active', showAdjust);
            btnFilters.classList.toggle('active', showFilters);
        }

        btnTune.addEventListener('click', () => {
            setImagePanel(panelAdjust.classList.contains('open') ? null : 'adjust');
        });
        btnFilters.addEventListener('click', () => {
            setImagePanel(panelFilters.classList.contains('open') ? null : 'filters');
        });
        layout.querySelectorAll('[data-close-panel]').forEach((b) => {
            b.addEventListener('click', () => setImagePanel(null));
        });

        layout.querySelectorAll('.adjust-slider').forEach((s) => {
            s.addEventListener('input', () => {
                const key = s.dataset.key;
                adjustment[key] = Number(s.value);
                const label = document.getElementById(`adj-${key}`);
                if (label) label.textContent = String(s.value);
                applyImageTransform();
                setEditorSaved(false);
            });
        });

        layout.querySelectorAll('.img-preset').forEach((b) => {
            b.addEventListener('click', () => {
                applyPreset(b.dataset.preset, adjustment);
                layout.querySelectorAll('.adjust-slider').forEach((s) => {
                    s.value = String(adjustment[s.dataset.key]);
                    const label = document.getElementById(`adj-${s.dataset.key}`);
                    if (label) label.textContent = String(s.value);
                });
                applyImageTransform();
                setEditorSaved(false);
            });
        });

        document.getElementById('img-rot-l').addEventListener('click', () => rotateCanvas(canvas, ctx, -90));
        document.getElementById('img-rot-r').addEventListener('click', () => rotateCanvas(canvas, ctx, 90));
        document.getElementById('img-flip-h').addEventListener('click', () => {
            transformState.flipH = !transformState.flipH;
            flipCanvas(canvas, ctx, true);
        });
        document.getElementById('img-flip-v').addEventListener('click', () => {
            transformState.flipV = !transformState.flipV;
            flipCanvas(canvas, ctx, false);
        });

        editorState.onUndo = () => undoCanvas(canvas, ctx);
        editorState.onRedo = () => redoCanvas(canvas, ctx);
        editorState.onReset = () => {
            adjustment.brightness = 0;
            adjustment.contrast   = 0;
            adjustment.saturation = 0;
            adjustment.sharpness  = 0;
            adjustment.blur       = 0;
            adjustment.opacity    = 100;

            layout.querySelectorAll('.adjust-slider').forEach((s) => {
                s.value = String(adjustment[s.dataset.key] ?? 0);
                const label = document.getElementById(`adj-${s.dataset.key}`);
                if (label) label.textContent = String(s.value);
            });

            zoom = 1;
            panX = 0;
            panY = 0;

            ctx.setTransform(1, 0, 0, 1, 0, 0);
            canvas.width  = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
            canvas.style.filter = '';
            applyImageTransform();
            pushCanvasHistory(canvas);
            setEditorSaved(false);
        };

        editorState.onSave = async () => {
            const fileName = document.getElementById('editor-file-name').value.trim() || file.name;
            const exportBlob = await canvasToBlobWithFilters(canvas, adjustment);
            const ok = await saveBlobToExistingFile(file, exportBlob, 'image/png', fileName);
            return ok;
        };
        editorState.cleanup = () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('keyup', onKeyUp);
            URL.revokeObjectURL(imageURL);
        };
    }

    function renderAdjustSlider(key, min, max, value) {
        return `
            <div class="adjust-row">
                <label><span>${key[0].toUpperCase() + key.slice(1)}</span><span id="adj-${key}">${value}</span></label>
                <input class="adjust-slider" data-key="${key}" type="range" min="${min}" max="${max}" value="${value}">
            </div>
        `;
    }

    function applyPreset(name, state) {
        const presets = {
            original: { brightness: 0, contrast: 0, saturation: 0, blur: 0, opacity: 100 },
            grayscale: { brightness: 0, contrast: 0, saturation: -100, blur: 0, opacity: 100 },
            sepia: { brightness: 6, contrast: 5, saturation: -20, blur: 0, opacity: 100 },
            vivid: { brightness: 8, contrast: 18, saturation: 25, blur: 0, opacity: 100 },
            cool: { brightness: -3, contrast: 8, saturation: -12, blur: 0, opacity: 100 },
            warm: { brightness: 5, contrast: 8, saturation: 10, blur: 0, opacity: 100 },
            fade: { brightness: 10, contrast: -20, saturation: -20, blur: 0, opacity: 90 },
            dramatic: { brightness: -8, contrast: 25, saturation: 14, blur: 0, opacity: 100 },
        };
        const target = presets[name] || presets.original;
        Object.keys(target).forEach((k) => {
            state[k] = target[k];
        });
    }

    async function canvasToBlobWithFilters(canvas, adjustment) {
        const off = document.createElement('canvas');
        off.width = canvas.width;
        off.height = canvas.height;
        const c = off.getContext('2d');
        c.filter = `brightness(${100 + adjustment.brightness}%) contrast(${100 + adjustment.contrast}%) saturate(${100 + adjustment.saturation}%) blur(${adjustment.blur}px) opacity(${adjustment.opacity}%)`;
        c.drawImage(canvas, 0, 0);
        return await new Promise((resolve) => off.toBlob((b) => resolve(b), 'image/png'));
    }

    function rotateCanvas(canvas, ctx, degrees) {
        const temp = document.createElement('canvas');
        temp.width = canvas.width;
        temp.height = canvas.height;
        const tctx = temp.getContext('2d');
        tctx.drawImage(canvas, 0, 0);

        const rad = degrees * (Math.PI / 180);
        const swap = Math.abs(degrees) === 90;
        const nw = swap ? canvas.height : canvas.width;
        const nh = swap ? canvas.width : canvas.height;

        canvas.width = nw;
        canvas.height = nh;
        ctx.save();
        ctx.translate(nw / 2, nh / 2);
        ctx.rotate(rad);
        ctx.drawImage(temp, -temp.width / 2, -temp.height / 2);
        ctx.restore();
        pushCanvasHistory(canvas);
        setEditorSaved(false);
    }

    function flipCanvas(canvas, ctx, horizontal) {
        const temp = document.createElement('canvas');
        temp.width = canvas.width;
        temp.height = canvas.height;
        const tctx = temp.getContext('2d');
        tctx.drawImage(canvas, 0, 0);
        ctx.save();
        if (horizontal) {
            ctx.scale(-1, 1);
            ctx.drawImage(temp, -canvas.width, 0);
        } else {
            ctx.scale(1, -1);
            ctx.drawImage(temp, 0, -canvas.height);
        }
        ctx.restore();
        pushCanvasHistory(canvas);
        setEditorSaved(false);
    }

    function pushCanvasHistory(canvas) {
        if (!editorState) return;
        editorState.undo.push(canvas.toDataURL('image/png'));
        if (editorState.undo.length > 40) editorState.undo.shift();
        editorState.redo = [];
    }

    function undoCanvas(canvas, ctx) {
        if (!editorState || editorState.undo.length < 2) return;
        const current = editorState.undo.pop();
        editorState.redo.push(current);
        const previous = editorState.undo[editorState.undo.length - 1];
        restoreCanvasFromDataURL(canvas, ctx, previous);
        setEditorSaved(false);
    }

    function redoCanvas(canvas, ctx) {
        if (!editorState || !editorState.redo.length) return;
        const next = editorState.redo.pop();
        editorState.undo.push(next);
        restoreCanvasFromDataURL(canvas, ctx, next);
        setEditorSaved(false);
    }

    function restoreCanvasFromDataURL(canvas, ctx, url) {
        const image = new Image();
        image.onload = () => {
            canvas.width = image.width;
            canvas.height = image.height;
            ctx.drawImage(image, 0, 0);
        };
        image.src = url;
    }

    async function openTextEditor(file) {
        Components.toast('Loading file...', 'info');
        const blob = await decryptFileBlob(file);
        const text = await blob.text();
        const shell = openEditorShell(file);

        const ext = getFileExtension(file.name);
        const isRichText = ['md', 'html', 'htm', 'txt'].includes(ext);

        const wrap = document.createElement('div');
        wrap.className = `text-editor-wrap${isRichText ? ' text-editor-docs' : ' text-editor-code'}`;

        if (isRichText) {
            wrap.innerHTML = `
                <div class="text-toolbar" id="text-toolbar">
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="undo" title="Undo"><span class="material-icons-outlined">undo</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="redo" title="Redo"><span class="material-icons-outlined">redo</span></button>
                    <span class="tool-sep" aria-hidden="true"></span>
                    <select id="text-block" class="tool-select" title="Styles">
                        <option value="p">Normal</option>
                        <option value="h1">Heading 1</option>
                        <option value="h2">Heading 2</option>
                        <option value="h3">Heading 3</option>
                        <option value="h4">Heading 4</option>
                        <option value="h5">Heading 5</option>
                        <option value="h6">Heading 6</option>
                    </select>
                    <select id="text-font" class="tool-select" title="Font">
                        <option value="Arial">Arial</option>
                        <option value="Georgia">Georgia</option>
                        <option value="Times New Roman">Times New Roman</option>
                        <option value="Courier New">Courier New</option>
                        <option value="Manrope">Manrope</option>
                        <option value="Space Grotesk">Space Grotesk</option>
                    </select>
                    <select id="text-size" class="tool-select" title="Font size">
                        <option value="12">12</option>
                        <option value="14">14</option>
                        <option value="16" selected>16</option>
                        <option value="18">18</option>
                        <option value="24">24</option>
                        <option value="32">32</option>
                        <option value="48">48</option>
                    </select>
                    <span class="tool-sep" aria-hidden="true"></span>
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="bold" title="Bold"><span class="material-icons-outlined">format_bold</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="italic" title="Italic"><span class="material-icons-outlined">format_italic</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="underline" title="Underline"><span class="material-icons-outlined">format_underlined</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="strikeThrough" title="Strikethrough"><span class="material-icons-outlined">strikethrough_s</span></button>
                    <label class="tool-color" title="Text color"><span class="material-icons-outlined">format_color_text</span><input type="color" id="text-color" value="#202124"></label>
                    <label class="tool-color" title="Highlight color"><span class="material-icons-outlined">format_color_fill</span><input type="color" id="text-highlight" value="#ffff00"></label>
                    <span class="tool-sep" aria-hidden="true"></span>
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="insertUnorderedList" title="Bulleted list"><span class="material-icons-outlined">format_list_bulleted</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="insertOrderedList" title="Numbered list"><span class="material-icons-outlined">format_list_numbered</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="outdent" title="Decrease indent"><span class="material-icons-outlined">format_indent_decrease</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="indent" title="Increase indent"><span class="material-icons-outlined">format_indent_increase</span></button>
                    <span class="tool-sep" aria-hidden="true"></span>
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="justifyLeft" title="Align left"><span class="material-icons-outlined">format_align_left</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="justifyCenter" title="Align center"><span class="material-icons-outlined">format_align_center</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="justifyRight" title="Align right"><span class="material-icons-outlined">format_align_right</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="justifyFull" title="Justify"><span class="material-icons-outlined">format_align_justify</span></button>
                    <span class="tool-sep" aria-hidden="true"></span>
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="subscript" title="Subscript"><span class="material-icons-outlined">subscript</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="superscript" title="Superscript"><span class="material-icons-outlined">superscript</span></button>
                    <span class="tool-sep" aria-hidden="true"></span>
                    <button type="button" class="tool-btn tool-btn-icon" id="text-link" title="Insert link"><span class="material-icons-outlined">link</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" id="text-image" title="Insert image"><span class="material-icons-outlined">image</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" id="text-quote" title="Quote"><span class="material-icons-outlined">format_quote</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" id="text-code" title="Code block"><span class="material-icons-outlined">code</span></button>
                    <button type="button" class="tool-btn tool-btn-icon" data-cmd="removeFormat" title="Clear formatting"><span class="material-icons-outlined">format_clear</span></button>
                    <input type="file" id="text-image-input" accept="image/*" hidden>
                </div>
                <div class="text-editor-scroll">
                    <div class="text-editor text-editor-page" id="text-editor" contenteditable="true" spellcheck="true"></div>
                </div>
                <div class="text-meta">
                    <span id="text-autosave">Auto-save every 30s</span>
                    <span id="text-count">0 words · 0 chars</span>
                </div>
            `;
        } else {
            wrap.innerHTML = `
                <textarea class="text-editor text-editor-plain" id="text-editor-plain" spellcheck="false"></textarea>
                <div class="text-meta">
                    <span id="text-autosave">Auto-save every 30s</span>
                    <span id="text-count">0 words · 0 chars</span>
                </div>
            `;
        }
        shell.appendChild(wrap);

        let editor, getEditorValue, setEditorValue;
        let selectionListener = null;

        if (isRichText) {
            editor = document.getElementById('text-editor');
            const loadRichContent = (v) => {
                const trimmed = (v || '').trim();
                if (trimmed.startsWith('<') || /<[a-z][\s\S]*>/i.test(trimmed)) {
                    editor.innerHTML = v;
                } else {
                    editor.textContent = v;
                }
            };
            loadRichContent(text);
            getEditorValue = () => editor.innerHTML;
            setEditorValue = (v) => loadRichContent(v);

            const syncToolbarState = () => {
                document.querySelectorAll('#text-toolbar [data-cmd]').forEach((b) => {
                    const cmd = b.dataset.cmd;
                    if (['undo', 'redo', 'indent', 'outdent', 'removeFormat'].includes(cmd)) {
                        b.classList.remove('active');
                        return;
                    }
                    try {
                        b.classList.toggle('active', document.queryCommandState(cmd));
                    } catch (_) {
                        b.classList.remove('active');
                    }
                });
            };

            const runCmd = (cmd, value = null) => {
                document.execCommand(cmd, false, value);
                editor.focus();
                setEditorSaved(false);
                syncToolbarState();
            };

            document.querySelectorAll('#text-toolbar [data-cmd]').forEach((b) => {
                b.addEventListener('mousedown', (e) => e.preventDefault());
                b.addEventListener('click', () => runCmd(b.dataset.cmd));
            });

            document.getElementById('text-block').addEventListener('change', (e) => {
                const tag = e.target.value || 'p';
                runCmd('formatBlock', `<${tag}>`);
            });

            document.getElementById('text-link').addEventListener('mousedown', (e) => e.preventDefault());
            document.getElementById('text-link').addEventListener('click', () => {
                const href = prompt('Enter URL');
                if (!href) return;
                runCmd('createLink', href);
            });

            document.getElementById('text-quote').addEventListener('mousedown', (e) => e.preventDefault());
            document.getElementById('text-quote').addEventListener('click', () => {
                runCmd('formatBlock', '<blockquote>');
            });

            document.getElementById('text-code').addEventListener('mousedown', (e) => e.preventDefault());
            document.getElementById('text-code').addEventListener('click', () => {
                document.execCommand('insertHTML', false, '<pre><code></code></pre>');
                editor.focus();
                setEditorSaved(false);
            });

            const imageInput = document.getElementById('text-image-input');
            document.getElementById('text-image').addEventListener('mousedown', (e) => e.preventDefault());
            document.getElementById('text-image').addEventListener('click', () => imageInput.click());
            imageInput.addEventListener('change', () => {
                const fileObj = imageInput.files?.[0];
                imageInput.value = '';
                if (!fileObj) return;
                const reader = new FileReader();
                reader.onload = () => {
                    document.execCommand('insertImage', false, reader.result);
                    editor.focus();
                    setEditorSaved(false);
                };
                reader.readAsDataURL(fileObj);
            });

            document.getElementById('text-font').addEventListener('change', (e) => {
                runCmd('fontName', e.target.value);
            });

            document.getElementById('text-size').addEventListener('change', (e) => {
                const px = e.target.value;
                document.execCommand('fontSize', false, 7);
                const fonts = editor.getElementsByTagName('font');
                for (let i = 0; i < fonts.length; i += 1) {
                    if (fonts[i].size === '7') {
                        fonts[i].removeAttribute('size');
                        fonts[i].style.fontSize = `${px}px`;
                    }
                }
                editor.focus();
                setEditorSaved(false);
            });

            document.getElementById('text-color').addEventListener('input', (e) => {
                runCmd('foreColor', e.target.value);
            });

            document.getElementById('text-highlight').addEventListener('input', (e) => {
                runCmd('hiliteColor', e.target.value);
            });

            editor.addEventListener('input', () => {
                updateWordCount(editor.innerText || '');
                setEditorSaved(false);
            });

            selectionListener = () => {
                if (!editorState || document.getElementById('text-editor') !== editor) return;
                syncToolbarState();
            };
            document.addEventListener('selectionchange', selectionListener);
            syncToolbarState();
        } else {
            editor = document.getElementById('text-editor-plain');
            editor.value = text;
            getEditorValue = () => editor.value;
            setEditorValue = (v) => { editor.value = v; };

            editor.addEventListener('input', () => {
                updateWordCount(editor.value || '');
                setEditorSaved(false);
            });
        }

        updateWordCount(isRichText ? (editor.innerText || '') : editor.value);

        editorState.onUndo = () => {
            if (isRichText) {
                document.execCommand('undo', false, null);
            } else {
                document.execCommand('undo', false, null);
            }
            setEditorSaved(false);
        };
        editorState.onRedo = () => {
            document.execCommand('redo', false, null);
            setEditorSaved(false);
        };

        const doSave = async () => {
            const fileName = document.getElementById('editor-file-name').value.trim() || file.name;
            const content = getEditorValue();
            const mimeType = isRichText ? 'text/html' : (file.mime_type || 'text/plain');
            const saveBlob = new Blob([content], { type: mimeType });
            const ok = await saveBlobToExistingFile(file, saveBlob, mimeType, fileName);
            if (ok) {
                setEditorSaved(true);
                document.getElementById('text-autosave').textContent = `Last saved ${Components.formatDate(new Date().toISOString())}`;
            }
            return ok;
        };

        const autosaveTimer = setInterval(async () => {
            if (!editorState?.unsaved) return;
            await doSave();
        }, 30000);

        editorState.onSave = async () => {
            return await doSave();
        };

        editorState.onReset = () => {
            setEditorValue(text);
            updateWordCount(isRichText ? (editor.innerText || '') : editor.value);
            setEditorSaved(false);
        };

        editorState.cleanup = () => {
            clearInterval(autosaveTimer);
            if (selectionListener) document.removeEventListener('selectionchange', selectionListener);
        };
    }

    function updateWordCount(text) {
        const words = (text.trim().match(/\S+/g) || []).length;
        const chars = text.length;
        document.getElementById('text-count').textContent = `${words} words · ${chars.toLocaleString()} chars`;
    }

    async function openPdfViewer(file) {
        const blob = await decryptFileBlob(file);
        const url = URL.createObjectURL(blob);
        const shell = openEditorShell(file);

        const wrap = document.createElement('div');
        wrap.className = 'pdf-wrap';
        wrap.innerHTML = `
            <div class="pdf-toolbar">
                <div class="row-inline">
                    <button class="btn btn-secondary btn-sm" id="pdf-print">Print</button>
                    <button class="btn btn-secondary btn-sm" id="pdf-download">Download</button>
                </div>
            </div>
            <div class="pdf-content">
                <iframe class="pdf-view" id="pdf-view" src="${url}" title="${esc(file.name)}"></iframe>
            </div>
        `;
        shell.appendChild(wrap);

        document.getElementById('pdf-print').addEventListener('click', () => {
            document.getElementById('pdf-view')?.contentWindow?.print();
        });
        document.getElementById('pdf-download').addEventListener('click', () => {
            const a = document.createElement('a');
            a.href = url;
            a.download = file.name || 'document.pdf';
            a.click();
        });

        editorState.onSave = async () => true;
        editorState.onReset = () => {};
    }

    async function openVideoPlayer(file) {
        const blob = await decryptFileBlob(file);
        const url = URL.createObjectURL(blob);
        const shell = openEditorShell(file);

        const wrap = document.createElement('div');
        wrap.className = 'video-wrap';
        wrap.innerHTML = `
            <div class="video-cinema">
                <video class="video-el" id="video-element" src="${url}" preload="metadata"></video>

                <div class="video-center-play" id="video-center-play">
                    <svg viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
                </div>

                <div class="video-overlay" id="video-overlay">
                    <div class="video-overlay-top">
                        <span class="video-title-label">${esc(file.name)}</span>
                        <button class="video-icon-btn" id="video-fullscreen" title="Fullscreen">
                            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
                        </button>
                    </div>

                    <div class="video-overlay-bottom">
                        <div class="video-seekbar-wrap">
                            <input type="range" class="video-seekbar" id="video-progress" min="0" max="1000" value="0" step="1">
                            <div class="video-buffered" id="video-buffered"></div>
                        </div>
                        <div class="video-controls-row">
                            <div class="video-controls-left">
                                <button class="video-icon-btn" id="video-play" title="Play/Pause">
                                    <svg class="ico-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                                    <svg class="ico-pause hidden" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                                </button>
                                <button class="video-icon-btn" id="video-back" title="Back 10s">
                                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6h-2c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/><text x="8.5" y="14.5" font-size="5" fill="currentColor" font-family="sans-serif">10</text></svg>
                                </button>
                                <button class="video-icon-btn" id="video-fwd" title="Forward 10s">
                                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/><text x="9" y="14.5" font-size="5" fill="currentColor" font-family="sans-serif">10</text></svg>
                                </button>
                                <div class="video-vol-group">
                                    <button class="video-icon-btn" id="video-mute" title="Mute">
                                        <svg class="ico-vol" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                                        <svg class="ico-mute hidden" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
                                    </button>
                                    <input type="range" class="video-vol-slider" id="video-volume" min="0" max="1" step="0.02" value="1">
                                </div>
                                <span class="video-time-label" id="video-time">0:00 / 0:00</span>
                            </div>
                            <div class="video-controls-right">
                                <select class="video-speed-sel" id="video-speed">
                                    <option value="0.5">0.5×</option>
                                    <option value="1" selected>1×</option>
                                    <option value="1.25">1.25×</option>
                                    <option value="1.5">1.5×</option>
                                    <option value="2">2×</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        shell.appendChild(wrap);

        const cinema = wrap.querySelector('.video-cinema');
        const v = document.getElementById('video-element');
        const overlay = document.getElementById('video-overlay');
        const centerPlay = document.getElementById('video-center-play');
        const playBtn = document.getElementById('video-play');
        const progress = document.getElementById('video-progress');
        const buffered = document.getElementById('video-buffered');
        const timeLabel = document.getElementById('video-time');
        const icoPlay = playBtn.querySelector('.ico-play');
        const icoPause = playBtn.querySelector('.ico-pause');

        let hideTimer = null;
        function showControls() {
            overlay.classList.add('visible');
            centerPlay.classList.remove('visible');
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                if (!v.paused) overlay.classList.remove('visible');
            }, 2800);
        }

        cinema.addEventListener('mousemove', showControls);
        cinema.addEventListener('mouseenter', showControls);
        cinema.addEventListener('mouseleave', () => {
            clearTimeout(hideTimer);
            if (!v.paused) overlay.classList.remove('visible');
        });

        function syncPlayState() {
            if (v.paused) {
                icoPlay.classList.remove('hidden');
                icoPause.classList.add('hidden');
                overlay.classList.add('visible');
                clearTimeout(hideTimer);
            } else {
                icoPlay.classList.add('hidden');
                icoPause.classList.remove('hidden');
            }
        }

        function fmt(sec) {
            if (!Number.isFinite(sec)) return '0:00';
            const m = Math.floor(sec / 60);
            const s = Math.floor(sec % 60);
            return `${m}:${String(s).padStart(2, '0')}`;
        }

        v.addEventListener('play', syncPlayState);
        v.addEventListener('pause', syncPlayState);

        v.addEventListener('timeupdate', () => {
            if (!v.duration) return;
            progress.value = String((v.currentTime / v.duration) * 1000);
            timeLabel.textContent = `${fmt(v.currentTime)} / ${fmt(v.duration)}`;
        });

        v.addEventListener('progress', () => {
            if (!v.duration || !v.buffered.length) return;
            const pct = (v.buffered.end(v.buffered.length - 1) / v.duration) * 100;
            buffered.style.width = `${pct}%`;
        });

        progress.addEventListener('input', () => {
            if (v.duration) v.currentTime = (Number(progress.value) / 1000) * v.duration;
        });

        playBtn.addEventListener('click', () => { if (v.paused) v.play(); else v.pause(); });
        centerPlay.addEventListener('click', () => { if (v.paused) v.play(); else v.pause(); });

        cinema.addEventListener('dblclick', (e) => {
            if (e.target.closest('.video-overlay')) return;
            if (v.requestFullscreen) v.requestFullscreen();
        });

        cinema.addEventListener('click', (e) => {
            if (e.target.closest('.video-overlay')) return;
            if (v.paused) v.play(); else v.pause();
            centerPlay.classList.add('visible');
            setTimeout(() => centerPlay.classList.remove('visible'), 600);
        });

        document.getElementById('video-back').addEventListener('click', () => { v.currentTime = Math.max(0, v.currentTime - 10); });
        document.getElementById('video-fwd').addEventListener('click', () => { v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); });

        const volSlider = document.getElementById('video-volume');
        const icoVol = document.getElementById('video-mute').querySelector('.ico-vol');
        const icoMute = document.getElementById('video-mute').querySelector('.ico-mute');

        volSlider.addEventListener('input', (e) => {
            v.volume = Number(e.target.value);
            v.muted = v.volume === 0;
            icoVol.classList.toggle('hidden', v.muted);
            icoMute.classList.toggle('hidden', !v.muted);
        });

        document.getElementById('video-mute').addEventListener('click', () => {
            v.muted = !v.muted;
            icoVol.classList.toggle('hidden', v.muted);
            icoMute.classList.toggle('hidden', !v.muted);
            volSlider.value = v.muted ? '0' : String(v.volume || 1);
        });

        document.getElementById('video-speed').addEventListener('change', (e) => { v.playbackRate = Number(e.target.value); });

        document.getElementById('video-fullscreen').addEventListener('click', () => {
            if (v.requestFullscreen) v.requestFullscreen();
            else if (cinema.requestFullscreen) cinema.requestFullscreen();
        });

        // Keyboard shortcuts
        wrap.setAttribute('tabindex', '-1');
        wrap.addEventListener('keydown', (e) => {
            if (e.code === 'Space') { e.preventDefault(); if (v.paused) v.play(); else v.pause(); }
            if (e.code === 'ArrowRight') v.currentTime = Math.min(v.duration || 0, v.currentTime + 5);
            if (e.code === 'ArrowLeft') v.currentTime = Math.max(0, v.currentTime - 5);
            if (e.code === 'ArrowUp') { v.volume = Math.min(1, v.volume + 0.1); volSlider.value = String(v.volume); }
            if (e.code === 'ArrowDown') { v.volume = Math.max(0, v.volume - 0.1); volSlider.value = String(v.volume); }
            if (e.code === 'KeyF') { if (v.requestFullscreen) v.requestFullscreen(); }
        });

        v.play();
        editorState.onSave = async () => true;
        editorState.onReset = () => {
            v.currentTime = 0;
            v.playbackRate = 1;
            document.getElementById('video-speed').value = '1';
        };
    }

    async function openAudioPlayer(file) {
        const blob = await decryptFileBlob(file);
        const url = URL.createObjectURL(blob);

        const player = document.getElementById('audio-mini-player');
        const audio = document.getElementById('background-audio');
        const title = document.getElementById('audio-title');
        player.classList.remove('hidden');
        title.textContent = file.name;

        const playlist = filteredFiles.filter((f) => getMimeGroup(f.mime_type, 'file', f.name) === 'audio');
        let idx = Math.max(0, playlist.findIndex((f) => f.id === file.id));
        let repeat = false;
        let shuffle = false;

        const playIndex = async (nextIdx) => {
            idx = nextIdx;
            const current = playlist[idx];
            const dec = await decryptFileBlob(current);
            const localURL = URL.createObjectURL(dec);
            audio.src = localURL;
            title.textContent = current.name;
            audio.play();
        };

        audio.src = url;
        audio.play();

        document.getElementById('audio-toggle').onclick = () => {
            if (audio.paused) audio.play(); else audio.pause();
        };
        document.getElementById('audio-prev').onclick = () => {
            const next = idx <= 0 ? playlist.length - 1 : idx - 1;
            playIndex(next);
        };
        document.getElementById('audio-next').onclick = () => {
            const next = shuffle ? Math.floor(Math.random() * playlist.length) : (idx + 1) % playlist.length;
            playIndex(next);
        };
        document.getElementById('audio-shuffle').onclick = () => { shuffle = !shuffle; };
        document.getElementById('audio-repeat').onclick = () => { repeat = !repeat; };

        audio.onended = () => {
            if (repeat) {
                audio.currentTime = 0;
                audio.play();
            } else {
                const next = shuffle ? Math.floor(Math.random() * playlist.length) : (idx + 1) % playlist.length;
                playIndex(next);
            }
        };

        startWaveform(audio);
        Components.toast('Audio playback started', 'success');
    }

    function startWaveform(audio) {
        const canvas = document.getElementById('audio-wave');
        const ctx = canvas.getContext('2d');

        const actx = new (window.AudioContext || window.webkitAudioContext)();
        const src = actx.createMediaElementSource(audio);
        const analyser = actx.createAnalyser();
        analyser.fftSize = 128;
        src.connect(analyser);
        analyser.connect(actx.destination);
        const data = new Uint8Array(analyser.frequencyBinCount);

        const draw = () => {
            if (audio.paused) {
                requestAnimationFrame(draw);
                return;
            }
            analyser.getByteFrequencyData(data);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#7c5cfc';
            const barW = canvas.width / data.length;
            for (let i = 0; i < data.length; i += 1) {
                const h = (data[i] / 255) * canvas.height;
                ctx.fillRect(i * barW, canvas.height - h, barW - 1, h);
            }
            requestAnimationFrame(draw);
        };
        draw();
    }

    async function openSheetViewer(file) {
        const shell = openEditorShell(file);
        const ext = getFileExtension(file.name);
        const isXlsx = (file.mime_type || '').includes('spreadsheetml')
            || (file.mime_type || '').includes('ms-excel')
            || ext === 'xlsx'
            || ext === 'xls';

        const wrap = document.createElement('div');
        wrap.className = 'sheet-wrap';
        wrap.innerHTML = `
            <div class="sheet-toolbar">
                <button type="button" class="tool-btn tool-btn-icon" id="sheet-undo" title="Undo"><span class="material-icons-outlined">undo</span></button>
                <button type="button" class="tool-btn tool-btn-icon" id="sheet-redo" title="Redo"><span class="material-icons-outlined">redo</span></button>
                <span class="tool-sep" aria-hidden="true"></span>
                <label class="sheet-search-wrap" title="Find rows">
                    <span class="material-icons-outlined">search</span>
                    <input id="sheet-search" placeholder="Search">
                </label>
                <span class="tool-sep" aria-hidden="true"></span>
                <button type="button" class="tool-btn tool-btn-icon" id="sheet-export" title="Export CSV"><span class="material-icons-outlined">download</span></button>
            </div>
            <div class="sheet-formula-bar">
                <span class="sheet-cell-address" id="sheet-cell-address">A1</span>
                <span class="sheet-fx">fx</span>
                <input id="sheet-formula-input" aria-label="Cell value or formula" placeholder="Select a cell">
            </div>
            <div class="sheet-body" id="sheet-body"><div style="padding:40px;text-align:center;color:var(--fd-text-muted)">Loading...</div></div>
            <div class="sheet-tabs-bar" id="sheet-tabs"></div>
        `;
        shell.appendChild(wrap);

        let workbook = null;
        let sheetNames = [];
        let activeSheetIdx = 0;
        let csvRows = [];
        let activeCell = { row: 0, col: 0 };
        let searchTerm = '';
        const changes = new Map();
        const undoStack = [];
        const redoStack = [];

        try {
            const blob = await decryptFileBlob(file);
            if (isXlsx) {
                await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', 'XLSX');
                const arrayBuffer = await blob.arrayBuffer();
                workbook = window.XLSX.read(arrayBuffer, {
                    type: 'array',
                    cellFormula: true,
                    cellStyles: true,
                    cellNF: true,
                    cellDates: true,
                });
                sheetNames = workbook.SheetNames || [];
                if (!sheetNames.length) {
                    throw new Error('No worksheet found in this file');
                }
            } else {
                const csv = await blob.text();
                csvRows = csv.split(/\r?\n/).filter((r) => r.length > 0).map((r) => r.split(','));
                if (!csvRows.length) csvRows = [['']];
                sheetNames = ['Sheet1'];
            }
        } catch (err) {
            const body = document.getElementById('sheet-body');
            if (body) {
                body.innerHTML = `<div style="padding:40px;text-align:center;color:#ea4335">Failed to open table: ${esc(err.message || 'Unknown error')}</div>`;
            }
            return;
        }

        const changeKey = (sheetIdx, row, col) => `${sheetIdx}:${row}:${col}`;
        const encodeCell = (row, col) => window.XLSX
            ? window.XLSX.utils.encode_cell({ r: row, c: col })
            : `${columnName(col)}${row + 1}`;

        function columnName(index) {
            let value = index + 1;
            let name = '';
            while (value > 0) {
                const remainder = (value - 1) % 26;
                name = String.fromCharCode(65 + remainder) + name;
                value = Math.floor((value - 1) / 26);
            }
            return name;
        }

        function sheetDimensions() {
            if (!workbook) {
                return {
                    rows: Math.max(20, csvRows.length),
                    cols: Math.max(10, ...csvRows.map((row) => row.length)),
                };
            }
            const sheet = workbook.Sheets[sheetNames[activeSheetIdx]];
            const range = window.XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
            return {
                rows: Math.max(20, range.e.r + 1),
                cols: Math.max(10, range.e.c + 1),
            };
        }

        function originalCellValue(sheetIdx, row, col, formula = false) {
            if (!workbook) return String(csvRows[row]?.[col] ?? '');
            const sheet = workbook.Sheets[sheetNames[sheetIdx]];
            const cell = sheet?.[encodeCell(row, col)];
            if (!cell) return '';
            if (formula && cell.f) return `=${cell.f}`;
            return String(window.XLSX.utils.format_cell(cell) ?? cell.v ?? '');
        }

        function displayedCellValue(sheetIdx, row, col, formula = false) {
            const changed = changes.get(changeKey(sheetIdx, row, col));
            return changed !== undefined ? changed : originalCellValue(sheetIdx, row, col, formula);
        }

        function recordChange(row, col, value, addHistory = true) {
            const key = changeKey(activeSheetIdx, row, col);
            const oldValue = displayedCellValue(activeSheetIdx, row, col, true);
            const newValue = String(value ?? '');
            if (oldValue === newValue) return;
            const original = originalCellValue(activeSheetIdx, row, col, true);
            if (newValue === original) changes.delete(key);
            else changes.set(key, newValue);
            if (addHistory) {
                undoStack.push({ sheetIdx: activeSheetIdx, row, col, oldValue, newValue });
                redoStack.length = 0;
            }
            setEditorSaved(false);
        }

        function selectCell(row, col, focus = false) {
            activeCell = { row, col };
            wrap.querySelectorAll('.sheet-table td.active').forEach((cell) => cell.classList.remove('active'));
            const cell = wrap.querySelector(`.sheet-table td[data-row="${row}"][data-col="${col}"]`);
            cell?.classList.add('active');
            document.getElementById('sheet-cell-address').textContent = `${columnName(col)}${row + 1}`;
            document.getElementById('sheet-formula-input').value = displayedCellValue(activeSheetIdx, row, col, true);
            if (focus) cell?.focus();
        }

        const renderTable = () => {
            const body = document.getElementById('sheet-body');
            if (!body) return;
            const dimensions = sheetDimensions();
            const matchingRows = new Set();
            for (let row = 0; row < dimensions.rows; row += 1) {
                if (!searchTerm) {
                    matchingRows.add(row);
                    continue;
                }
                for (let col = 0; col < dimensions.cols; col += 1) {
                    if (displayedCellValue(activeSheetIdx, row, col).toLowerCase().includes(searchTerm)) {
                        matchingRows.add(row);
                        break;
                    }
                }
            }

            body.innerHTML = `
                <table class="sheet-table" id="sheet-table">
                    <thead><tr><th class="sheet-corner"></th>${Array.from({ length: dimensions.cols }, (_, col) => `<th>${columnName(col)}</th>`).join('')}</tr></thead>
                    <tbody>
                        ${Array.from({ length: dimensions.rows }, (_, row) => `
                            <tr${matchingRows.has(row) ? '' : ' hidden'}>
                                <th class="sheet-row-number">${row + 1}</th>
                                ${Array.from({ length: dimensions.cols }, (_, col) => `<td contenteditable="true" spellcheck="false" data-row="${row}" data-col="${col}">${esc(displayedCellValue(activeSheetIdx, row, col))}</td>`).join('')}
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `;

            body.querySelectorAll('#sheet-table td').forEach((td) => {
                td.addEventListener('focus', () => {
                    td.dataset.startDisplay = td.textContent;
                    selectCell(Number(td.dataset.row), Number(td.dataset.col));
                });
                td.addEventListener('click', () => selectCell(Number(td.dataset.row), Number(td.dataset.col)));
                td.addEventListener('blur', () => {
                    const row = Number(td.dataset.row);
                    const col = Number(td.dataset.col);
                    if (td.textContent !== td.dataset.startDisplay) {
                        recordChange(row, col, td.textContent);
                    }
                    td.textContent = displayedCellValue(activeSheetIdx, row, col);
                    selectCell(row, col);
                });
            });
            selectCell(activeCell.row, activeCell.col);
        };

        function renderTabs() {
            const tabs = document.getElementById('sheet-tabs');
            tabs.innerHTML = sheetNames.map((name, index) => `
                <button type="button" class="sheet-tab${index === activeSheetIdx ? ' active' : ''}" data-sheet-index="${index}">
                    <span class="material-icons-outlined">table_chart</span>${esc(name)}
                </button>
            `).join('');
            tabs.querySelectorAll('.sheet-tab').forEach((tab) => {
                tab.addEventListener('click', () => {
                    activeSheetIdx = Number(tab.dataset.sheetIndex);
                    activeCell = { row: 0, col: 0 };
                    renderTabs();
                    renderTable();
                });
            });
        }

        function applyHistoryEntry(entry, useOldValue) {
            const key = changeKey(entry.sheetIdx, entry.row, entry.col);
            const value = useOldValue ? entry.oldValue : entry.newValue;
            const original = originalCellValue(entry.sheetIdx, entry.row, entry.col, true);
            if (value === original) changes.delete(key);
            else changes.set(key, value);
            activeSheetIdx = entry.sheetIdx;
            activeCell = { row: entry.row, col: entry.col };
            renderTabs();
            renderTable();
            setEditorSaved(false);
        }

        editorState.onUndo = () => {
            const entry = undoStack.pop();
            if (!entry) return;
            redoStack.push(entry);
            applyHistoryEntry(entry, true);
        };
        editorState.onRedo = () => {
            const entry = redoStack.pop();
            if (!entry) return;
            undoStack.push(entry);
            applyHistoryEntry(entry, false);
        };

        document.getElementById('sheet-undo').addEventListener('click', () => editorState.onUndo());
        document.getElementById('sheet-redo').addEventListener('click', () => editorState.onRedo());
        document.getElementById('sheet-search').addEventListener('input', (e) => {
            searchTerm = e.target.value.trim().toLowerCase();
            renderTable();
        });
        document.getElementById('sheet-formula-input').addEventListener('change', (e) => {
            recordChange(activeCell.row, activeCell.col, e.target.value);
            renderTable();
            selectCell(activeCell.row, activeCell.col, true);
        });
        document.getElementById('sheet-export')?.addEventListener('click', () => {
            const data = collectSheetData();
            const out = data.map((r) => r.join(',')).join('\n');
            const outBlob = new Blob([out], { type: 'text/csv' });
            const url = URL.createObjectURL(outBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = (file.name || 'sheet.csv').replace(/\.(xlsx|xls)$/i, '.csv');
            a.click();
            URL.revokeObjectURL(url);
        });

        function collectSheetData() {
            const dimensions = sheetDimensions();
            return Array.from({ length: dimensions.rows }, (_, row) =>
                Array.from({ length: dimensions.cols }, (_, col) =>
                    displayedCellValue(activeSheetIdx, row, col, true),
                ),
            );
        }

        function assignCellValue(sheet, address, value) {
            const existing = sheet[address] || {};
            const next = { ...existing };
            delete next.w;
            if (value.startsWith('=')) {
                next.f = value.slice(1);
                delete next.v;
                if (!next.t) next.t = 'n';
            } else {
                delete next.f;
                if (value === '') {
                    next.v = '';
                    next.t = 's';
                } else if (/^-?(?:\d+|\d*\.\d+)$/.test(value)) {
                    next.v = Number(value);
                    next.t = 'n';
                } else if (/^(true|false)$/i.test(value)) {
                    next.v = value.toLowerCase() === 'true';
                    next.t = 'b';
                } else {
                    next.v = value;
                    next.t = 's';
                }
            }
            sheet[address] = next;

            const decoded = window.XLSX.utils.decode_cell(address);
            const range = window.XLSX.utils.decode_range(sheet['!ref'] || address);
            range.s.r = Math.min(range.s.r, decoded.r);
            range.s.c = Math.min(range.s.c, decoded.c);
            range.e.r = Math.max(range.e.r, decoded.r);
            range.e.c = Math.max(range.e.c, decoded.c);
            sheet['!ref'] = window.XLSX.utils.encode_range(range);
        }

        editorState.onSave = async () => {
            let saveBlob;
            let mimeType;

            if (workbook && window.XLSX) {
                changes.forEach((value, key) => {
                    const [sheetIdx, row, col] = key.split(':').map(Number);
                    const sheet = workbook.Sheets[sheetNames[sheetIdx]];
                    assignCellValue(sheet, encodeCell(row, col), value);
                });
                const bookType = ext === 'xls' ? 'xls' : 'xlsx';
                const out = window.XLSX.write(workbook, {
                    bookType,
                    type: 'array',
                    cellStyles: true,
                    cellNF: true,
                });
                if (bookType === 'xls') {
                    saveBlob = new Blob([out], { type: 'application/vnd.ms-excel' });
                    mimeType = 'application/vnd.ms-excel';
                } else {
                    saveBlob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                    mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
                }
            } else {
                changes.forEach((value, key) => {
                    const [, row, col] = key.split(':').map(Number);
                    while (csvRows.length <= row) csvRows.push([]);
                    csvRows[row][col] = value;
                });
                const data = csvRows;
                const out = data.map((r) => r.join(',')).join('\n');
                saveBlob = new Blob([out], { type: 'text/csv' });
                mimeType = 'text/csv';
            }

            const fileName = document.getElementById('editor-file-name').value.trim() || file.name;
            const saved = await saveBlobToExistingFile(file, saveBlob, mimeType, fileName);
            if (saved) changes.clear();
            return saved;
        };

        renderTabs();
        renderTable();
    }

    function loadScript(src, globalName) {
        if (globalName && window[globalName]) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(`script[data-src="${src}"]`);
            if (existing) {
                if (!globalName || window[globalName]) {
                    resolve();
                    return;
                }
                const iv = setInterval(() => {
                    if (window[globalName]) {
                        clearInterval(iv);
                        resolve();
                    }
                }, 50);
                setTimeout(() => {
                    clearInterval(iv);
                    reject(new Error('Script load timeout'));
                }, 30000);
                return;
            }
            const script = document.createElement('script');
            script.src = src;
            script.dataset.src = src;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`Failed to load: ${src}`));
            document.head.appendChild(script);
        });
    }

    async function openJsonViewer(file) {
        const shell = openEditorShell(file, 'JSON');
        const wrap = document.createElement('div');
        wrap.className = 'json-viewer-wrap';
        wrap.innerHTML = `
            <div class="json-toolbar" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px;border-bottom:1px solid var(--fd-border);">
                <button class="btn btn-secondary btn-sm" id="json-format">Format</button>
                <button class="btn btn-secondary btn-sm" id="json-minify">Minify</button>
                <button class="btn btn-secondary btn-sm" id="json-validate">Validate</button>
            </div>
            <div style="padding:10px;">
                <textarea id="json-editor" spellcheck="false" style="width:100%;min-height:60vh;resize:vertical;background:var(--fd-bg-soft);color:var(--fd-text);border:1px solid var(--fd-border);border-radius:10px;padding:12px;font-family:'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:13px;line-height:1.45;"></textarea>
            </div>
        `;
        shell.appendChild(wrap);

        const editor = document.getElementById('json-editor');
        let originalText = '';

        try {
            const blob = await decryptFileBlob(file);
            originalText = await blob.text();
            editor.value = originalText;
        } catch (err) {
            Components.toast(`Failed to load JSON: ${err.message}`, 'error');
            editor.value = '';
        }

        editor.addEventListener('input', () => setEditorSaved(false));

        const parseOrToast = () => {
            try {
                return { ok: true, value: JSON.parse(editor.value) };
            } catch (err) {
                Components.toast(`Invalid JSON: ${err.message}`, 'error');
                return { ok: false, value: null };
            }
        };

        document.getElementById('json-format')?.addEventListener('click', () => {
            const parsed = parseOrToast();
            if (!parsed.ok) return;
            editor.value = `${JSON.stringify(parsed.value, null, 2)}\n`;
            setEditorSaved(false);
        });

        document.getElementById('json-minify')?.addEventListener('click', () => {
            const parsed = parseOrToast();
            if (!parsed.ok) return;
            editor.value = JSON.stringify(parsed.value);
            setEditorSaved(false);
        });

        document.getElementById('json-validate')?.addEventListener('click', () => {
            const parsed = parseOrToast();
            if (!parsed.ok) return;
            Components.toast('JSON is valid', 'success');
        });

        editorState.onSave = async () => {
            const parsed = parseOrToast();
            if (!parsed.ok) return false;
            const output = `${JSON.stringify(parsed.value, null, 2)}\n`;
            const saveBlob = new Blob([output], { type: 'application/json' });
            const fileName = document.getElementById('editor-file-name').value.trim() || file.name;
            return await saveBlobToExistingFile(file, saveBlob, 'application/json', fileName);
        };

        editorState.onReset = () => {
            editor.value = originalText;
            setEditorSaved(true);
        };
    }

    async function openVersionHistory(file) {
        try {
            const resp = await API.files.versions(file.id);
            const versions = resp.versions || [];
            if (!versions.length) {
                Components.toast('No previous versions', 'info');
                return;
            }

            const body = versions.map((v) => {
                return `
                    <div class="share-existing-entry" style="grid-template-columns:1fr 110px 90px;">
                        <div>Version ${v.version} · ${Components.formatDate(v.created_at)}</div>
                        <span>${Components.formatSize(v.size)}</span>
                        <button class="btn btn-secondary btn-sm" data-version="${v.version}">Restore</button>
                    </div>
                `;
            }).join('');

            Components.showModal('Version history', body, [{ text: 'Close' }]);
            setTimeout(() => {
                document.querySelectorAll('[data-version]').forEach((btn) => {
                    btn.addEventListener('click', async () => {
                        const version = btn.dataset.version;
                        try {
                            await API.files.restoreVersion(file.id, version);
                            Components.toast('Version restored', 'success');
                            Components.hideModal();
                            refresh();
                        } catch (err) {
                            Components.toast(`Restore failed: ${err.message}`, 'error');
                        }
                    });
                });
            }, 30);
        } catch {
            Components.toast('Version history unavailable', 'error');
        }
    }

    function showShortcuts() {
        const data = [
            {
                title: 'Navigation',
                items: [
                    ['n', 'New folder'],
                    ['u', 'Upload file'],
                    ['/', 'Search'],
                    ['g then h', 'Go to Home'],
                    ['g then d', 'Go to My Drive'],
                    ['g then r', 'Go to Recent'],
                    ['g then t', 'Go to Trash'],
                    ['g then s', 'Go to Storage'],
                    ['Backspace', 'Go up one folder'],
                ],
            },
            {
                title: 'Selection',
                items: [
                    ['a', 'Select all'],
                    ['Ctrl + A', 'Select all (alternative)'],
                    ['Esc', 'Deselect all / Close panel'],
                    ['↑ / ↓', 'Move selection up / down'],
                    ['← / →', 'Move selection left / right'],
                    ['Shift + Click', 'Range select'],
                    ['Ctrl + Click', 'Multi-select'],
                    ['Space', 'Toggle item selection'],
                ],
            },
            {
                title: 'Actions',
                items: [
                    ['Enter', 'Open selected item'],
                    ['Del / Backspace', inTrashView() ? 'Delete forever' : 'Move to trash'],
                    ['s', 'Toggle star'],
                    ['.', 'Share selected'],
                    ['d', 'Download selected'],
                    ['Ctrl + Z', 'Undo last action'],
                    ['Ctrl + C', 'Copy selected'],
                    ['Ctrl + X', 'Cut selected'],
                    ['Ctrl + V', 'Paste'],
                    ['F2', 'Rename selected'],
                    ['m', 'Move to…'],
                ],
            },
            {
                title: 'Views',
                items: [
                    ['1', 'List view'],
                    ['2', 'Grid view'],
                    ['i', 'Toggle details panel'],
                    ['p', 'Preview selected'],
                    ['Ctrl + Shift + L', 'Toggle sidebar'],
                ],
            },
            {
                title: 'File Editing',
                items: [
                    ['Ctrl + S', 'Save file'],
                    ['Ctrl + Z', 'Undo edit'],
                    ['Ctrl + Shift + Z', 'Redo edit'],
                    ['Ctrl + B', 'Bold text'],
                    ['Ctrl + I', 'Italic text'],
                    ['Ctrl + U', 'Underline text'],
                    ['Ctrl + K', 'Insert link'],
                ],
            },
            {
                title: 'System',
                items: [
                    ['Shift + ?', 'Show keyboard shortcuts'],
                    ['Ctrl + F', 'Find in page'],
                    ['Alt + N', 'Notifications'],
                    ['Ctrl + ,', 'Settings'],
                    ['Ctrl + Shift + H', 'Activity log'],
                    ['F11', 'Toggle fullscreen'],
                ],
            },
        ];

        const container = document.getElementById('shortcuts-content');
        container.innerHTML = data.map((g) => `
            <div class="shortcut-group">
                <h4>${g.title}</h4>
                ${g.items.map((it) => `<div class="shortcut-item"><span>${it[1]}</span><span class="shortcut-key">${it[0]}</span></div>`).join('')}
            </div>
        `).join('');

        document.getElementById('shortcuts-modal-overlay').classList.remove('hidden');
    }

    let _gKeyPending = false;
    let _gKeyTimer = null;

    function handleShortcut(e) {
        const target = e.target;
        const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

        if (typing && e.key !== 'Escape') return;

        // --- "g then X" navigation sequences ---
        if (_gKeyPending) {
            _gKeyPending = false;
            clearTimeout(_gKeyTimer);
            const k = e.key.toLowerCase();
            e.preventDefault();
            if (k === 'h') { window.location.hash = '#/home'; return; }
            if (k === 'd') { window.location.hash = '#/files'; return; }
            if (k === 'r') { window.location.hash = '#/recent'; return; }
            if (k === 't') { window.location.hash = '#/trash'; return; }
            if (k === 's') { window.location.hash = '#/storage'; return; }
            return;
        }

        if (e.key.toLowerCase() === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            _gKeyPending = true;
            _gKeyTimer = setTimeout(() => { _gKeyPending = false; }, 800);
            return;
        }

        // --- Views ---
        if (e.key === '1') {
            e.preventDefault();
            setView('list');
        }
        if (e.key === '2') {
            e.preventDefault();
            setView('grid');
        }

        // --- Search ---
        if (e.key === '/') {
            e.preventDefault();
            document.getElementById('search-input')?.focus();
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            document.getElementById('search-input')?.focus();
        }

        // --- New folder ---
        if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            createFolder();
        }

        // --- Upload ---
        if (e.key.toLowerCase() === 'u' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            document.getElementById('file-input')?.click();
        }

        // --- Select all ---
        if (e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            selectAllVisible();
            return;
        }
        if (e.key.toLowerCase() === 'a' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            selectAllVisible();
        }

        // --- Delete / Backspace ---
        if (e.key === 'Delete' && selectedItems.size) {
            e.preventDefault();
            bulkDelete();
        }
        if (e.key === 'Backspace' && !selectedItems.size) {
            // Go up one folder
            e.preventDefault();
            if (currentFolderId) {
                // Try to go to parent — reload files root
                window.location.hash = '#/files';
            }
        }

        // --- Star ---
        if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey && selectedItems.size) {
            e.preventDefault();
            const id = Array.from(selectedItems)[0];
            const payload = findSelectedPayload(id);
            if (payload) toggleStar(payload.type, payload.data);
        }

        // --- Share ---
        if (e.key === '.' && selectedItems.size) {
            e.preventDefault();
            bulkShare();
        }

        // --- Download ---
        if (e.key.toLowerCase() === 'd' && !e.ctrlKey && !e.metaKey && selectedItems.size) {
            e.preventDefault();
            downloadSelected();
        }

        // --- Move ---
        if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey && selectedItems.size) {
            e.preventDefault();
            bulkMove();
        }

        // --- Rename (F2) ---
        if (e.key === 'F2' && selectedItems.size) {
            e.preventDefault();
            renameSelected();
        }

        // --- Enter — open selected ---
        if (e.key === 'Enter' && selectedPrimary) {
            e.preventDefault();
            if (selectedPrimary.type === 'folder') {
                loadFolder(selectedPrimary.data.id);
            } else {
                // Trigger details panel or file open
                openDetailsPanel(selectedPrimary);
            }
        }

        // --- Toggle details panel (i) ---
        if (e.key.toLowerCase() === 'i' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            const panel = document.getElementById('details-panel');
            if (panel && !panel.classList.contains('hidden')) {
                hideDetailsPanel();
            } else if (selectedPrimary) {
                openDetailsPanel(selectedPrimary);
            }
        }

        // --- Preview (p) ---
        if (e.key.toLowerCase() === 'p' && !e.ctrlKey && !e.metaKey && selectedPrimary) {
            e.preventDefault();
            openDetailsPanel(selectedPrimary);
        }

        // --- Notifications (Alt+N) ---
        if (e.key.toLowerCase() === 'n' && e.altKey) {
            e.preventDefault();
            toggleNotificationsPanel();
        }

        // --- Shift+? — show shortcuts ---
        if (e.key === '?' && e.shiftKey) {
            e.preventDefault();
            showShortcuts();
        }

        // --- Escape ---
        if (e.key === 'Escape') {
            clearSelection();
            hideDetailsPanel();
            document.getElementById('shortcuts-modal-overlay')?.classList.add('hidden');
            document.getElementById('notifications-panel')?.classList.add('hidden');
            document.getElementById('share-modal-overlay')?.classList.add('hidden');
        }
    }

    function selectAllVisible() {
        const items = getVisibleItemPayloads();

        selectedItems.clear();
        items.forEach((x) => selectedItems.add(x.id));
        if (items[0]) {
            selectedPrimary = items[0];
            selectionAnchor = items[0].id;
        }
        syncSelectionStyles();
    }

    function setView(view) {
        currentView = view;
        localStorage.setItem('fd_view', view);

        document.getElementById('view-grid')?.classList.toggle('active', view === 'grid');
        document.getElementById('view-list')?.classList.toggle('active', view === 'list');
        document.getElementById('topbar-view-grid')?.classList.toggle('active', view === 'grid');
        document.getElementById('topbar-view-list')?.classList.toggle('active', view === 'list');

        const header = document.getElementById('file-list-header');
        const grid = document.getElementById('file-grid');

        if (currentPage === 'home') {
            header?.classList.add('hidden');
            renderHomeItems(filteredFiles, homeSuggestedFolders);
            return;
        }

        if (view === 'grid') {
            grid.classList.add('grid-view');
            header.classList.add('hidden');
        } else {
            grid.classList.remove('grid-view');
            if (currentPage !== 'activity' && currentPage !== 'storage' && currentPage !== 'admin') {
                header.classList.remove('hidden');
            }
        }

        renderItems(filteredFolders, filteredFiles, { keepSelection: true, isTrash: currentPage === 'trash' });
    }

    function showLoading(show) {
        const loading = document.getElementById('loading-state');
        const grid = document.getElementById('file-grid');
        const empty = document.getElementById('empty-state');

        loading.classList.toggle('hidden', !show);
        if (show) {
            grid.classList.add('hidden');
            empty.classList.add('hidden');
        }
    }

    function storageQuotaPercentRaw(usedBytes, totalBytes) {
        const used = Math.max(0, Number(usedBytes) || 0);
        const total = Math.max(0, Number(totalBytes) || 0);
        if (used <= 0 || total <= 0) return 0;
        return Math.min(100, (used / total) * 100);
    }

    function formatStoragePercentRounded(usedBytes, totalBytes) {
        return String(Math.round(storageQuotaPercentRaw(usedBytes, totalBytes)));
    }

    function formatStorageSize(bytes) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        let value = Math.max(0, Number(bytes) || 0);
        let i = 0;
        while (value >= 1024 && i < units.length - 1) {
            value /= 1024;
            i++;
        }
        let str;
        if (i === 0 || value >= 100) {
            str = String(Math.round(value));
        } else {
            str = String(Math.round(value * 10) / 10);
        }
        return `${str} ${units[i]}`;
    }

    async function updateStorageInfo() {
        try {
            const s = await API.myStorage();
            const rawUsed = Number(s.used_bytes || 0);
            const rawTotal = Number(s.total_bytes || 1);

            const rawPct = storageQuotaPercentRaw(rawUsed, rawTotal);
            const pct = Math.round(rawPct);
            const widthPct = rawPct;

            const barFill = document.getElementById('storage-bar-fill');
            barFill.style.width = `${widthPct}%`;
            barFill.style.background = rawPct >= 90 ? '#d93025' : '#1a73e8';
            document.getElementById('storage-text').textContent =
                `${formatStorageSize(rawUsed)} of ${formatStorageSize(rawTotal)} used`;

            if (rawPct >= 80) {
                const key = 'fd_storage_notice_last';
                const last = Number(localStorage.getItem(key) || 0);
                const now = Date.now();
                if (!last || (now - last) > (60 * 60 * 1000)) {
                    createNotification(`Storage is ${Math.round(pct)}% full`, new Date().toISOString(), false, 'System');
                    localStorage.setItem(key, String(now));
                }
            }
        } catch {
            document.getElementById('storage-text').textContent = 'Storage unavailable';
        }
    }

    function refresh() {
        folderStatsCache.clear();
        folderStatsPending.clear();
        const h = window.location.hash;
        if (h === '#/admin' || h.startsWith('#/admin/')) {
            const section = h.split('/')[2] || 'dashboard';
            return AdminPanel.load(section);
        }
        if (h === '#/home') return loadHome();
        if (h === '#/computers' || h.startsWith('#/computers/')) {
            const folderId = h.startsWith('#/computers/') ? h.split('/')[2] : null;
            return loadComputerFolder(folderId);
        }
        if (h === '#/recent') return loadRecent();
        if (h === '#/starred') return loadStarred();
        if (h === '#/shared-with') return loadSharedWithMe();
        if (h === '#/shared-by') {
            window.location.replace('#/files');
            return loadFolder(null);
        }
        if (h === '#/offline') return loadOffline();
        if (h === '#/trash') return loadTrash();
        if (h === '#/activity') return loadActivity();
        if (h === '#/storage') return loadStoragePage();
        return loadFolder(currentFolderId);
    }

    function hasSelection() {
        return selectedItems.size > 0;
    }

    function shareSelectedItem() {
        if (!selectedPrimary || selectedItems.size !== 1) {
            Components.toast('Select one item to share', 'warning');
            return;
        }
        openShareModal(selectedPrimary);
    }

    async function downloadSelected() {
        if (!selectedPrimary) return;
        if (selectedPrimary.type === 'file') {
            await downloadFile(selectedPrimary.data);
        } else {
            Components.toast('Folders cannot be downloaded directly', 'info');
        }
    }

    async function renameSelected() {
        if (!selectedPrimary) return;
        const newName = await Components.prompt('Rename', selectedPrimary.data.name, 'New name');
        if (!newName || newName === selectedPrimary.data.name) return;
        try {
            await renameItem(selectedPrimary, newName);
            Components.toast('Renamed', 'success');
            refresh();
        } catch (err) {
            Components.toast(err.message, 'error');
        }
    }

    function deleteSelected() {
        bulkDelete();
    }

    function afterUpload(result, file) {
        addFileActivity(result.id, 'uploaded', result.name);
        createNotification('File uploaded successfully', new Date().toISOString(), false, currentUserLabel());
    }

    return {
        init,
        getCurrentFolder: () => currentFolderId,
        setView,
        refresh,
        createFolder,
        createQuickFile,
        loadFolder,
        loadComputers,
        loadComputerFolder,
        loadHome,
        loadRecent,
        loadStarred,
        loadSharedWithMe,
        loadOffline,
        loadTrash,
        emptyBin,
        loadActivity,
        loadStoragePage,
        loadAdminPanel,
        applyAdvancedSearch,
        hideSearchDropdown,
        resetAdvancedSearchForm,
        syncAdvancedSearchDependentFields,
        showAdvancedSearchHelp,
        collectAdvancedSearchParams,
        bulkShare,
        bulkDownload,
        bulkMove,
        bulkDelete,
        bulkRestore,
        showLargestFiles,
        hideDetailsPanel,
        shareSelectedItem,
        downloadSelected,
        renameSelected,
        deleteSelected,
        closeShareModal,
        saveShareModal,
        copyCurrentShareLink,
        toggleNotificationsPanel,
        markAllNotificationsRead,
        showShortcuts,
        handleShortcut,
        hasSelection,
        canAcceptUploads,
        afterUpload,
        updateStorageInfo,
        openFileById,
    };
})();
