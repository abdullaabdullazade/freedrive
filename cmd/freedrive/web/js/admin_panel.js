const AdminPanel = (() => {
    const UI_PREFS_KEY = 'fd_admin_ui_prefs_v1';
    const ALLOWED_TYPES_VERSION = 1;

    const DEFAULT_SETTINGS = {
        general: {
            site_name: 'FreeDrive',
            site_url: window.location.origin,
            language: 'en',
            default_quota_gb: 10,
            registration: 'invite',
            max_upload_mb: 512,
            allowed_types_unlimited: false,
            allowed_types: [
                // Obrazy
                'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'tif', 'ico', 'heic', 'heif', 'avif', 'raw',
                // Dokumenty
                'pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'tex', 'epub', 'mobi', 'pages',
                // Arkusze
                'xls', 'xlsx', 'ods', 'csv', 'tsv', 'numbers',
                // Prezentacje
                'ppt', 'pptx', 'odp', 'key',
                // Archiwa
                'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'iso',
                // Audio
                'mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus', 'aiff',
                // Wideo
                'mp4', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp',
                // Kod / dane
                'html', 'css', 'js', 'ts', 'jsx', 'tsx', 'json', 'xml', 'yaml', 'yml',
                'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rb', 'php', 'sh', 'sql', 'rs', 'swift', 'kt',
                // Design
                'psd', 'ai', 'eps', 'xd', 'fig', 'sketch',
                // Fonty
                'ttf', 'otf', 'woff', 'woff2',
                // Instalatory / binaria
                'apk', 'exe', 'dmg', 'deb', 'rpm', 'msi', 'bin',
            ],
        },
        email: {
            smtp_server: '',
            smtp_port: 587,
            smtp_user: '',
            smtp_pass: '',
            from_address: '',
            from_name: 'FreeDrive',
            tls: true,
        },
        storage: {
            data_directory: '/var/lib/freedrive/data',
            total_capacity_gb: 444.6,
            trash_auto_empty: '30',
            versioning: true,
            keep_versions: 20,
        },
        backup: {
            auto_backup: true,
            schedule: 'daily',
            time: '03:00',
            location: '/var/lib/freedrive/backups',
            history: [],
        },
        appearance: {
            theme: 'light',
            accent: '#7C5CFC',
            login_title: 'Sign in',
            login_subtitle: 'to continue to FreeDrive',
        },
        security: {
            require_2fa: false,
            last_key_rotation: new Date(Date.now() - 1000 * 60 * 60 * 24 * 12).toISOString(),
            allowlist: [],
            blocklist: [],
        },
    };

    const state = {
        section: 'dashboard',
        stats: {},
        users: [],
        files: [],
        activities: [],
        disk: {},
        userMeta: {},
        userSelection: new Set(),
        usersSearch: '',
        usersFilter: 'all',
        usersPage: 1,
        usersPerPage: 25,
        usersMenuOpen: '',
        drawerUserId: '',
        drawerBreakdown: null,
        storageBreakdown: null,
        storageUserPage: 1,
        storageUserPerPage: 25,
        activityFilters: {
            users: [],
            action: 'all',
            from: '',
            to: '',
        },
        activityPage: 1,
        activityPerPage: 25,
        expandedActivity: new Set(),
        activityLive: false,
        liveTimer: null,
        listTab: 'allowlist',
        settingsTab: 'general',
        settings: clone(DEFAULT_SETTINGS),
        settingsDraft: clone(DEFAULT_SETTINGS),
        settingsDirty: false,
        settingsErrors: {},
        settingsSavedUntil: 0,
        invites: [],
        backups: [],
        initialized: false,
        loading: false,
    };

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function esc(value) {
        return Components.escapeHtml(value || '');
    }

    function formatPurgeTrashResult(res, prefix = 'Purged') {
        const files = res?.removed_files || 0;
        const folders = res?.removed_folders || 0;
        return `${prefix} ${files} file(s) and ${folders} folder(s)`;
    }

    function initials(name) {
        return Components.initials(name || 'U');
    }

    function nowISO() {
        return new Date().toISOString();
    }

    function asNumber(value, fallback = 0) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    const QUOTA_OPTIONS_GB = [15, 256, 512, 1024, 2048, 5120];

    function quotaLabel(gb) {
        return gb >= 1024 ? `${gb / 1024} TB` : `${gb} GB`;
    }

    function quotaOptionsHtml(currentGb) {
        const sel = QUOTA_OPTIONS_GB.includes(Number(currentGb)) ? Number(currentGb) : 15;
        return QUOTA_OPTIONS_GB
            .map((gb) => `<option value="${gb}" ${gb === sel ? 'selected' : ''}>${quotaLabel(gb)}</option>`)
            .join('');
    }

    const MAX_UPLOAD_OPTIONS_MB = [
        { mb: 512 * 1024, label: '512 GB' },
        { mb: 1024 * 1024, label: '1 TB' },
        { mb: 4 * 1024 * 1024, label: '4 TB' },
        { mb: 7 * 1024 * 1024, label: '7 TB' },
        { mb: 10 * 1024 * 1024, label: '10 TB' },
    ];

    function maxUploadOptionsHtml(currentMb) {
        const values = MAX_UPLOAD_OPTIONS_MB.map((o) => o.mb);
        const sel = values.includes(Number(currentMb)) ? Number(currentMb) : values[0];
        return MAX_UPLOAD_OPTIONS_MB
            .map((o) => `<option value="${o.mb}" ${o.mb === sel ? 'selected' : ''}>${o.label}</option>`)
            .join('');
    }

    function promptQuota(title, currentGb) {
        return new Promise((resolve) => {
            Components.showModal(
                title,
                `<div class="gd-input-group"><label>Storage quota</label><select id="quota-select" class="gd-input">${quotaOptionsHtml(currentGb)}</select></div>`,
                [
                    { text: 'Cancel', action: () => resolve(null) },
                    { text: 'OK', class: 'btn-primary', action: () => resolve(asNumber(document.getElementById('quota-select')?.value, null)) },
                ]
            );
        });
    }

    function getCurrentUser() {
        return API.getUser() || { id: '', username: 'Admin', email: '', role: 'user' };
    }

    function roleLabel(role) {
        const r = String(role || 'user').toLowerCase();
        if (r === 'admin') return 'Admin';
        if (r === 'guest') return 'Guest';
        return 'User';
    }

    function roleClass(role) {
        const r = String(role || 'user').toLowerCase();
        if (r === 'admin') return 'role-admin';
        if (r === 'guest') return 'role-guest';
        return 'role-user';
    }

    function statusClass(status) {
        const s = String(status || 'active').toLowerCase();
        if (s === 'suspended') return 'status-suspended';
        if (s === 'invited') return 'status-invited';
        return 'status-active';
    }

    function formatPct(value, total) {
        const t = asNumber(total, 0);
        if (!t) return '0%';
        return `${Math.max(0, Math.min(100, (value / t) * 100)).toFixed(1)}%`;
    }

    function clampPage(total, page, perPage) {
        const pages = Math.max(1, Math.ceil(total / perPage));
        return Math.min(pages, Math.max(1, page));
    }

    function paginate(items, page, perPage) {
        const total = items.length;
        const safePage = clampPage(total, page, perPage);
        const start = (safePage - 1) * perPage;
        const end = Math.min(total, start + perPage);
        return {
            rows: items.slice(start, end),
            total,
            page: safePage,
            perPage,
            start,
            end,
            pages: Math.max(1, Math.ceil(total / perPage)),
        };
    }

    function renderPaginator(prefix, meta) {
        const pageButtons = [];
        const pages = meta.pages;
        const current = meta.page;
        const addPage = (n) => pageButtons.push(`<button class="admin-page-btn ${n === current ? 'active' : ''}" data-admin-action="${prefix}-goto-page" data-page="${n}">${n}</button>`);
        if (pages <= 7) {
            for (let i = 1; i <= pages; i += 1) addPage(i);
        } else {
            addPage(1);
            if (current > 3) pageButtons.push('<span class="admin-page-ellipsis">...</span>');
            for (let i = Math.max(2, current - 1); i <= Math.min(pages - 1, current + 1); i += 1) addPage(i);
            if (current < pages - 2) pageButtons.push('<span class="admin-page-ellipsis">...</span>');
            addPage(pages);
        }

        return `
            <div class="admin-table-pager">
                <div class="admin-table-count">Showing ${meta.total ? meta.start + 1 : 0}–${meta.end} of ${meta.total} results</div>
                <div class="admin-table-controls">
                    <button class="admin-page-nav" data-admin-action="${prefix}-prev" ${meta.page <= 1 ? 'disabled' : ''}>‹</button>
                    ${pageButtons.join('')}
                    <button class="admin-page-nav" data-admin-action="${prefix}-next" ${meta.page >= meta.pages ? 'disabled' : ''}>›</button>
                    <select data-admin-action="${prefix}-per-page">
                        ${[25, 50, 100].map((n) => `<option value="${n}" ${meta.perPage === n ? 'selected' : ''}>${n} / page</option>`).join('')}
                    </select>
                </div>
            </div>
        `;
    }

    function saveLocalUiState() {
        const prefs = {
            activityFilters: state.activityFilters,
            usersFilter: state.usersFilter,
            usersPerPage: state.usersPerPage,
            activityPerPage: state.activityPerPage,
        };
        localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
    }

    function loadLocalUiState() {
        try {
            const raw = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}');
            if (raw.activityFilters && typeof raw.activityFilters === 'object') {
                state.activityFilters = { ...state.activityFilters, ...raw.activityFilters };
                const allowed = new Set(['all', 'login', 'failed_login']);
                if (!allowed.has(String(state.activityFilters.action || ''))) {
                    state.activityFilters.action = 'all';
                }
            }
            if (raw.usersFilter) state.usersFilter = raw.usersFilter;
            if (raw.usersPerPage) state.usersPerPage = asNumber(raw.usersPerPage, state.usersPerPage);
            if (raw.activityPerPage) state.activityPerPage = asNumber(raw.activityPerPage, state.activityPerPage);
        } catch {
            // ignore corrupt UI prefs
        }
    }

    async function fetchServerSettings() {
        const res = await fetch('/api/v1/admin/settings', {
            headers: { Authorization: `Bearer ${localStorage.getItem('fd_access_token') || ''}` },
        });
        if (!res.ok) return null;
        const data = await res.json().catch(() => null);
        if (!data || typeof data !== 'object' || Object.keys(data).length === 0) return null;
        return data;
    }

    function applyServerSettings(data) {
        state.settings = deepMerge(clone(DEFAULT_SETTINGS), data);
        state.settingsDraft = clone(state.settings);
        state.settingsDirty = false;
    }

    async function saveSettingsToServer(settings = state.settings) {
        const res = await fetch('/api/v1/admin/settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${localStorage.getItem('fd_access_token') || ''}`,
            },
            body: JSON.stringify(settings),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `Settings save failed (${res.status})`);
        }
    }

    async function persistSettingsNow({ silent = false } = {}) {
        state.settings = clone(state.settingsDraft);
        state.settingsDirty = false;
        await saveSettingsToServer(state.settings);
        state.settingsSavedUntil = Date.now() + 3000;
        if (!silent) {
            Components.toast('Settings saved', 'success', { duration: 3000 });
        }
    }

    function migrateAllowedTypes() {
        if (!state.settings.general) state.settings.general = {};
        const gen = state.settings.general;
        if (gen.allowed_types_version === ALLOWED_TYPES_VERSION) return false;
        gen.allowed_types = clone(DEFAULT_SETTINGS.general.allowed_types);
        gen.allowed_types_version = ALLOWED_TYPES_VERSION;
        state.settingsDraft = clone(state.settings);
        return true;
    }

    async function loadServerSettings() {
        const data = await fetchServerSettings().catch(() => null);
        if (data) {
            applyServerSettings(data);
        } else {
            state.settings = clone(DEFAULT_SETTINGS);
            state.settingsDraft = clone(DEFAULT_SETTINGS);
            state.settingsDirty = false;
        }
        if (migrateAllowedTypes()) {
            state.settingsDraft = clone(state.settings);
            await saveSettingsToServer(state.settings);
        }
    }

    function deepMerge(target, source) {
        const out = { ...target };
        Object.keys(source || {}).forEach((k) => {
            if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
                out[k] = deepMerge(target[k] || {}, source[k]);
            } else {
                out[k] = source[k];
            }
        });
        return out;
    }

    function normalizeSection(section) {
        const s = String(section || 'dashboard').toLowerCase();
        if (['dashboard', 'users', 'storage', 'activity', 'security', 'settings'].includes(s)) return s;
        return 'dashboard';
    }

    function renderNoData(message = 'No data available') {
        return `<div class="admin-no-data"><span class="admin-no-data-icon">ℹ</span><span>${esc(message)}</span></div>`;
    }

    function renderSkeletonRows(columns = 5, rows = 5) {
        return Array.from({ length: rows }).map(() => `
            <tr class="admin-skeleton-row">
                ${Array.from({ length: columns }).map(() => '<td><span class="admin-skeleton-line"></span></td>').join('')}
            </tr>
        `).join('');
    }

    function actionBadgeClass(action) {
        const a = String(action || '').toLowerCase().replace(/\s+/g, '_');
        if (a === 'upload' || a === 'uploaded') return 'action-upload';
        if (a === 'delete' || a === 'deleted') return 'action-delete';
        if (a === 'share' || a === 'shared') return 'action-share';
        if (a === 'download' || a === 'downloaded') return 'action-downloaded';
        if (a === 'login') return 'action-login';
        if (a === 'failed_login' || a === 'failed login') return 'action-failed-login';
        if (a === 'rename' || a === 'renamed' || a === 'move' || a === 'moved') return 'action-share';
        return 'action-login';
    }

    function renderSectionSkeleton(section) {
        if (section === 'storage' || section === 'users' || section === 'security' || section === 'activity') {
            return `
                <section class="admin-card table-card">
                    <div class="admin-table-wrap">
                        <table class="admin-table">
                            <tbody>${renderSkeletonRows(7, 6)}</tbody>
                        </table>
                    </div>
                </section>
            `;
        }
        return `
            <section class="admin-card">
                <div class="admin-skeleton-block"></div>
                <div class="admin-skeleton-block"></div>
                <div class="admin-skeleton-block"></div>
            </section>
        `;
    }

    function ensureUserMeta() {
        state.users.forEach((u) => {
            const userFiles = state.files.filter((f) => String(f.owner_id || f.user_id || '') === String(u.id));
            if (!state.userMeta[u.id]) {
                state.userMeta[u.id] = {
                    status: u.suspended ? 'suspended' : 'active',
                    last_active: u.last_login_at || u.updated_at || u.created_at || nowISO(),
                    twofa: Boolean(u.email_2fa_enabled) || Boolean(u.totp_enabled),
                    files_count: userFiles.length,
                    bandwidth_month: asNumber(state.userMeta[u.id]?.bandwidth_month, 0),
                };
            } else {
                state.userMeta[u.id].last_active = state.userMeta[u.id].last_active || u.last_login_at || u.updated_at || u.created_at || nowISO();
                state.userMeta[u.id].files_count = userFiles.length;
                state.userMeta[u.id].bandwidth_month = asNumber(state.userMeta[u.id].bandwidth_month, 0);
                state.userMeta[u.id].twofa = Boolean(u.email_2fa_enabled) || Boolean(u.totp_enabled);
            }
        });
    }

    async function hydrateData() {
        const [statsRes, usersRes, diskRes, activityRes, filesRes, invitesRes, backupsRes, breakdownRes] = await Promise.all([
            API.admin.stats().catch(() => ({})),
            API.admin.users().catch(() => ({ users: [] })),
            API.diskStats().catch(() => ({})),
            API.admin.activity(1, 300).catch(() => ({ activities: [] })),
            API.files.list({ page_size: '800' }).catch(() => ({ files: [] })),
            API.admin.invites().catch(() => ({ invites: [] })),
            API.admin.listBackups().catch(() => ({ backups: [] })),
            API.admin.storageBreakdown().catch(() => ({ breakdown: null })),
        ]);

        state.stats = statsRes.stats || statsRes || {};
        state.users = Array.isArray(usersRes.users) ? usersRes.users : [];
        state.disk = diskRes || {};
        state.activities = Array.isArray(activityRes.activities) ? activityRes.activities : [];
        state.files = Array.isArray(filesRes.files) ? filesRes.files : [];
        state.invites = (Array.isArray(invitesRes.invites) ? invitesRes.invites : []).map(mapInviteRecord);
        state.backups = Array.isArray(backupsRes.backups) ? backupsRes.backups : [];
        state.storageBreakdown = breakdownRes?.breakdown || null;

        ensureUserMeta();
        saveLocalUiState();
    }

    function mapInviteRecord(inv) {
        const maxUses = Number(inv?.max_uses || 1);
        const used = Number(inv?.used_count || 0);
        const quotaBytes = Number(inv?.quota_bytes || 0);
        return {
            id: inv?.id || '',
            email: inv?.email || '',
            role: inv?.role || 'user',
            quota: Math.max(1, Math.round(quotaBytes / 1073741824) || 10),
            message: '',
            code: inv?.code || '',
            status: maxUses > 0 && used >= maxUses ? 'used' : 'pending',
            created_at: inv?.created_at || nowISO(),
        };
    }


    const AdminFileIcons = {
        folder: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#5f6368"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
        image: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#34a853"><path d="M21 19V5c0-1.1-.9-2-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2zM8.5 11.5A1.5 1.5 0 1 1 8.5 8a1.5 1.5 0 0 1 0 3.5zM5 18l3.5-4.5 2.5 3 3.5-4.5 4.5 6H5z"/></svg>',
        video: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#ea4335"><path d="M17 10.5V7c0-1.1-.9-2-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10c1.1 0 2-.9 2-2v-3.5l4 4v-11l-4 4z"/></svg>',
        audio: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#a142f4"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55a4 4 0 1 0 4 4V7h4V3h-6z"/></svg>',
        pdf: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#ea4335"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 3.5V9h5.5" fill="#fff"/><path d="M8 17h1v-1h1.2a1.8 1.8 0 1 0 0-3.6H8V17zm1-2v-1.6h1.1a.8.8 0 1 1 0 1.6H9zm3 2h2.2a1.9 1.9 0 0 0 0-3.8H12V17zm1-1v-1.8h1.1a.9.9 0 1 1 0 1.8H13zm4 1h1v-1.5h1.4v-1H18v-.6h1.7v-1H17V17z" fill="#fff"/></svg>',
        sheet: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#34a853"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 3.5V9h5.5" fill="#fff"/><path d="M8 11h8v2H8zm0 3h8v2H8zm0 3h5v2H8z" fill="#fff"/></svg>',
        text: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#4285f4"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 3.5V9h5.5" fill="#fff"/><path d="M8 12h8v1.6H8zm0 3h8v1.6H8zm0 3h5v1.6H8z" fill="#fff"/></svg>',
        document: '<svg viewBox="0 0 24 24" width="20" height="20" fill="#5f6368"><path d="M14 2H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 3.5V9h5.5" fill="#fff"/><path d="M8 12h8v1.6H8zm0 3h8v1.6H8zm0 3h5v1.6H8z" fill="#fff"/></svg>'
    };

    function adminGetFileIcon(mime, name) {
        mime = String(mime || '').toLowerCase();
        name = String(name || '').toLowerCase();
        if (mime.includes('folder')) return AdminFileIcons.folder;
        if (mime.includes('image/')) return AdminFileIcons.image;
        if (mime.includes('video/')) return AdminFileIcons.video;
        if (mime.includes('audio/')) return AdminFileIcons.audio;
        if (mime.includes('pdf')) return AdminFileIcons.pdf;
        if (mime.includes('sheet') || mime.includes('csv') || name.endsWith('.xlsx')) return AdminFileIcons.sheet;
        if (mime.includes('text') || mime.includes('markdown') || name.endsWith('.txt')) return AdminFileIcons.text;
        return AdminFileIcons.document;
    }

    function emptyFileTypeBuckets() {
        return {
            Images: { size: 0, count: 0, color: '#1967D2' },
            Videos: { size: 0, count: 0, color: '#188038' },
            Documents: { size: 0, count: 0, color: '#E37400' },
            Audio: { size: 0, count: 0, color: '#F59E0B' },
            Archives: { size: 0, count: 0, color: '#E53935' },
            Other: { size: 0, count: 0, color: '#5F6368' },
        };
    }

    function bucketsFromApiBreakdown(breakdown) {
        const buckets = emptyFileTypeBuckets();
        if (!breakdown || typeof breakdown !== 'object') return buckets;
        const map = {
            images: 'Images',
            videos: 'Videos',
            documents: 'Documents',
            audio: 'Audio',
            archives: 'Archives',
            other: 'Other',
        };
        Object.entries(map).forEach(([apiKey, label]) => {
            const item = breakdown[apiKey];
            if (!item) return;
            buckets[label].size = asNumber(item.size, 0);
            buckets[label].count = asNumber(item.count, 0);
        });
        return buckets;
    }

    function estimateFileTypeBuckets(sourceBreakdown) {
        if (sourceBreakdown) {
            return bucketsFromApiBreakdown(sourceBreakdown);
        }
        if (state.storageBreakdown) {
            return bucketsFromApiBreakdown(state.storageBreakdown);
        }
        return emptyFileTypeBuckets();
    }

    function generateStorageTrend() {
        const now = Date.now();
        const result = [];
        for (let i = 29; i >= 0; i -= 1) {
            const t = new Date(now - i * 24 * 60 * 60 * 1000);
            const dayStart = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
            const cumulativeBytes = state.files
                .filter((f) => new Date(f.created_at || f.updated_at || 0).getTime() <= dayStart + (24 * 60 * 60 * 1000) - 1)
                .reduce((sum, f) => sum + asNumber(f.size, 0), 0);
            const gb = cumulativeBytes / (1024 ** 3);
            result.push({
                date: t,
                label: t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                value: Number(gb.toFixed(1)),
            });
        }
        return result;
    }

    function renderDashboardSection() {
        const users = state.users || [];
        const filesToUse = state.files || [];
        const totalUsers = users.length;
        const totalFiles = filesToUse.length;
        
        const totalUsed = asNumber(state.disk?.used_bytes || state.stats?.total_used, 0);
        const totalCapacity = asNumber(state.disk?.total_bytes || state.stats?.total_quota, 0);
        const storagePct = totalCapacity ? ((totalUsed / totalCapacity) * 100) : 0;
        
        const today = new Date().toDateString();
        const usersToday = users.filter((u) => new Date(u.created_at || 0).toDateString() === today).length;
        const filesToday = filesToUse.filter((f) => new Date(f.created_at || 0).toDateString() === today).length;

        const buckets = estimateFileTypeBuckets() || {};
        const breakdown = [
            { label: 'Images', ...(buckets.Images || {size:0, count:0, color:'#1967D2'}) },
            { label: 'Videos', ...(buckets.Videos || {size:0, count:0, color:'#188038'}) },
            { label: 'Documents', ...(buckets.Documents || {size:0, count:0, color:'#E37400'}) },
            { label: 'Other', ...(buckets.Other || {size:0, count:0, color:'#5F6368'}) },
        ];
        const pieTotal = breakdown.reduce((sum, b) => sum + b.size, 0) || 1;
        const nonZeroBreakdown = breakdown.filter((b) => b.size > 0);

        let lineData = [];
        try { lineData = generateStorageTrend() || []; } catch(e) {}
        if(lineData.length === 0) lineData = [{value:0, label:'', x:0, y:0}];
        
        const lineMin = Math.min(...lineData.map((p) => p.value));
        const lineMax = Math.max(...lineData.map((p) => p.value));
        const chartW = 760;
        const chartH = 250;
        const padX = 32;
        const padY = 20;
        const usableW = chartW - (padX * 2);
        const usableH = chartH - (padY * 2);
        
        const linePoints = lineData.map((p, idx) => {
            const x = padX + ((idx / Math.max(1, lineData.length - 1)) * usableW);
            const y = chartH - padY - (((p.value - lineMin) / Math.max(1, (lineMax - lineMin))) * usableH);
            return { ...p, x, y };
        });
        const linePath = linePoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${(p.x||0).toFixed(2)} ${(p.y||0).toFixed(2)}`).join(' ');

        let angle = 0;
        const donutStops = (nonZeroBreakdown.length ? nonZeroBreakdown : [{ label: 'Empty', size: 1, color: '#DADCE0' }]).map((b) => {
            const span = (b.size / pieTotal) * 360;
            const start = angle;
            angle += span;
            return `${b.color} ${start.toFixed(2)}deg ${angle.toFixed(2)}deg`;
        }).join(', ');

        const recent = (state.activities || []).filter((a) => isAuthActivity(a.action)).slice(0, 5);

        return `
            <div class="gd-storage-container">
                <div class="gd-storage-hero">
                    <p class="gd-storage-hero-subtitle">Summary of your FreeDrive workspace.</p>
                </div>

                <div class="gd-overview-grid">
                    <div class="gd-card gd-overview-card">
                        <div class="gd-metric-icon" style="color: #1967D2; background: #E8F0FE;">
                            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5s-3 1.34-3 3 1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.98 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
                        </div>
                        <div class="gd-metric-content">
                            <span class="gd-metric-label">Total Users</span>
                            <span class="gd-metric-value">${totalUsers}</span>
                            <span class="gd-metric-sub">+${usersToday} today</span>
                        </div>
                    </div>
                    <div class="gd-card gd-overview-card">
                        <div class="gd-metric-icon" style="color: #188038; background: #CEEAD6;">
                            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>
                        </div>
                        <div class="gd-metric-content">
                            <span class="gd-metric-label">Storage Used</span>
                            <span class="gd-metric-value">${Components.formatSize(totalUsed)}</span>
                            <div class="gd-mini-bar" style="margin-top:4px;"><div class="gd-mini-fill" style="width: ${Math.min(100, storagePct)}%; background:${storagePct > 80 ? '#D93025' : '#188038'};"></div></div>
                        </div>
                    </div>
                    <div class="gd-card gd-overview-card">
                        <div class="gd-metric-icon" style="color: #F8BC04; background: #FEF7E0;">
                            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"/></svg>
                        </div>
                        <div class="gd-metric-content">
                            <span class="gd-metric-label">Files</span>
                            <span class="gd-metric-value">${totalFiles.toLocaleString('en-US')}</span>
                            <span class="gd-metric-sub">+${filesToday} today</span>
                        </div>
                    </div>
                    <div class="gd-card gd-overview-card">
                        <div class="gd-metric-icon" style="color: #D93025; background: #FCE8E6;">
                            <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M13 2.05v2.02A8.001 8.001 0 0 1 20 12h2c0-5-3.66-9.15-8.45-9.95zM11 2.05C6.22 2.86 2.56 7 2.56 12S6.22 21.14 11 21.95v-2.02A8.001 8.001 0 0 1 4.56 12 8.001 8.001 0 0 1 11 4.07V2.05zM12 8v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
                        </div>
                        <div class="gd-metric-content">
                            <span class="gd-metric-label">Bandwidth</span>
                            <span class="gd-metric-value">—</span>
                            <span class="gd-metric-sub">Not tracked yet</span>
                        </div>
                    </div>
                </div>

                <div class="gd-cards-layout" style="margin-top: 24px; flex-direction: row; flex-wrap: wrap;">
                    <div class="gd-card" style="flex: 2; min-width: 400px;">
                        <div class="gd-card-header">
                            <div class="gd-card-title-area">
                                <h3>Storage usage over time</h3>
                            </div>
                        </div>
                        <div class="admin-chart-wrap" style="height: 250px; overflow: hidden; position: relative;">
                            <svg class="admin-line-chart" viewBox="0 0 ${chartW} ${chartH}" style="width: 100%; height: 100%;">
                                <path d="${linePath}" fill="none" stroke="#1A73E8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
                                <defs>
                                    <linearGradient id="chartFade" x1="0" x2="0" y1="0" y2="1">
                                        <stop offset="0%" stop-color="rgba(26,115,232,0.2)"/>
                                        <stop offset="100%" stop-color="rgba(26,115,232,0)"/>
                                    </linearGradient>
                                </defs>
                                ${linePoints.length > 0 ? `<path d="${linePath} L ${linePoints[linePoints.length-1].x} ${chartH-padY} L ${linePoints[0].x} ${chartH-padY} Z" fill="url(#chartFade)" opacity="0.5" />` : ''}
                                ${linePoints.map((p) => `<circle cx="${p.x || 0}" cy="${p.y || 0}" r="4" fill="#1A73E8" class="gd-chart-dot" data-val="${p.label}: ${p.value}GB"><title>${p.label}: ${p.value}GB</title></circle>`).join('')}
                            </svg>
                        </div>
                    </div>

                    <div class="gd-card" style="flex: 1; min-width: 300px;">
                        <div class="gd-card-header">
                            <div class="gd-card-title-area">
                                <h3>Recent Activity</h3>
                            </div>
                            <a href="#/admin/activity" class="gd-btn-outline" style="font-size:12px; padding: 4px 10px; text-decoration:none;">View all</a>
                        </div>
                        <div class="gd-recent-activity">
                            ${recent.map((a) => `
                                <div class="gd-activity-item">
                                    <span class="gd-avatar" style="width:32px; height:32px; font-size:12px; background-color: hsl(${((a.username || '').length * 137) % 360}, 60%, 50%)">${esc(initials(a.username || 'U'))}</span>
                                    <div class="gd-activity-info">
                                        <div class="gd-activity-text"><strong>${esc(a.username || 'User')}</strong> ${esc(String(a.action || 'did').toLowerCase())} <strong>${esc(a.target_name || 'item')}</strong></div>
                                        <span class="gd-activity-time">${Components.formatDate(a.created_at)}</span>
                                    </div>
                                </div>
                            `).join('') || '<div class="gd-empty-table">No recent activity</div>'}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    function getUserStatus(user) {
        if (user && typeof user === 'object') {
            return user.suspended ? 'suspended' : 'active';
        }
        const found = state.users.find((u) => u.id === user);
        return found?.suspended ? 'suspended' : 'active';
    }

    function renderUsersSection() {
        const lowerSearch = state.usersSearch.trim().toLowerCase();
        let list = state.users.filter((u) => {
            const status = getUserStatus(u);
            const matchSearch = !lowerSearch
                || String(u.username || '').toLowerCase().includes(lowerSearch)
                || String(u.email || '').toLowerCase().includes(lowerSearch);
            if (!matchSearch) return false;
            if (state.usersFilter === 'all') return true;
            if (state.usersFilter === 'admin') return String(u.role || '').toLowerCase() === 'admin';
            if (state.usersFilter === 'suspended') return status === 'suspended';
            if (state.usersFilter === 'active') return status === 'active';
            return true;
        });

        list.sort((a, b) => String(a.username || a.email).localeCompare(String(b.username || b.email)));

        const pageMeta = paginate(list, state.usersPage, state.usersPerPage);
        state.usersPage = pageMeta.page;

        const selectedCount = state.userSelection.size;

        return `
            <div class="gd-storage-container" style="max-width: 1200px;">
                <div class="gd-storage-hero" style="margin-bottom: 24px;">
                    <p class="gd-storage-hero-subtitle">Add, suspend, or change user roles and permissions.</p>
                </div>

                <div class="gd-users-controls">
                    <div class="gd-search-bar" style="max-width: 500px;">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="#5F6368"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
                        <input id="admin-users-search" type="text" value="${esc(state.usersSearch)}" placeholder="Search users by name or email">
                    </div>
                    
                    <div class="gd-filter-chips" id="admin-users-filter-pills">
                        ${['all', 'active', 'suspended', 'admin'].map((f) => `<button class="gd-filter-chip ${state.usersFilter === f ? 'active' : ''}" data-admin-action="users-filter" data-filter="${f}">${f[0].toUpperCase()}${f.slice(1)}</button>`).join('')}
                    </div>
                    
                    <div style="flex:1"></div>
                    
                    <button class="gd-btn-primary" data-admin-action="open-invite-modal">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="margin-right:8px;"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
                        Add new user
                    </button>
                </div>

                ${selectedCount ? `
                    <div class="gd-bulk-actions">
                        <span style="font-size:14px; font-weight:500;">${selectedCount} selected</span>
                        <div style="display:flex; gap: 8px;">
                            <button class="gd-btn-outline" data-admin-action="bulk-suspend">Suspend</button>
                            <button class="gd-btn-outline" data-admin-action="bulk-role">Role</button>
                            <button class="gd-btn-outline" style="color:#D93025; border-color:#FCE8E6;" data-admin-action="bulk-delete">Delete</button>
                        </div>
                    </div>
                ` : ''}

                <div class="gd-card" style="padding: 0;">
                    <div class="gd-table-container gd-users-table-container">
                        <table class="gd-clean-table gd-users-table">
                            <thead>
                                <tr>
                                    <th style="width: 48px; text-align:center;"><input class="gd-checkbox" type="checkbox" data-admin-action="toggle-all-users" ${pageMeta.rows.length && pageMeta.rows.every((u) => state.userSelection.has(u.id)) ? 'checked' : ''}></th>
                                    <th>User</th>
                                    <th>Role</th>
                                    <th>Storage</th>
                                    <th>Last Active</th>
                                    <th>Status</th>
                                    <th style="width:48px;"></th>
                                </tr>
                            </thead>
                            <tbody>
                                ${pageMeta.rows.map((u) => {
                                    const status = getUserStatus(u);
                                    const used = asNumber(u.used_bytes, 0);
                                    const quota = Math.max(asNumber(u.quota_bytes, 0), 1);
                                    const pct = Math.min(100, (used / quota) * 100);
                                    const menuOpen = state.usersMenuOpen === u.id;
                                    return `
                                        <tr class="${state.drawerUserId === u.id ? 'active-row' : ''}">
                                            <td style="text-align:center;"><input class="gd-checkbox" type="checkbox" data-admin-action="toggle-user-select" data-user-id="${u.id}" ${state.userSelection.has(u.id) ? 'checked' : ''}></td>
                                            <td>
                                                <div class="gd-user-cell toggle-drawer-clickable" data-admin-action="open-user-drawer" data-user-id="${u.id}" style="cursor:pointer;">
                                                    <span class="gd-avatar" style="background-color: hsl(${((u.email || '').length * 137) % 360}, 60%, 50%)">${esc(initials(u.username || u.email))}</span>
                                                    <div class="gd-user-info">
                                                        <span class="gd-user-name">${esc(u.username || 'Unnamed')}</span>
                                                        <span class="gd-user-email">${esc(u.email || '')}</span>
                                                    </div>
                                                </div>
                                            </td>
                                            <td><span class="gd-role-badge gd-role-${String(u.role).toLowerCase()}">${roleLabel(u.role)}</span></td>
                                            <td>
                                                <div class="gd-usage-cell" style="width: 120px;">
                                                    <span style="font-size:12px;">${Components.formatSize(used)} / ${Math.round(quota/(1024**3))} GB</span>
                                                    <div class="gd-mini-bar" style="width:100%"><div class="gd-mini-fill" style="width: ${pct.toFixed(1)}%; background: ${pct > 90 ? '#D93025' : '#1A73E8'}"></div></div>
                                                </div>
                                            </td>
                                            <td style="color:#5F6368;">${Components.formatDate(state.userMeta[u.id]?.last_active || u.updated_at || u.created_at)}</td>
                                            <td><span class="gd-status-badge gd-status-${status}">${esc(status[0].toUpperCase() + status.slice(1))}</span></td>
                                            <td style="position:relative;">
                                                <button class="gd-icon-btn" data-admin-action="toggle-user-menu" data-user-id="${u.id}">
                                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>
                                                </button>
                                                <div class="gd-popup-menu ${menuOpen ? '' : 'hidden'}" id="user-menu-${u.id}">
                                                    <button data-admin-action="open-user-drawer" data-user-id="${u.id}">Edit user</button>
                                                    <button data-admin-action="change-role" data-user-id="${u.id}">Change role</button>
                                                    <button data-admin-action="reset-password" data-user-id="${u.id}">Reset password</button>
                                                    <button data-admin-action="adjust-quota" data-user-id="${u.id}">Adjust quota</button>
                                                    <button data-admin-action="toggle-suspend" data-user-id="${u.id}">${status === 'suspended' ? 'Unsuspend' : 'Suspend'}</button>
                                                    <div class="gd-menu-divider"></div>
                                                    <button class="danger" data-admin-action="delete-user" data-user-id="${u.id}" style="color:#D93025 !important;">Delete user</button>
                                                </div>
                                            </td>
                                        </tr>
                                    `;
                                }).join('') || '<tr><td colspan="7" class="gd-empty-table">No users found</td></tr>'}
                            </tbody>
                        </table>
                    </div>
                    <div class="gd-pagination-wrap" style="padding: 16px;">
                        ${renderPaginator('users', pageMeta)}
                    </div>
                </div>
            </div>

            <aside class="gd-drawer ${state.drawerUserId ? 'open' : ''}" id="admin-user-drawer">
                ${state.drawerUserId ? renderUserDrawer(state.drawerUserId) : ''}
            </aside>
            ${state.drawerUserId ? '<div class="gd-drawer-backdrop" data-admin-action="close-user-drawer"></div>' : ''}
        `;
    }

    function renderUserDrawer(userId) {
        const u = state.users.find((x) => x.id === userId);
        if (!u) return '';
        const meta = state.userMeta[u.id] || {};
        const status = meta.status || 'active';
        const twofaEnabled = Boolean(u.email_2fa_enabled);
        const totpEnabled = Boolean(u.totp_enabled);
        const global2FA = Boolean(state.settings?.security?.require_2fa);
        const email2faDisabled = global2FA && !totpEnabled ? 'disabled' : '';
        const email2faHint = global2FA && !totpEnabled
            ? 'Required for all users (enable authenticator to turn email off)'
            : (global2FA ? 'Optional when authenticator is enabled' : 'Require email code at sign-in');
        const breakdown = estimateFileTypeBuckets(state.drawerBreakdown);
        const bItems = Object.entries(breakdown).slice(0, 4);
        const recent = (state.activities || [])
            .filter((a) => isAuthActivity(a.action))
            .filter((a) => (a.user_id || '') === u.id || (a.username || '') === (u.username || ''))
            .slice(0, 5);

        return `
            <div class="gd-drawer-header">
                <h3>User details</h3>
                <button class="gd-icon-btn" data-admin-action="close-user-drawer"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
            </div>
            <div class="gd-drawer-content">
                <div class="gd-drawer-profile">
                    <div class="gd-avatar gd-avatar-xl" style="background-color: hsl(${((u.email || '').length * 137) % 360}, 60%, 50%)">${esc(initials(u.username || u.email))}</div>
                    <div class="gd-profile-info">
                        <h2>${esc(u.username || 'Unnamed')}</h2>
                        <span class="gd-email">${esc(u.email || '')}</span>
                    </div>
                </div>

                <div class="gd-drawer-tags">
                    <span class="gd-role-badge gd-role-${String(u.role).toLowerCase()}">${roleLabel(u.role)}</span>
                    <span class="gd-status-badge gd-status-${status}">${esc(status[0].toUpperCase() + status.slice(1))}</span>
                </div>

                <div class="gd-divider"></div>

                <div class="gd-drawer-section">
                    <h4>Settings</h4>
                    <form class="gd-drawer-form" id="drawer-edit-form">
                        <div class="gd-input-group">
                            <label>Name</label>
                            <input type="text" class="gd-input" id="drawer-name" value="${esc(u.username || '')}">
                        </div>
                        <div class="gd-input-group">
                            <label>Email address</label>
                            <input type="email" class="gd-input" id="drawer-email" value="${esc(u.email || '')}">
                        </div>
                        <div class="gd-input-group">
                            <label>Role</label>
                            <select class="gd-input" id="drawer-role">
                                <option value="user" ${String(u.role || '').toLowerCase() === 'user' ? 'selected' : ''}>User</option>
                                <option value="admin" ${String(u.role || '').toLowerCase() === 'admin' ? 'selected' : ''}>Admin</option>
                                <option value="guest" ${String(u.role || '').toLowerCase() === 'guest' ? 'selected' : ''}>Guest</option>
                            </select>
                        </div>
                        <div class="gd-input-group">
                            <label>Storage quota</label>
                            <select class="gd-input" id="drawer-quota">${quotaOptionsHtml(Math.max(1, Math.round(asNumber(u.quota_bytes, 0) / (1024 ** 3))))}</select>
                        </div>
                        <div class="gd-input-group">
                            <label>Authenticator app (TOTP)</label>
                            <span style="font-size:13px;color:${totpEnabled ? '#137333' : '#5f6368'};">${totpEnabled ? 'Enabled' : 'Not enabled'} — users set this up in Security</span>
                        </div>
                        <div class="gd-input-group">
                            <label>Email two-factor authentication</label>
                            <label class="live-toggle" style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;">
                                <input type="checkbox" id="drawer-2fa" ${twofaEnabled ? 'checked' : ''} ${email2faDisabled}>
                                <span style="font-size:13px;color:#5f6368;">${email2faHint}</span>
                            </label>
                        </div>
                        <div style="display:flex; justify-content: flex-end;">
                           <button type="button" class="gd-btn-primary" data-admin-action="save-inline-edit" data-user-id="${u.id}">Save changes</button>
                        </div>
                    </form>
                </div>

                <div class="gd-divider"></div>

                <div class="gd-drawer-section">
                    <h4>Storage used</h4>
                    <div class="gd-drawer-breakdown">
                        ${bItems.map(([label, item]) => `
                            <div class="gd-breakdown-row">
                                <div class="gd-breakdown-left">
                                    <span class="gd-legend-dot" style="background-color: ${item.color}"></span>
                                    <span>${label}</span>
                                </div>
                                <span class="gd-breakdown-size">${Components.formatSize(item.size)}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>

                <div class="gd-divider"></div>

                <div class="gd-drawer-section">
                    <h4>Recent activity</h4>
                    <div class="gd-drawer-activity">
                        ${recent.map((a) => `
                            <div class="gd-drawer-activity-item">
                                <div style="display:flex; justify-content:space-between;">
                                    <span class="gd-activity-action">${esc(a.action)}</span>
                                    <span class="gd-activity-time">${Components.formatDate(a.created_at)}</span>
                                </div>
                                <span class="gd-activity-target" title="${esc(a.target_name)}">${esc(a.target_name || 'item')}</span>
                            </div>
                        `).join('') || '<div class="gd-empty-text">No recent activity</div>'}
                    </div>
                </div>
            </div>
        `;
    }

    function renderStorageSection() {
        const totalCapacity = asNumber(state.disk?.total_bytes || state.stats.total_quota, 0);
        const used = asNumber(state.disk?.used_bytes || state.stats.total_used, 0);
        const free = Math.max(0, totalCapacity - used);

        const sortedUsers = [...(state.users || [])].sort((a, b) => asNumber(b.used_bytes) - asNumber(a.used_bytes));
        const pageMeta = paginate(sortedUsers, state.storageUserPage, state.storageUserPerPage);
        state.storageUserPage = pageMeta.page;

        const buckets = estimateFileTypeBuckets();
        const typeTotal = Object.values(buckets).reduce((sum, x) => sum + x.size, 0) || 1;

        const largeFiles = [...(state.files || [])].sort((a, b) => asNumber(b.size) - asNumber(a.size)).slice(0, 20);
        
        // Sort buckets for display: from largest to smallest, but keep "Other" at the end typically
        const sortedBuckets = Object.entries(buckets).sort((a, b) => b[1].size - a[1].size);

        if (!state.users.length && !state.files.length) {
            return renderNoData('No data available');
        }

        const usedPercentage = totalCapacity ? (used / totalCapacity) * 100 : 0;
        
        let accumulatedPercentage = 0;
        const barSegments = sortedBuckets.map(([label, item], idx) => {
            const pct = typeTotal ? (item.size / typeTotal) * 100 : 0;
            const segmentHTML = `<div class="gd-storage-segment tooltip-host gd-anim-segment" style="width: ${pct.toFixed(4)}%; background-color: ${item.color}; left: ${accumulatedPercentage.toFixed(4)}%; animation-delay: ${idx * 0.15}s;">
                 <span class="gd-tooltip">${esc(label)}: ${Components.formatSize(item.size)}</span>
            </div>`;
            accumulatedPercentage += pct;
            return segmentHTML;
        }).join('');

        return `
            <div class="gd-storage-container">
                <div class="gd-storage-hero">
                    <div class="gd-meter-container">
                        <div class="gd-meter-header">
                            <span class="gd-meter-used">${Components.formatSize(used)}</span>
                            <span class="gd-meter-total">of ${Components.formatSize(totalCapacity)} used</span>
                        </div>
                        
                        <div class="gd-meter-track">
                            <div class="gd-meter-fill-container">
                                ${barSegments}
                            </div>
                        </div>

                        <div class="gd-meter-legend">
                            ${sortedBuckets.map(([label, item]) => {
                                return `
                                    <div class="gd-legend-item">
                                        <div class="gd-legend-dot" style="background-color: ${item.color}"></div>
                                        <div class="gd-legend-text">
                                            <span class="gd-legend-label">${esc(label)}</span>
                                            <span class="gd-legend-size">${Components.formatSize(item.size)}</span>
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                </div>

                <div class="gd-cards-layout">
                    <!-- Clean Up Suggestions Card -->
                    <div class="gd-card gd-cleanup-card">
                        <div class="gd-card-header">
                            <div class="gd-card-icon-wrap" style="background-color: #E8F0FE; color: #1967D2;">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M15 2H9c-1.1 0-2 .9-2 2v2H3v2h18V6h-4V4c0-1.1-.9-2-2-2zM9 4h6v2H9V4zm3 16c-3.3 0-6-2.7-6-6h2c0 2.2 1.8 4 4 4s4-1.8 4-4-1.8-4-4-4v2l-3-3 3-3v2c3.3 0 6 2.7 6 6s-2.7 6-6 6z"/></svg>
                            </div>
                            <div class="gd-card-title-area">
                                <h3>Clean up space</h3>
                                <p>Review large files, trash, and duplicates to free up storage.</p>
                            </div>
                        </div>
                        <div class="gd-cleanup-actions">
                            <div class="gd-cleanup-item">
                                <span>Trashed items older than 30 days</span>
                                <button class="gd-btn-outline" data-admin-action="cleanup-trash">Review</button>
                            </div>
                            <div class="gd-cleanup-item">
                                <span>Duplicate files</span>
                                <button class="gd-btn-outline" data-admin-action="cleanup-duplicates">Review</button>
                            </div>
                            <div class="gd-cleanup-item">
                                <span>Never opened (90+ days)</span>
                                <button class="gd-btn-outline" disabled title="Not available yet">Notify</button>
                            </div>
                        </div>
                    </div>

                    <!-- Usage by User Card -->
                    <div class="gd-card">
                        <div class="gd-card-header">
                            <div class="gd-card-icon-wrap" style="background-color: #CEEAD6; color: #188038;">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5s-3 1.34-3 3 1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.98 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
                            </div>
                            <div class="gd-card-title-area">
                                <h3>Storage by user</h3>
                                <p>See who is using the most space.</p>
                            </div>
                        </div>
                        <div class="gd-table-container">
                            <table class="gd-clean-table">
                                <thead>
                                    <tr>
                                        <th>User</th>
                                        <th>Storage used</th>
                                        <th>Files</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${pageMeta.rows.map(u => {
                                        const quota = Math.max(1, asNumber(u.quota_bytes, 1));
                                        const usedBytes = asNumber(u.used_bytes, 0);
                                        const percent = (usedBytes / quota) * 100;
                                        const meta = state.userMeta[u.id] || {};
                                        return `
                                            <tr>
                                                <td>
                                                    <div class="gd-user-cell">
                                                        <span class="gd-avatar" style="background-color: hsl(${((u.email || '').length * 137) % 360}, 60%, 50%)">${esc(initials(u.username || u.email))}</span>
                                                        <div class="gd-user-info">
                                                            <span class="gd-user-name">${esc(u.username || 'Unnamed')}</span>
                                                            <span class="gd-user-email">${esc(u.email)}</span>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td>
                                                    <div class="gd-usage-cell">
                                                        <span>${Components.formatSize(usedBytes)}</span>
                                                        <div class="gd-mini-bar"><div class="gd-mini-fill" style="width: ${Math.min(100, percent)}%"></div></div>
                                                    </div>
                                                </td>
                                                <td>${(meta.files_count || 0).toLocaleString('en-US')}</td>
                                            </tr>
                                        `;
                                    }).join('') || '<tr><td colspan="3" class="gd-empty-table">No users found</td></tr>'}
                                </tbody>
                            </table>
                        </div>
                        <div class="gd-pagination-wrap">
                            ${renderPaginator('storage-users', pageMeta)}
                        </div>
                    </div>

                    <!-- Large Files Card -->
                    <div class="gd-card">
                        <div class="gd-card-header">
                            <div class="gd-card-icon-wrap" style="background-color: #FCE8E6; color: #D93025;">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
                            </div>
                            <div class="gd-card-title-area">
                                <h3>Large files</h3>
                                <p>Files consuming the most space on your disk.</p>
                            </div>
                        </div>
                        <div class="gd-table-container">
                            <table class="gd-clean-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Owner</th>
                                        <th>Size</th>
                                        <th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${largeFiles.map(f => {
                                        return `
                                            <tr>
                                                <td class="gd-file-name-cell">
                                                    <span class="gd-file-icon" style="margin-right:8px; display:inline-flex; align-items:center;">${adminGetFileIcon(f.mime_type, f.name)}</span>
                                                    <span class="gd-file-name" title="${esc(f.name)}">${esc(f.name)}</span>
                                                </td>
                                                <td class="gd-sec-text">${esc(f.owner_name || 'Admin')}</td>
                                                <td>${Components.formatSize(f.size)}</td>
                                                <td><button class="gd-icon-btn" data-admin-action="delete-large-file" data-file-id="${f.id}" title="Delete file"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button></td>
                                            </tr>
                                        `;
                                    }).join('') || '<tr><td colspan="4" class="gd-empty-table">No large files</td></tr>'}
                                </tbody>
                            </table>
                        </div>
                    </div>

                </div>
            </div>
        `;
    }

    function decorateActivity(item) {
        const action = String(item.action || '').toLowerCase();
        return {
            ...item,
            ip: item.ip_address || item.ip || '',
            device: item.device || 'Unknown device',
            status: action.includes('failed') ? 'failed' : 'success',
            user_agent: item.user_agent || '',
            session_id: item.session_id || item.id || '',
            file_uuid: item.target_id || '',
        };
    }

    function isAuthActivity(action) {
        const a = String(action || '').toLowerCase();
        return a === 'login' || a === 'failed_login';
    }

    function filteredActivityList() {
        const filters = state.activityFilters;
        return state.activities
            .map(decorateActivity)
            .filter((a) => {
                if (!isAuthActivity(a.action)) return false;
                if (filters.users.length && !filters.users.includes(String(a.user_id || a.username || ''))) return false;
                if (filters.action !== 'all' && String(a.action || '').toLowerCase() !== filters.action) return false;
                if (filters.from) {
                    const fromTs = new Date(filters.from).getTime();
                    if (new Date(a.created_at).getTime() < fromTs) return false;
                }
                if (filters.to) {
                    const toTs = new Date(filters.to).getTime() + (24 * 60 * 60 * 1000) - 1;
                    if (new Date(a.created_at).getTime() > toTs) return false;
                }
                return true;
            })
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }

    function activityActionClass(action) {
        const a = String(action || '').toLowerCase();
        if (a.includes('delete'))  return 'delete';
        if (a.includes('upload'))  return 'upload';
        if (a.includes('login') && a.includes('fail')) return 'failed';
        if (a.includes('login'))   return 'login';
        if (a.includes('share'))   return 'share';
        if (a.includes('download')) return 'download';
        return '';
    }

    function renderActivitySection() {
        const list = filteredActivityList();
        const pageMeta = paginate(list, state.activityPage, state.activityPerPage);
        state.activityPage = pageMeta.page;

        const usersOpts = state.users.map((u) => {
            const value = u.id || u.username;
            return `<option value="${esc(value)}" ${state.activityFilters.users.includes(value) ? 'selected' : ''}>${esc(u.username || u.email)}</option>`;
        }).join('');

        const svgOk   = `<svg width="15" height="15" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`;
        const svgFail = `<svg width="15" height="15" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`;
        const svgCsv  = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`;

        return `
            <div class="gd-storage-container" style="max-width: 1200px;">
                <div class="gd-storage-hero" style="margin-bottom: 24px;">
                    <p class="gd-storage-hero-subtitle">Authentication and sign-in events across all users.</p>
                </div>

                <div class="gd-card" style="margin-bottom: 24px; padding: 16px 24px;">
                    <div class="gd-filter-grid">
                        <div class="gd-input-group">
                            <label>Filter by user</label>
                            <select class="gd-input" id="admin-activity-users" multiple size="3">
                                ${usersOpts}
                            </select>
                        </div>
                        <div class="gd-input-group">
                            <label>Action type</label>
                            <select class="gd-input" id="admin-activity-action">
                                ${[
                                    ['all', 'All'],
                                    ['login', 'Login'],
                                    ['failed_login', 'Failed login'],
                                ].map(([value, label]) => `<option value="${value}" ${state.activityFilters.action === value ? 'selected' : ''}>${label}</option>`).join('')}
                            </select>
                        </div>
                        <div class="gd-input-group">
                            <label>Date from</label>
                            <input class="gd-input" type="date" id="admin-activity-from" value="${esc(state.activityFilters.from)}">
                        </div>
                        <div class="gd-input-group">
                            <label>Date to</label>
                            <input class="gd-input" type="date" id="admin-activity-to" value="${esc(state.activityFilters.to)}">
                        </div>
                    </div>

                    <div class="activity-filter-row">
                        <div class="activity-active-filters">
                            ${state.activityFilters.action !== 'all' ? `<button class="gd-filter-chip active" data-admin-action="clear-activity-filter" data-filter-key="action">${esc(state.activityFilters.action === 'failed_login' ? 'Failed login' : state.activityFilters.action)} ×</button>` : ''}
                            ${state.activityFilters.from ? `<button class="gd-filter-chip active" data-admin-action="clear-activity-filter" data-filter-key="from">From ${esc(state.activityFilters.from)} ×</button>` : ''}
                            ${state.activityFilters.to ? `<button class="gd-filter-chip active" data-admin-action="clear-activity-filter" data-filter-key="to">To ${esc(state.activityFilters.to)} ×</button>` : ''}
                        </div>
                        <div class="activity-filter-actions">
                            <label class="activity-live-label">
                                <input type="checkbox" data-admin-action="toggle-live" ${state.activityLive ? 'checked' : ''}>
                                Live updates
                                ${state.activityLive ? '<span class="activity-live-dot"></span>' : ''}
                            </label>
                            <div class="activity-divider"></div>
                            <button class="gd-btn-outline" data-admin-action="apply-activity-filters">Apply filters</button>
                            <button class="gd-icon-btn" data-admin-action="export-activity-csv" title="Download CSV">${svgCsv}</button>
                        </div>
                    </div>
                </div>

                <div class="gd-card" style="padding: 0;">
                    <div class="gd-table-container">
                        <table class="gd-clean-table activity-table">
                            <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th><th>IP Address</th><th>Device</th><th>Status</th></tr></thead>
                            <tbody>
                                ${pageMeta.rows.map((a) => {
                                    const expanded = state.expandedActivity.has(a.id);
                                    const badgeCls = activityActionClass(a.action);
                                    const isFailed = a.status === 'failed';
                                    return `
                                        <tr class="expandable" data-admin-action="toggle-activity-row" data-activity-id="${a.id}" style="cursor:pointer;">
                                            <td class="activity-time-cell">${Components.formatAbsoluteDate(a.created_at)}</td>
                                            <td>${esc(a.username || 'User')}</td>
                                            <td><span class="activity-action-badge ${badgeCls}">${esc(a.action || 'action')}</span></td>
                                            <td class="activity-target-cell" title="${esc(a.target_name || 'item')}">${esc(a.target_name || 'item')}</td>
                                            <td class="activity-time-cell">${esc(a.ip)}</td>
                                            <td>${esc(a.device)}</td>
                                            <td>
                                                ${isFailed
                                                    ? `<span class="activity-status-fail">${svgFail} Failed</span>`
                                                    : `<span class="activity-status-ok">${svgOk} Success</span>`}
                                            </td>
                                        </tr>
                                        <tr class="activity-detail-row ${expanded ? '' : 'hidden'}" id="activity-detail-${a.id}">
                                            <td colspan="7">
                                                <div class="activity-detail-grid">
                                                    <div><strong>User-Agent:</strong> ${esc(a.user_agent)}</div>
                                                    <div><strong>Session ID:</strong> ${esc(a.session_id)}</div>
                                                    <div><strong>File UUID:</strong> ${esc(a.file_uuid)}</div>
                                                    <div><strong>Change type:</strong> ${esc(a.action)}</div>
                                                </div>
                                            </td>
                                        </tr>
                                    `;
                                }).join('') || `<tr><td colspan="7" class="gd-empty-table">${renderNoData('No data available')}</td></tr>`}
                            </tbody>
                        </table>
                    </div>
                    <div class="gd-pagination-wrap" style="padding: 16px;">
                        ${renderPaginator('activity', pageMeta)}
                    </div>
                </div>
            </div>
        `;
    }

    function getFailedLogins() {
        const rows = filteredActivityList().filter((a) => String(a.action || '').toLowerCase().includes('failed'));
        const grouped = new Map();
        rows.forEach((r) => {
            const key = `${r.username || r.user_id || 'user'}|${r.ip || ''}`;
            if (!grouped.has(key)) {
                grouped.set(key, {
                    id: r.id || key,
                    email_ip: `${r.username || 'user'} / ${r.ip || 'Unknown'}`,
                    attempts: 0,
                    last_attempt: r.created_at,
                    blocked: (state.settings.security.blocklist || []).some((x) => x.ip === (r.ip || '')),
                    ip: r.ip || '',
                });
            }
            const item = grouped.get(key);
            item.attempts += 1;
            if (new Date(r.created_at) > new Date(item.last_attempt)) item.last_attempt = r.created_at;
        });
        return Array.from(grouped.values()).slice(0, 30).map((r) => ({
            id: r.id,
            email_ip: r.email_ip,
            attempts: r.attempts,
            last_attempt: r.last_attempt,
            blocked: r.blocked,
            ip: r.ip,
        }));
    }

    function getActiveSessions() {
        const me = getCurrentUser();
        const loginEvents = filteredActivityList().filter((a) => String(a.action || '').toLowerCase() === 'login');
        const bySession = new Map();
        loginEvents.forEach((a) => {
            const sessionKey = String(a.session_id || `${a.user_id || a.username || 'user'}:${a.ip || 'unknown'}`);
            if (!bySession.has(sessionKey)) {
                bySession.set(sessionKey, {
                    id: sessionKey,
                    user_id: a.user_id || '',
                    user: a.username || 'User',
                    device: a.device || 'Unknown device',
                    ip: a.ip || '',
                    location: a.location || 'Unknown',
                    started: a.created_at,
                    last_active: a.created_at,
                    is_me: String(a.user_id || '') === String(me.id || ''),
                });
            } else {
                const s = bySession.get(sessionKey);
                if (new Date(a.created_at) < new Date(s.started)) s.started = a.created_at;
                if (new Date(a.created_at) > new Date(s.last_active)) s.last_active = a.created_at;
            }
        });
        return Array.from(bySession.values()).slice(0, 50);
    }

    function renderSecuritySection() {
        const fails = getFailedLogins();
        const sessions = getActiveSessions();
        const sec = state.settingsDraft?.security || state.settings?.security || {};
        const require2FA = Boolean(sec.require_2fa);
        const lastRotation = sec.last_key_rotation ? Components.formatDate(sec.last_key_rotation) : 'Never';

        return `
            <div class="gd-storage-container">
                <div class="gd-storage-hero" style="margin-bottom: 24px;">
                    <p class="gd-storage-hero-subtitle">Monitor suspicious activity, sessions, and authentication policy.</p>
                </div>

                <div class="gd-card" style="padding:24px;margin-bottom:24px;">
                    <h3 style="margin:0 0 8px;font-size:16px;">Two-factor authentication</h3>
                    <p style="margin:0 0 16px;color:#5f6368;font-size:14px;">Require a second factor at sign-in for every user (authenticator app or email code).</p>
                    <label class="live-toggle" style="display:inline-flex;align-items:center;gap:10px;cursor:pointer;">
                        <input type="checkbox" data-admin-action="toggle-require-2fa" ${require2FA ? 'checked' : ''}>
                        <span style="font-weight:500;color:#3c4043;">Require 2FA for all users</span>
                    </label>
                    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:18px;">
                        <button class="gd-btn-outline" data-admin-action="send-2fa-reminder">Remind users without 2FA</button>
                        <button class="gd-btn-outline" data-admin-action="rotate-keys">Record key rotation</button>
                    </div>
                    <p style="margin:12px 0 0;font-size:12px;color:#5f6368;">Last recorded key rotation: ${esc(lastRotation)}. Full encryption key rotation is not automated yet — this only updates the timestamp.</p>
                </div>

                <div class="gd-cards-layout">
                    <div class="gd-card" style="padding:0;">
                        <div class="gd-card-header" style="align-items:center; padding: 24px 24px 0 24px;">
                            <div class="gd-card-icon-wrap" style="background-color: #FCE8E6; color: #D93025; width:36px; height:36px;">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm1 14h-2v-2h2v2zm0-4h-2V7h2v5z"/></svg>
                            </div>
                            <div class="gd-card-title-area" style="flex:1;">
                                <h3 style="margin:0; font-size:16px;">Suspicious logins</h3>
                            </div>
                        </div>
                        <div class="gd-table-container">
                            <table class="gd-clean-table">
                                <thead><tr><th style="padding-left:24px;">Target / IP</th><th>Attempts</th><th>Last attempt</th><th>Network block</th></tr></thead>
                                <tbody>
                                    ${fails.map((f) => `
                                        <tr>
                                            <td style="padding-left:24px;">${esc(f.email_ip)}</td>
                                            <td><span style="color:#D93025; font-weight:600;">${f.attempts}</span></td>
                                            <td>${Components.formatDate(f.last_attempt)}</td>
                                            <td>
                                                <div class="gd-toggle">
                                                    <input type="checkbox" id="block-ip-${f.id}" data-admin-action="toggle-block-ip" data-ip="${esc(f.ip)}" ${f.blocked ? 'checked' : ''}>
                                                    <label for="block-ip-${f.id}"></label>
                                                </div>
                                            </td>
                                        </tr>
                                    `).join('') || '<tr><td colspan="4" class="gd-empty-table" style="color:#188038; padding:32px;"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" style="display:block; margin: 0 auto 8px;"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>No suspicious activity detected recently</td></tr>'}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div class="gd-card" style="padding:0;">
                        <div class="gd-card-header" style="align-items:center; padding: 24px 24px 0 24px;">
                            <div class="gd-card-icon-wrap" style="background-color: #E8F0FE; color: #1967D2; width:36px; height:36px;">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>
                            </div>
                            <div class="gd-card-title-area" style="flex:1;">
                                <h3 style="margin:0; font-size:16px;">Active sessions</h3>
                            </div>
                            <button class="gd-btn-outline" data-admin-action="revoke-all-sessions">Revoke all</button>
                        </div>
                        <div class="gd-table-container">
                            <table class="gd-clean-table">
                                <thead><tr><th style="padding-left:24px;">User</th><th>Device</th><th>IP Address</th><th>Started</th><th>Last active</th><th></th></tr></thead>
                                <tbody>
                                    ${sessions.map((s) => `
                                        <tr>
                                            <td style="padding-left:24px;">
                                                <div style="display:flex; align-items:center; gap:8px;">
                                                    <span class="gd-avatar" style="width:24px; height:24px; font-size:10px; background-color:hsl(${((s.user || '').length * 137) % 360},60%,50%)">${esc(initials(s.user))}</span>
                                                    ${esc(s.user)}
                                                    ${s.is_me ? '<span style="font-size:10px; font-weight:600; padding:2px 6px; background:#CEEAD6; color:#188038; border-radius:10px;">This device</span>' : ''}
                                                </div>
                                            </td>
                                            <td>${esc(s.device)}</td>
                                            <td style="font-family:monospace; font-size:12px; color:#5F6368;">${esc(s.ip)}</td>
                                            <td style="color:#5F6368;">${Components.formatDate(s.started)}</td>
                                            <td style="color:#5F6368;">${Components.formatDate(s.last_active)}</td>
                                            <td></td>
                                        </tr>
                                    `).join('') || '<tr><td colspan="6" class="gd-empty-table">No active sessions</td></tr>'}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    function renderGeneralTab() {
        const g = state.settingsDraft.general;
        return `
            <div style="margin-bottom: 24px;">
                <h3 style="font-size: 18px; color: #202124; margin: 0 0 8px 0;">Workspace Identity</h3>
                <p style="color: #5F6368; font-size: 14px; margin: 0;">Manage your FreeDrive site name, language, and core behavior.</p>
            </div>
            <div class="settings-grid">
                <div class="admin-form-group">
                    <label>Site name</label>
                    <input class="admin-input" data-setting="general.site_name" value="${esc(g.site_name)}">
                </div>
                <div class="admin-form-group">
                    <label>Site URL</label>
                    <input class="admin-input" data-setting="general.site_url" value="${esc(g.site_url)}">
                </div>
                <div class="admin-form-group">
                    <label>Default language</label>
                    <select class="admin-input" data-setting="general.language">
                        ${['en', 'az', 'tr', 'de'].map((x) => `<option value="${x}" ${g.language === x ? 'selected' : ''}>${x.toUpperCase()}</option>`).join('')}
                    </select>
                </div>
                <div class="admin-form-group">
                    <label>Default quota</label>
                    <select class="admin-input" data-setting="general.default_quota_gb">${quotaOptionsHtml(g.default_quota_gb)}</select>
                </div>
                <div class="admin-form-group">
                    <label>Registration</label>
                    <select class="admin-input" data-setting="general.registration">
                        ${['open', 'invite', 'closed'].map((x) => `<option value="${x}" ${g.registration === x ? 'selected' : ''}>${x === 'invite' ? 'Invite-only' : x[0].toUpperCase() + x.slice(1)}</option>`).join('')}
                    </select>
                </div>
                <div class="admin-form-group">
                    <label>Max file size</label>
                    <select class="admin-input" data-setting="general.max_upload_mb">${maxUploadOptionsHtml(g.max_upload_mb)}</select>
                </div>
            </div>
            <div class="types-chip-wrap">
                <h4>Allowed file types</h4>
                <label style="display:flex; align-items:center; gap:8px; margin-bottom:12px; cursor:pointer;">
                    <input type="checkbox" data-setting="general.allowed_types_unlimited" ${g.allowed_types_unlimited ? 'checked' : ''} style="width:18px; height:18px;">
                    <span>Without limits — accept all file types</span>
                </label>
                <div class="chip-row" id="allowed-type-chip-row" style="${g.allowed_types_unlimited ? 'opacity:0.5; pointer-events:none;' : ''}">
                    ${g.allowed_types.map((t) => `<span class="admin-chip">.${esc(t)} <button data-admin-action="remove-type-chip" data-type="${esc(t)}">×</button></span>`).join('')}
                </div>
                <div class="chip-add-row" style="${g.allowed_types_unlimited ? 'opacity:0.5; pointer-events:none;' : ''}">
                    <input class="admin-input filetype-input" id="new-type-chip" placeholder="Add file type... e.g. .webp" ${g.allowed_types_unlimited ? 'disabled' : ''}>
                    <span class="enter-hint">↵</span>
                </div>
            </div>
        `;
    }

    function renderEmailTab() {
        const e = state.settingsDraft.email;
        return `
            <div style="margin-bottom: 24px;">
                <h3 style="font-size: 18px; color: #202124; margin: 0 0 8px 0;">Email Configuration</h3>
                <p style="color: #5F6368; font-size: 14px; margin: 0;">Configure your SMTP server to allow FreeDrive to send invites and notifications.</p>
            </div>
            <div class="settings-grid">
                <div class="admin-form-group">
                    <label>SMTP Server</label>
                    <input class="admin-input" data-setting="email.smtp_server" placeholder="smtp.example.com" value="${esc(e.smtp_server)}">
                </div>
                <div class="admin-form-group">
                    <label>Port</label>
                    <input class="admin-input" type="number" placeholder="587" data-setting="email.smtp_port" value="${esc(e.smtp_port)}">
                </div>
                <div class="admin-form-group">
                    <label>Username</label>
                    <input class="admin-input" data-setting="email.smtp_user" placeholder="user@example.com" value="${esc(e.smtp_user)}">
                </div>
                <div class="admin-form-group">
                    <label>Password</label>
                    <input class="admin-input" type="password" data-setting="email.smtp_pass" placeholder="••••••••" value="${esc(e.smtp_pass)}">
                </div>
                <div class="admin-form-group">
                    <label>From Address</label>
                    <input class="admin-input" data-setting="email.from_address" placeholder="noreply@example.com" value="${esc(e.from_address)}">
                </div>
                <div class="admin-form-group">
                    <label>From Name</label>
                    <input class="admin-input" data-setting="email.from_name" placeholder="FreeDrive" value="${esc(e.from_name)}">
                </div>
            </div>
            
            <div style="margin-top: 24px; padding-top: 24px; border-top: 1px solid #E8EAED;">
                <label class="live-toggle" style="display: inline-flex; align-items: center; cursor: pointer; gap: 8px;">
                    <div style="position: relative;">
                        <input type="checkbox" data-setting="email.tls" ${e.tls ? 'checked' : ''} style="width: 18px; height: 18px;">
                    </div>
                    <span style="font-weight: 500; color: #3C4043;">Require TLS encryption (recommended)</span>
                </label>
            </div>

            <div style="margin-top: 24px; background: #F8F9FA; border-radius: 8px; padding: 20px; border: 1px solid #E8EAED;">
                <h4 style="margin: 0 0 12px 0; font-size: 14px; color: #202124;">Test Configuration</h4>
                <div class="chip-add-row" style="display: flex; gap: 12px;">
                    <input class="admin-input filetype-input" style="flex: 1; max-width: 300px; background: white;" id="test-email-input" placeholder="test@domain.com">
                    <button class="gd-btn-primary" data-admin-action="send-test-email">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 6px;"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                        Send Test Email
                    </button>
                </div>
                <div id="test-email-result" style="margin-top: 12px; font-size: 13px; display: none;"></div>
            </div>
        `;
    }

    function renderStorageTab() {
        const s = state.settingsDraft.storage;
        return `
            <div class="settings-grid">
                <div class="admin-form-group">
                    <label>Data directory</label>
                    <input class="admin-input" data-setting="storage.data_directory" value="${esc(s.data_directory)}">
                </div>
                <div class="admin-form-group">
                    <label>Total capacity limit (GB)</label>
                    <input class="admin-input" type="number" min="1" data-setting="storage.total_capacity_gb" value="${esc(s.total_capacity_gb)}">
                </div>
                <div class="admin-form-group">
                    <label>Trash auto-empty</label>
                    <select class="admin-input" data-setting="storage.trash_auto_empty">
                        ${[['never', 'Never'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']].map(([v, l]) => `<option value="${v}" ${String(s.trash_auto_empty) === v ? 'selected' : ''}>${l}</option>`).join('')}
                    </select>
                </div>
                <div class="admin-form-group">
                    <label>Keep last versions</label>
                    <input class="admin-input" type="number" min="1" data-setting="storage.keep_versions" value="${esc(s.keep_versions)}">
                </div>
            </div>
            <label class="live-toggle">
                <input type="checkbox" data-setting="storage.versioning" ${s.versioning ? 'checked' : ''}> Versioning enabled
            </label>
        `;
    }

    function renderBackupTab() {
        const b = state.settingsDraft.backup;
        const backups = state.backups || [];
        return `
            <p class="settings-hint" style="margin:0 0 12px; color:#5f6368; font-size:13px;">Settings backup — exports admin settings JSON only (not database or file blobs).</p>
            <div class="backup-top-row">
                <button class="gd-btn-primary" data-admin-action="run-backup-now">Create settings backup</button>
                <div class="backup-progress"><span id="backup-progress-fill"></span></div>
            </div>
            <div class="backup-form-grid">
                <div class="admin-form-group backup-location-group">
                    <label>Backup location</label>
                    <input class="admin-input" data-setting="backup.location" value="${esc(b.location)}">
                </div>
                <div class="admin-form-group">
                    <label>Schedule</label>
                    <select class="admin-input" data-setting="backup.schedule">
                        ${['daily', 'weekly', 'monthly'].map((x) => `<option value="${x}" ${b.schedule === x ? 'selected' : ''}>${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}
                    </select>
                </div>
                <div class="admin-form-group">
                    <label>Time</label>
                    <input class="admin-input" type="time" data-setting="backup.time" value="${esc(b.time)}">
                </div>
            </div>
            <label class="live-toggle">
                <input type="checkbox" data-setting="backup.auto_backup" ${b.auto_backup ? 'checked' : ''}> Auto backup
            </label>
            <div class="admin-table-wrap">
                <table class="admin-table">
                    <thead><tr><th>Date</th><th>Size</th><th></th></tr></thead>
                    <tbody>
                        ${backups.map((h) => `
                            <tr>
                                <td>${Components.formatAbsoluteDate(h.created_at)}</td>
                                <td>${Components.formatSize(h.size)}</td>
                                <td>
                                    <div class="backup-row-actions">
                                        <button class="gd-btn-outline" data-admin-action="backup-download" data-backup-filename="${esc(h.filename)}">Download</button>
                                        <button class="gd-btn-outline" data-admin-action="backup-restore" data-backup-filename="${esc(h.filename)}">Restore settings</button>
                                        <button class="danger-outline-btn" data-admin-action="backup-delete" data-backup-filename="${esc(h.filename)}">Delete</button>
                                    </div>
                                </td>
                            </tr>
                        `).join('') || '<tr><td colspan="3" class="admin-empty-row">No backups yet</td></tr>'}
                    </tbody>
                </table>
            </div>
        `;
    }


    function renderDangerTab() {
        return `
            <div class="danger-zone">
                <h4>Danger Zone</h4>
                <p>These actions cannot be undone.</p>
                <div class="danger-actions">
                    <button class="danger-outline-btn" data-admin-action="danger-clear-trash">Clear all trash</button>
                    <button class="danger-outline-btn" data-admin-action="danger-reset-sessions">Reset all user sessions</button>
                    <input class="admin-input" id="danger-confirm-input" placeholder="Type WIPE to enable">
                    <button class="danger-outline-btn" id="danger-wipe-btn" data-admin-action="danger-wipe-data" disabled>Wipe all data</button>
                </div>
            </div>
        `;
    }

    function renderSettingsSection() {
        const cu = getCurrentUser();
        let savedPhoto = localStorage.getItem('fd_profile_photo');
        if (!savedPhoto) {
            try {
                const prefs = JSON.parse(localStorage.getItem('fd_user_prefs') || '{}');
                if (prefs.profileAvatar) savedPhoto = prefs.profileAvatar;
            } catch (e) {}
        }
        savedPhoto = savedPhoto || cu.avatar_url;

        const avatarHtml = savedPhoto 
            ? `<img src="${esc(savedPhoto)}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`
            : esc(initials(cu.username || cu.email || 'A'));

        const tabs = [
            { id: 'general',    label: 'General',       icon: '<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.06-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.06.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .43-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.49-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>' },
            { id: 'email',      label: 'Email Server',  icon: '<path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>' },
            { id: 'storage',    label: 'Storage & Data', icon: '<path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/>' },
            { id: 'backup',     label: 'Backup',         icon: '<path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2v9.67z"/>' },
            { id: 'danger',     label: 'Advanced',       icon: '<path d="M15.73 3H8.27L3 8.27v7.46L8.27 21h7.46L21 15.73V8.27L15.73 3zM12 17.3c-.72 0-1.3-.58-1.3-1.3 0-.72.58-1.3 1.3-1.3.72 0 1.3.58 1.3 1.3 0 .72-.58 1.3-1.3 1.3zm1-4.3h-2V7h2v6z"/>' },
        ];

        const tabRenderers = {
            general:    renderGeneralTab,
            email:      renderEmailTab,
            storage:    renderStorageTab,
            backup:     renderBackupTab,
            danger:     renderDangerTab,
        };
        const actTabHtml = (tabRenderers[state.settingsTab] || renderGeneralTab)();

        const hasErrors = Object.keys(state.settingsErrors || {}).length > 0;
        const showSaved = !state.settingsDirty && state.settingsSavedUntil > Date.now();

        return `
            <div class="gd-storage-container" style="max-width: 900px;">
                <div class="gd-card" style="margin-bottom: 24px; display: flex; align-items: center; gap: 20px; padding: 24px; background: linear-gradient(135deg, rgba(26,115,232,0.05), rgba(124,92,252,0.05)); border-radius: 12px; border: 1px solid rgba(26,115,232,0.1);">
                    <div class="gd-avatar" style="width: 80px; height: 80px; font-size: 32px; background: linear-gradient(135deg, #1A73E8, #7C5CFC); color: white; border: 4px solid white; box-shadow: 0 4px 12px rgba(26,115,232,0.2);">${avatarHtml}</div>
                    <div style="flex: 1;">
                        <h2 style="margin: 0 0 4px 0; font-size: 24px; font-weight: 600; color: #202124;">${esc(getCurrentUser().username || 'Administrator')}</h2>
                        <div style="display: flex; gap: 12px; color: #5F6368; font-size: 14px;">
                            <span style="display: flex; align-items: center; gap: 4px;"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>${esc(getCurrentUser().email || 'admin@freedrive.local')}</span>
                            <span style="display: flex; align-items: center; gap: 4px;"><span style="width: 8px; height: 8px; border-radius: 50%; background: #188038;"></span> System Admin</span>
                        </div>
                    </div>
                </div>

                <div class="gd-tabs">
                    ${tabs.map((t) => `
                        <button class="gd-tab-btn ${state.settingsTab === t.id ? 'active' : ''}" data-admin-action="switch-settings-tab" data-tab="${t.id}">
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="margin-right:8px;">${t.icon}</svg>
                            ${t.label}
                        </button>
                    `).join('')}
                </div>

                <div class="gd-card gd-settings-pane" style="margin-top: 24px; padding-bottom: 72px; position: relative; min-height: 400px;">
                    ${actTabHtml}
                    ${state.settingsTab !== 'danger' ? `
                    <div class="settings-action-bar">
                        ${hasErrors ? '<span class="settings-status-error">Please fix the errors above.</span>' : ''}
                        ${state.settingsDirty ? '<span class="settings-status-unsaved">Unsaved changes</span>' : ''}
                        ${showSaved ? `<span class="settings-status-saved"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg> Saved</span>` : ''}
                        <button class="gd-btn-outline" data-admin-action="cancel-settings" ${!state.settingsDirty ? 'disabled' : ''}>Cancel</button>
                        <button class="gd-btn-primary" data-admin-action="save-settings" ${!state.settingsDirty || hasErrors ? 'disabled' : ''}>Save changes</button>
                    </div>
                    ` : ''}
                </div>
            </div>
        `;
    }

    function renderShell() {
        const header = document.getElementById('file-list-header');
        const empty = document.getElementById('empty-state');
        const loading = document.getElementById('loading-state');
        const shared = document.getElementById('shared-filter-bar');
        const activity = document.getElementById('activity-page');
        const storage = document.getElementById('storage-page');
        const selection = document.getElementById('selection-bar');
        const grid = document.getElementById('file-grid');
        const chipBar = document.getElementById('md3-chip-bar');

        header?.classList.add('hidden');
        empty?.classList.add('hidden');
        loading?.classList.add('hidden');
        shared?.classList.add('hidden');
        activity?.classList.add('hidden');
        storage?.classList.add('hidden');
        selection?.classList.add('hidden');
        chipBar?.classList.add('hidden');

        grid.classList.remove('hidden');
        grid.classList.remove('grid-view');
        grid.innerHTML = `
            <div class="admin-shell" id="admin-shell">
                <header class="admin-page-header">
                    <div class="admin-header-left">
                        <div class="admin-breadcrumb">
                            <h2 id="admin-page-title"></h2>
                        </div>
                    </div>
                </header>
                <div id="admin-section-root"></div>
            </div>
        `;
    }

    function getSectionRoot() {
        return document.getElementById('admin-section-root');
    }

    function sectionTitle(section) {
        switch (normalizeSection(section)) {
            case 'users': return 'Manage Users';
            case 'storage': return 'Storage';
            case 'activity': return 'Activity log';
            case 'security': return 'Security & access';
            case 'settings': return 'Settings';
            default: return 'Dashboard';
        }
    }

    function renderSection() {
        const root = getSectionRoot();
        if (!root) return;

        const titleEl = document.getElementById('admin-page-title');
        if (titleEl) titleEl.textContent = sectionTitle(state.section);

        if (state.section === 'dashboard') {
            root.innerHTML = renderDashboardSection();
        } else if (state.section === 'users') {
            root.innerHTML = renderUsersSection();
        } else if (state.section === 'storage') {
            root.innerHTML = renderStorageSection();
        } else if (state.section === 'activity') {
            root.innerHTML = renderActivitySection();
        } else if (state.section === 'security') {
            root.innerHTML = renderSecuritySection();
        } else {
            root.innerHTML = renderSettingsSection();
        }

        bindSectionEvents();
    }

    async function load(section = 'dashboard') {
        const me = getCurrentUser();
        if (String(me.role || '').toLowerCase() !== 'admin') {
            Components.toast('Admin access required', 'error');
            history.pushState(null, '', '/#/files');
            window.dispatchEvent(new Event('popstate'));
            return;
        }

        state.section = normalizeSection(section);
        if (!state.initialized) {
            loadLocalUiState();
            state.initialized = true;
        }

        state.loading = true;
        renderShell();
        const root = getSectionRoot();
        if (root) root.innerHTML = renderSectionSkeleton(state.section);
        await loadServerSettings();
        await hydrateData();
        state.loading = false;
        renderShell();
        renderSection();
    }

    function closeAllRowMenus() {
        document.querySelectorAll('.gd-popup-menu').forEach((el) => el.classList.add('hidden'));
        state.usersMenuOpen = '';
    }

    function userById(id) {
        return state.users.find((u) => u.id === id);
    }

    function validateSettings() {
        const err = {};
        const g = state.settingsDraft.general;
        const e = state.settingsDraft.email;
        const s = state.settingsDraft.storage;

        if (!String(g.site_name || '').trim()) err.site_name = 'Site name is required';
        if (!String(g.site_url || '').trim()) err.site_url = 'Site URL is required';
        if (asNumber(g.default_quota_gb, 0) <= 0) err.default_quota_gb = 'Default quota must be greater than 0';
        if (asNumber(g.max_upload_mb, 0) <= 0) err.max_upload_mb = 'Max upload size must be greater than 0';
        if (e.smtp_port && (asNumber(e.smtp_port, 0) <= 0)) err.smtp_port = 'SMTP port is invalid';
        if (asNumber(s.total_capacity_gb, 0) <= 0) err.total_capacity = 'Total capacity must be greater than 0';

        state.settingsErrors = err;
        return !Object.keys(err).length;
    }

    function getSetting(path) {
        const parts = path.split('.');
        let cur = state.settingsDraft;
        for (const p of parts) {
            cur = cur?.[p];
        }
        return cur;
    }

    function setSetting(path, value) {
        const parts = path.split('.');
        let cur = state.settingsDraft;
        for (let i = 0; i < parts.length - 1; i += 1) {
            const key = parts[i];
            if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {};
            cur = cur[key];
        }
        cur[parts[parts.length - 1]] = value;
    }

    async function handleUserAction(action, userId) {
        const user = userById(userId);
        if (!user) return;

        if (action === 'change-role') {
            const role = await Components.prompt('Change role', String(user.role || 'user'));
            if (!role) return;
            try {
                await API.admin.updateUser(userId, { role: role.toLowerCase() });
                Components.toast('Role updated', 'success');
                await load(state.section);
            } catch (err) {
                Components.toast(err?.message || 'Failed to update role', 'error');
            }
            return;
        }

        if (action === 'adjust-quota') {
            const gb = await promptQuota('Adjust quota', Math.max(1, Math.round(asNumber(user.quota_bytes, 0) / (1024 ** 3))));
            if (!gb) return;
            const quota = Math.max(1, asNumber(gb, 10));
            try {
                await API.admin.updateUser(userId, { quota_bytes: Math.round(quota * (1024 ** 3)) });
                Components.toast('Quota updated', 'success');
                await load(state.section);
            } catch (err) {
                Components.toast(err?.message || 'Failed to update quota', 'error');
            }
            return;
        }

        if (action === 'toggle-suspend') {
            const suspended = !user.suspended;
            try {
                await API.admin.updateUser(userId, { suspended });
                Components.toast(suspended ? 'User suspended' : 'User unsuspended', 'success');
                await load(state.section);
            } catch (err) {
                Components.toast(err?.message || 'Failed to update user', 'error');
            }
            return;
        }

        if (action === 'reset-password') {
            await API.admin.sendPasswordReset(userId).catch((err) => {
                Components.toast(err.message, 'error');
                throw err;
            });
            Components.toast(`Password reset link sent to ${user.email}`, 'success');
            return;
        }

        if (action === 'delete-user') {
            const ok = await Components.confirm(
                'Delete user',
                'This permanently deletes the account and all of their files, folders, and devices. This cannot be undone.',
                'Delete',
            );
            if (!ok) return;
            await API.admin.deleteUser(userId).catch((err) => {
                Components.toast(err.message, 'error');
                throw err;
            });
            state.userSelection.delete(userId);
            Components.toast('User and all their files deleted', 'success');
            await load(state.section);
            return;
        }
    }

    function openInviteModal() {
        const pending = state.invites.filter((x) => x.status === 'pending');
        const body = `
            <div class="admin-modal-form admin-invite-modal">
                <div class="invite-form-grid">
                    <label class="modal-label" for="invite-email">E-mail</label>
                    <input id="invite-email" class="admin-input" type="email" placeholder="name@company.com">

                    <label class="modal-label" for="invite-role">Role</label>
                    <select id="invite-role" class="admin-input">
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                        <option value="guest">Guest</option>
                    </select>

                    <label class="modal-label" for="invite-quota">Quota</label>
                    <select id="invite-quota" class="admin-input">${quotaOptionsHtml(10)}</select>

                    <label class="modal-label" for="invite-message">Welcome message (optional)</label>
                    <textarea id="invite-message" class="admin-input invite-message-input" rows="3" placeholder="Welcome to FreeDrive..."></textarea>
                </div>

                <div class="panel-sep"></div>

                <h4 class="invite-section-title">Pending invites</h4>
                <div class="invite-list">
                    ${pending.map((p, idx) => `
                        <div class="invite-row">
                            <div class="invite-row-main">
                                <span class="invite-row-email">${esc(p.email)}</span>
                                <span class="invite-row-meta">${esc((p.role || 'user').toUpperCase())} • ${esc(String(p.quota || 10))} GB</span>
                            </div>
                            <div class="invite-row-actions">
                                <button class="link-btn invite-action-btn" data-invite-action="copy" data-idx="${idx}">Copy Link</button>
                                <button class="link-btn invite-action-btn" data-invite-action="resend" data-idx="${idx}">Resend</button>
                                <button class="link-btn danger invite-action-btn" data-invite-action="cancel" data-idx="${idx}">Cancel</button>
                            </div>
                        </div>
                    `).join('') || '<p class="admin-muted invite-empty">No pending invites</p>'}
                </div>
            </div>
        `;

        Components.showModal('Invite user', body, [
            { text: 'Close' },
            {
                text: 'Generate Link',
                class: 'btn-primary',
                close: false,
                action: async () => {
                    const email = String(document.getElementById('invite-email')?.value || '').trim();
                    const role = String(document.getElementById('invite-role')?.value || 'user');
                    const quota = Math.max(1, asNumber(document.getElementById('invite-quota')?.value, 10));
                    const message = String(document.getElementById('invite-message')?.value || '').trim();
                    if (!email || !email.includes('@')) {
                        Components.toast('Valid e-mail is required', 'error');
                        return;
                    }
                    const actionBtn = Array.from(document.querySelectorAll('.modal-footer .btn'))
                        .find((b) => b.textContent === 'Generate Link');
                    if (actionBtn) {
                        actionBtn.disabled = true;
                        actionBtn.textContent = 'Generating...';
                    }
                    try {
                        const eCfg = state.settingsDraft?.email || {};
                        const invite = await API.admin.createInvite({
                            role,
                            max_uses: 1,
                            quota_bytes: quota * 1073741824,
                            email,
                            message,
                            smtp_server: eCfg.smtp_server || '',
                            smtp_port: parseInt(eCfg.smtp_port, 10) || 0,
                            smtp_user: eCfg.smtp_user || '',
                            smtp_pass: eCfg.smtp_pass || '',
                            from_address: eCfg.from_address || '',
                            from_name: eCfg.from_name || '',
                            tls: Boolean(eCfg.tls),
                        });
                        const inviteCode = invite?.code || '';
                        if (!inviteCode) {
                            throw new Error('Invite code could not be generated');
                        }
                        state.invites.push(mapInviteRecord({
                            ...invite,
                            email,
                            role,
                            quota_bytes: quota * 1073741824,
                        }));
                        
                        // Transform the modal to show the link
                        const link = invite?.invite_url || `${window.location.origin}?invite=${inviteCode}`;
                        const emailSent = Boolean(invite?.email_sent);
                        const emailError = String(invite?.email_error || '').trim();
                        if (emailSent) {
                            Components.toast(`Invite email sent to ${email}`, 'success');
                        } else if (emailError) {
                            Components.toast(`Invite link created, but email was not sent: ${emailError}`, 'warning', { duration: 8000 });
                        } else {
                            Components.toast('Invite link created', 'success');
                        }
                        
                        const mdBody = document.querySelector('.modal-body');
                        if (mdBody) {
                            mdBody.innerHTML = `
                                <div class="invite-success-wrap">
                                    <div class="invite-success-icon">
                                        <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>
                                    </div>
                                    <h3 class="invite-success-title">Invite Created!</h3>
                                    <p class="invite-success-text">${
                                        emailSent
                                            ? `Invitation sent to <strong>${esc(email)}</strong>. You can also copy the direct invite link below.`
                                            : `Invite link created for <strong>${esc(email)}</strong>, but the email was not sent.${emailError ? `<br><span class="admin-muted">${esc(emailError)}</span>` : ''}`
                                    }</p>
                                    
                                    <div class="invite-link-box">
                                        <input type="text" readonly class="invite-link-field" value="${esc(link)}" id="invite-link-field">
                                        <button class="btn btn-primary invite-copy-btn" id="copy-invite-link">Copy Link</button>
                                    </div>
                                </div>
                            `;
                            
                            // Bind the copy button
                            document.getElementById('copy-invite-link').addEventListener('click', () => {
                                Components.copyText(link).then(() => {
                                    Components.toast('Link copied to clipboard!', 'success');
                                    document.getElementById('copy-invite-link').textContent = 'Copied!';
                                    setTimeout(() => document.getElementById('copy-invite-link').textContent = 'Copy Link', 2000);
                                }).catch(() => {
                                    Components.toast('Copy failed. Select the link and copy it manually.', 'error');
                                });
                            });
                            
                            // Hide the original action buttons except close
                            const footerBtns = document.querySelectorAll('.modal-footer .btn');
                            footerBtns.forEach(b => {
                                if (b.textContent === 'Generating...' || b.textContent === 'Generate Link') b.style.display = 'none';
                                if (b.textContent === 'Close') { b.classList.add('btn-primary'); b.classList.remove('btn-secondary'); b.textContent = 'Done'; }
                            });
                        }
                    } catch (err) {
                        if (actionBtn) {
                            actionBtn.disabled = false;
                            actionBtn.textContent = 'Generate Link';
                        }
                        Components.toast(err.message || 'Failed to send invite', 'error');
                    }
                },
            },
        ]);

        document.querySelector('.modal')?.classList.add('invite-modal-shell');

        setTimeout(() => {
            document.querySelectorAll('[data-invite-action]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const idx = asNumber(btn.getAttribute('data-idx'), -1);
                    if (idx < 0) return;
                    const pendingList = state.invites.filter((x) => x.status === 'pending');
                    const row = pendingList[idx];
                    if (!row) return;
                    const inviteAction = btn.getAttribute('data-invite-action');
                    if (inviteAction === 'copy') {
                        const link = `${window.location.origin}?invite=${encodeURIComponent(row.code || '')}`;
                        Components.copyText(link).then(() => {
                            Components.toast('Invite link copied', 'success');
                            btn.textContent = 'Copied!';
                            setTimeout(() => { btn.textContent = 'Copy Link'; }, 1600);
                        }).catch(() => {
                            Components.toast('Copy failed. Open the invite and select the link manually.', 'error');
                        });
                        return;
                    }
                    if (inviteAction === 'resend') {
                        const eCfg = state.settingsDraft?.email || {};
                        API.admin.resendInvite({
                            email: row.email,
                            code: row.code,
                            role: row.role || 'user',
                            quota_bytes: (Number(row.quota || 10) * 1073741824),
                            message: row.message || '',
                            smtp_server: eCfg.smtp_server || '',
                            smtp_port: parseInt(eCfg.smtp_port, 10) || 0,
                            smtp_user: eCfg.smtp_user || '',
                            smtp_pass: eCfg.smtp_pass || '',
                            from_address: eCfg.from_address || '',
                            from_name: eCfg.from_name || '',
                            tls: Boolean(eCfg.tls),
                        }).then(() => {
                            Components.toast(`Invite resent to ${row.email}`, 'success');
                        }).catch((err) => {
                            Components.toast(err?.message || 'Failed to resend invite', 'error');
                        });
                    } else if (inviteAction === 'cancel') {
                        if (!row.id) {
                            Components.toast('Invite id missing', 'error');
                            return;
                        }
                        API.admin.deleteInvite(row.id).then(async () => {
                            Components.toast('Invite cancelled', 'success');
                            await hydrateData();
                            Components.hideModal();
                            openInviteModal();
                        }).catch((err) => {
                            Components.toast(err?.message || 'Failed to cancel invite', 'error');
                        });
                    }
                });
            });
        }, 0);
    }

    function downloadTextFile(content, name, mime = 'text/plain') {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function jumpToElement(id) {
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function bindSectionEvents() {
        const root = document.getElementById('admin-shell') || getSectionRoot();
        if (!root) return;

        root.querySelectorAll('[data-admin-tip]').forEach((circle) => {
            const tooltip = document.getElementById('admin-chart-tooltip');
            if (!tooltip) return;
            circle.addEventListener('mouseenter', (e) => {
                tooltip.textContent = circle.getAttribute('data-admin-tip') || '';
                tooltip.classList.remove('hidden');
                const rect = e.target.getBoundingClientRect();
                tooltip.style.left = `${rect.left + window.scrollX + 12}px`;
                tooltip.style.top = `${rect.top + window.scrollY - 24}px`;
            });
            circle.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
        });

        root.querySelectorAll('[data-admin-action]').forEach((btn) => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                const action = btn.getAttribute('data-admin-action');
                const userId = btn.getAttribute('data-user-id') || '';

                if (action === 'users-filter') {
                    state.usersFilter = btn.getAttribute('data-filter') || 'all';
                    state.usersPage = 1;
                    renderSection();
                    return;
                }

                if (action === 'toggle-user-select') {
                    if (btn.checked) state.userSelection.add(userId);
                    else state.userSelection.delete(userId);
                    renderSection();
                    return;
                }

                if (action === 'toggle-all-users') {
                    const check = btn.checked;
                    const filtered = state.users.filter((u) => {
                        if (state.usersFilter === 'admin') return String(u.role || '').toLowerCase() === 'admin';
                        if (state.usersFilter === 'active') return getUserStatus(u) === 'active';
                        if (state.usersFilter === 'suspended') return getUserStatus(u) === 'suspended';
                        return true;
                    });
                    filtered.forEach((u) => {
                        if (check) state.userSelection.add(u.id);
                        else state.userSelection.delete(u.id);
                    });
                    renderSection();
                    return;
                }

                if (action === 'toggle-user-menu') {
                    const next = state.usersMenuOpen === userId ? '' : userId;
                    closeAllRowMenus();
                    state.usersMenuOpen = next;
                    if (next) {
                        const menu = document.getElementById(`user-menu-${next}`);
                        menu?.classList.remove('hidden');
                    }
                    return;
                }

                if (['open-user-drawer', 'change-role', 'reset-password', 'adjust-quota', 'toggle-suspend', 'delete-user'].includes(action)) {
                    if (action === 'open-user-drawer') {
                        state.drawerUserId = userId;
                        state.drawerBreakdown = null;
                        renderSection();
                        API.admin.storageBreakdown(userId)
                            .then((res) => {
                                if (state.drawerUserId !== userId) return;
                                state.drawerBreakdown = res?.breakdown || null;
                                renderSection();
                            })
                            .catch(() => {
                                if (state.drawerUserId !== userId) return;
                                state.drawerBreakdown = null;
                            });
                        return;
                    }
                    await handleUserAction(action, userId);
                    return;
                }

                if (action === 'close-user-drawer') {
                    state.drawerUserId = '';
                    state.drawerBreakdown = null;
                    renderSection();
                    return;
                }

                if (action === 'toggle-inline-edit') {
                    const form = document.getElementById('drawer-edit-form');
                    form?.classList.toggle('hidden');
                    return;
                }

                if (action === 'save-inline-edit') {
                    const user = userById(userId);
                    if (!user) return;
                    const name = String(document.getElementById('drawer-name')?.value || '').trim();
                    const email = String(document.getElementById('drawer-email')?.value || '').trim();
                    const role = String(document.getElementById('drawer-role')?.value || 'user').toLowerCase();
                    const quotaGb = Math.max(1, asNumber(document.getElementById('drawer-quota')?.value, 10));
                    const email2fa = Boolean(document.getElementById('drawer-2fa')?.checked);
                    if (!name || !email.includes('@')) {
                        Components.toast('Please fill valid name and e-mail', 'error');
                        return;
                    }
                    await API.admin.updateUser(userId, {
                        username: name,
                        email,
                        role,
                        quota_bytes: Math.round(quotaGb * (1024 ** 3)),
                        email_2fa_enabled: email2fa,
                    }).catch((err) => {
                        Components.toast(err.message, 'error');
                        throw err;
                    });
                    Components.toast('User updated', 'success');
                    await load('users');
                    state.drawerUserId = userId;
                    try {
                        const res = await API.admin.storageBreakdown(userId);
                        state.drawerBreakdown = res?.breakdown || null;
                    } catch (_) {
                        state.drawerBreakdown = null;
                    }
                    renderSection();
                    return;
                }

                if (action === 'open-invite-modal') {
                    openInviteModal();
                    return;
                }

                if (action === 'bulk-suspend') {
                    try {
                        await Promise.all([...state.userSelection].map((id) => API.admin.updateUser(id, { suspended: true })));
                        Components.toast('Selected users suspended', 'success');
                        state.userSelection.clear();
                        await load(state.section);
                    } catch (err) {
                        Components.toast(err?.message || 'Failed to suspend users', 'error');
                    }
                    return;
                }

                if (action === 'bulk-delete') {
                    const ok = await Components.confirm(
                        'Delete selected users',
                        'This permanently deletes the selected accounts and all of their files, folders, and devices. This cannot be undone.',
                        'Delete',
                    );
                    if (!ok) return;
                    let deleted = 0;
                    const failures = [];
                    for (const id of state.userSelection) {
                        try {
                            await API.admin.deleteUser(id);
                            deleted += 1;
                        } catch (err) {
                            failures.push(err?.message || 'failed');
                        }
                    }
                    state.userSelection.clear();
                    await load('users');
                    if (failures.length && deleted === 0) {
                        Components.toast(failures[0], 'error');
                    } else if (failures.length) {
                        Components.toast(`Deleted ${deleted}; ${failures.length} failed (${failures[0]})`, 'warning');
                    } else {
                        Components.toast(`Deleted ${deleted} user(s) and their files`, 'success');
                    }
                    return;
                }

                if (action === 'bulk-role') {
                    const role = await Components.prompt('New role for selected users', 'user');
                    if (!role) return;
                    for (const id of state.userSelection) {
                        await API.admin.updateUser(id, { role: role.toLowerCase() }).catch(() => {});
                    }
                    Components.toast('Role changed for selected users', 'success');
                    await load('users');
                    return;
                }

                if (action === 'bulk-quota') {
                    const quota = await promptQuota('New quota', 10);
                    if (!quota) return;
                    const bytes = Math.round(Math.max(1, asNumber(quota, 10)) * (1024 ** 3));
                    for (const id of state.userSelection) {
                        await API.admin.updateUser(id, { quota_bytes: bytes }).catch(() => {});
                    }
                    Components.toast('Quota updated for selected users', 'success');
                    await load('users');
                    return;
                }

                if (action === 'users-prev' || action === 'users-next' || action === 'users-per-page') {
                    if (action === 'users-prev') state.usersPage -= 1;
                    if (action === 'users-next') state.usersPage += 1;
                    if (action === 'users-per-page') {
                        state.usersPerPage = asNumber(btn.value, 25);
                        state.usersPage = 1;
                    }
                    renderSection();
                    return;
                }
                if (action === 'users-goto-page') {
                    state.usersPage = asNumber(btn.getAttribute('data-page'), 1);
                    renderSection();
                    return;
                }

                if (action === 'storage-users-prev' || action === 'storage-users-next' || action === 'storage-users-per-page') {
                    if (action === 'storage-users-prev') state.storageUserPage -= 1;
                    if (action === 'storage-users-next') state.storageUserPage += 1;
                    if (action === 'storage-users-per-page') {
                        state.storageUserPerPage = asNumber(btn.value, 25);
                        state.storageUserPage = 1;
                    }
                    renderSection();
                    return;
                }
                if (action === 'storage-users-goto-page') {
                    state.storageUserPage = asNumber(btn.getAttribute('data-page'), 1);
                    renderSection();
                    return;
                }

                if (action === 'delete-large-file') {
                    const fileId = btn.getAttribute('data-file-id');
                    const ok = await Components.confirm('Delete large file', 'This operation is irreversible.', 'Delete');
                    if (!ok) return;
                    await API.files.delete(fileId).catch((err) => Components.toast(err.message, 'error'));
                    Components.toast('File moved to trash', 'success');
                    await load('storage');
                    return;
                }

                if (action === 'cleanup-trash') {
                    const ok = await Components.confirm('Empty trash older than 30 days', 'Trashed files and folders older than 30 days will be permanently deleted.', 'Empty');
                    if (!ok) return;
                    try {
                        const res = await API.admin.purgeTrash(30);
                        Components.toast(formatPurgeTrashResult(res), 'success');
                        await load('storage');
                    } catch (err) {
                        Components.toast(err?.message || 'Trash cleanup failed', 'error');
                    }
                    return;
                }
                if (action === 'cleanup-duplicates') {
                    const ok = await Components.confirm('Remove duplicate files', 'In each duplicate group the newest copy is kept; older copies are permanently deleted.', 'Remove');
                    if (!ok) return;
                    try {
                        const res = await API.admin.purgeDuplicates();
                        Components.toast(`Removed ${res.removed_files || 0} duplicate file(s)`, 'success');
                        await load('storage');
                    } catch (err) {
                        Components.toast(err?.message || 'Duplicate cleanup failed', 'error');
                    }
                    return;
                }
                if (action === 'cleanup-notify') {
                    return;
                }

                if (action === 'apply-activity-filters') {
                    const select = document.getElementById('admin-activity-users');
                    const selected = Array.from(select?.selectedOptions || []).map((o) => o.value);
                    state.activityFilters.users = selected;
                    const nextAction = String(document.getElementById('admin-activity-action')?.value || 'all');
                    state.activityFilters.action = ['all', 'login', 'failed_login'].includes(nextAction) ? nextAction : 'all';
                    state.activityFilters.from = String(document.getElementById('admin-activity-from')?.value || '');
                    state.activityFilters.to = String(document.getElementById('admin-activity-to')?.value || '');
                    state.activityPage = 1;
                    renderSection();
                    return;
                }

                if (action === 'toggle-activity-row') {
                    const rowId = btn.getAttribute('data-activity-id');
                    if (!rowId) return;
                    if (state.expandedActivity.has(rowId)) state.expandedActivity.delete(rowId);
                    else state.expandedActivity.add(rowId);
                    renderSection();
                    return;
                }

                if (action === 'activity-prev' || action === 'activity-next' || action === 'activity-per-page') {
                    if (action === 'activity-prev') state.activityPage -= 1;
                    if (action === 'activity-next') state.activityPage += 1;
                    if (action === 'activity-per-page') {
                        state.activityPerPage = asNumber(btn.value, 25);
                        state.activityPage = 1;
                    }
                    renderSection();
                    return;
                }
                if (action === 'activity-goto-page') {
                    state.activityPage = asNumber(btn.getAttribute('data-page'), 1);
                    renderSection();
                    return;
                }
                if (action === 'clear-activity-filter') {
                    const key = btn.getAttribute('data-filter-key');
                    if (key === 'action') state.activityFilters.action = 'all';
                    if (key === 'from') state.activityFilters.from = '';
                    if (key === 'to') state.activityFilters.to = '';
                    renderSection();
                    return;
                }
                if (action === 'toggle-live') {
                    state.activityLive = btn.checked;
                    if (state.liveTimer) {
                        clearInterval(state.liveTimer);
                        state.liveTimer = null;
                    }
                    if (state.activityLive) {
                        state.liveTimer = setInterval(async () => {
                            const latest = await API.admin.activity(1, 30).catch(() => ({ activities: [] }));
                            const fresh = Array.isArray(latest.activities) ? latest.activities : [];
                            if (fresh.length) {
                                state.activities = fresh;
                                renderSection();
                            }
                        }, 6000);
                    }
                    renderSection();
                    return;
                }

                if (action === 'export-activity-csv') {
                    const rows = filteredActivityList();
                    const csv = ['timestamp,user,action,target,ip,device,status']
                        .concat(rows.map((r) => [r.created_at, r.username, r.action, r.target_name, r.ip, r.device, r.status].map((x) => `"${String(x || '').replace(/"/g, '""')}"`).join(',')))
                        .join('\n');
                    downloadTextFile(csv, `activity-${Date.now()}.csv`, 'text/csv');
                    return;
                }

                if (action === 'export-activity-json') {
                    const rows = filteredActivityList();
                    downloadTextFile(JSON.stringify(rows, null, 2), `activity-${Date.now()}.json`, 'application/json');
                    return;
                }

                if (action === 'jump-failed') {
                    jumpToElement('security-failed');
                    return;
                }
                if (action === 'jump-ip-list') {
                    jumpToElement('security-ip-list');
                    return;
                }

                if (action === 'revoke-all-sessions') {
                    const ok = await Components.confirm('Revoke all sessions', 'All active sessions will be terminated. This cannot be undone.', 'Revoke');
                    if (!ok) return;
                    try {
                        await API.admin.revokeAllSessions();
                        Components.toast('All sessions revoked', 'success');
                    } catch (err) {
                        Components.toast(err?.message || 'Failed to revoke sessions', 'error');
                    }
                    return;
                }

                if (action === 'revoke-session') {
                    Components.toast('Per-session revoke is not available yet. Use Revoke all.', 'info');
                    return;
                }

                if (action === 'toggle-ip-block' || action === 'toggle-block-ip') {
                    const ip = btn.getAttribute('data-ip');
                    if (!ip) return;
                    const blocked = btn.type === 'checkbox' ? btn.checked : btn.getAttribute('data-blocked') === '1';
                    const list = state.settingsDraft.security.blocklist || [];
                    if (blocked) {
                        if (!list.some((x) => x.ip === ip)) {
                            state.settingsDraft.security.blocklist.push({ ip, by: getCurrentUser().username || 'admin', at: nowISO(), note: 'Blocked from security panel' });
                        }
                    } else {
                        state.settingsDraft.security.blocklist = list.filter((x) => x.ip !== ip);
                    }
                    try {
                        await persistSettingsNow({ silent: true });
                        Components.toast('IP blocklist updated', 'success');
                    } catch (err) {
                        Components.toast(err?.message || 'Failed to save blocklist', 'error');
                    }
                    renderSection();
                    return;
                }

                if (action === 'switch-list-tab') {
                    state.listTab = btn.getAttribute('data-tab') || 'allowlist';
                    renderSection();
                    return;
                }

                if (action === 'add-ip-entry') {
                    const ip = String(document.getElementById('admin-ip-input')?.value || '').trim();
                    const note = String(document.getElementById('admin-ip-note')?.value || '').trim();
                    const isIpLike = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
                    if (!isIpLike) {
                        Components.toast('Enter a valid IPv4 address', 'error');
                        return;
                    }
                    const key = state.listTab === 'allowlist' ? 'allowlist' : 'blocklist';
                    const list = state.settingsDraft.security[key] || [];
                    if (list.some((x) => x.ip === ip)) {
                        Components.toast('IP already exists in list', 'warning');
                        return;
                    }
                    list.push({ ip, by: getCurrentUser().username || 'admin', at: nowISO(), note });
                    state.settingsDraft.security[key] = list;
                    try {
                        await persistSettingsNow({ silent: true });
                        Components.toast('IP list updated', 'success');
                    } catch (err) {
                        Components.toast(err?.message || 'Failed to save IP list', 'error');
                    }
                    renderSection();
                    return;
                }

                if (action === 'remove-ip-entry') {
                    const tab = btn.getAttribute('data-tab');
                    const ip = btn.getAttribute('data-ip');
                    if (!tab || !ip) return;
                    state.settingsDraft.security[tab] = (state.settingsDraft.security[tab] || []).filter((x) => x.ip !== ip);
                    try {
                        await persistSettingsNow({ silent: true });
                        Components.toast('IP list updated', 'success');
                    } catch (err) {
                        Components.toast(err?.message || 'Failed to save IP list', 'error');
                    }
                    renderSection();
                    return;
                }

                if (action === 'toggle-require-2fa') {
                    const next = btn.type === 'checkbox' ? !btn.checked : Boolean(btn.checked);
                    state.settingsDraft.security.require_2fa = next;
                    try {
                        await persistSettingsNow({ silent: true });
                        Components.toast('2FA requirement saved', 'success');
                    } catch (err) {
                        Components.toast(err?.message || 'Failed to save 2FA setting', 'error');
                    }
                    renderSection();
                    return;
                }

                if (action === 'send-2fa-reminder') {
                    try {
                        const result = await API.admin.send2FAReminder();
                        const sent = Number(result?.sent || 0);
                        Components.toast(sent > 0 ? `2FA reminders sent to ${sent} user(s)` : (result?.message || 'No reminders sent'), sent > 0 ? 'success' : 'info');
                    } catch (err) {
                        Components.toast(err?.message || 'Failed to send reminders', 'error');
                    }
                    return;
                }

                if (action === 'rotate-keys') {
                    const ok = await Components.confirm('Record key rotation', 'This only saves a rotation timestamp in settings. It does not re-encrypt stored files yet.', 'Record');
                    if (!ok) return;
                    state.settingsDraft.security.last_key_rotation = nowISO();
                    try {
                        await persistSettingsNow({ silent: true });
                        Components.toast('Key rotation timestamp saved', 'success');
                    } catch (err) {
                        Components.toast(err?.message || 'Failed to save setting', 'error');
                    }
                    renderSection();
                    return;
                }

                if (action === 'switch-settings-tab') {
                    state.settingsTab = btn.getAttribute('data-tab') || 'general';
                    renderSection();
                    return;
                }

                if (action === 'add-type-chip') {
                    if (state.settingsDraft.general.allowed_types_unlimited) return;
                    const input = document.getElementById('new-type-chip');
                    const value = String(input?.value || '').replace(/^\./, '').trim().toLowerCase();
                    if (!value) return;
                    if (!state.settingsDraft.general.allowed_types.includes(value)) {
                        state.settingsDraft.general.allowed_types.push(value);
                        state.settingsDirty = true;
                        validateSettings();
                    }
                    renderSection();
                    return;
                }

                if (action === 'remove-type-chip') {
                    if (state.settingsDraft.general.allowed_types_unlimited) return;
                    const type = btn.getAttribute('data-type');
                    state.settingsDraft.general.allowed_types = state.settingsDraft.general.allowed_types.filter((x) => x !== type);
                    state.settingsDirty = true;
                    validateSettings();
                    renderSection();
                    return;
                }

                if (action === 'send-test-email') {
                    const target = String(document.getElementById('test-email-input')?.value || '').trim();
                    if (!target.includes('@')) {
                        Components.toast('Enter valid target e-mail', 'error');
                        return;
                    }
                    
                    const btn = e.target.closest('button');
                    const originalHtml = btn.innerHTML;
                    btn.innerHTML = '<span class="spinner" style="width: 14px; height: 14px; margin-right: 6px;"></span> Sending...';
                    btn.disabled = true;
                    
                    const eConfig = state.settingsDraft.email;
                    fetch('/api/v1/admin/test-email', {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${localStorage.getItem('fd_access_token') || ''}`
                        },
                        body: JSON.stringify({
                            to_address: target,
                            smtp_server: eConfig.smtp_server,
                            smtp_port: parseInt(eConfig.smtp_port, 10),
                            smtp_user: eConfig.smtp_user,
                            smtp_pass: eConfig.smtp_pass,
                            from_address: eConfig.from_address,
                            from_name: eConfig.from_name,
                            tls: eConfig.tls
                        })
                    }).then(async (res) => {
                        const data = await res.json().catch(() => ({}));
                        if (!res.ok) throw new Error(data.error || 'Failed to send test email');
                        
                        const resultDiv = document.getElementById('test-email-result');
                        if (resultDiv) {
                            resultDiv.style.display = 'block';
                            resultDiv.style.color = '#188038';
                            resultDiv.style.backgroundColor = '#E6F4EA';
                            resultDiv.style.padding = '8px 12px';
                            resultDiv.style.borderRadius = '4px';
                            resultDiv.innerHTML = `<strong>Success!</strong> The test email was successfully delivered to ${esc(target)}.`;
                        }
                        Components.toast(`Test email sent to ${target}`, 'success');
                    }).catch((err) => {
                        const resultDiv = document.getElementById('test-email-result');
                        if (resultDiv) {
                            resultDiv.style.display = 'block';
                            resultDiv.style.color = '#D93025';
                            resultDiv.style.backgroundColor = '#FCE8E6';
                            resultDiv.style.padding = '8px 12px';
                            resultDiv.style.borderRadius = '4px';
                            resultDiv.innerHTML = `<strong>Error:</strong> ${esc(err.message)}`;
                        }
                        Components.toast(err.message, 'error');
                    }).finally(() => {
                        btn.innerHTML = originalHtml;
                        btn.disabled = false;
                    });
                    return;
                }

                if (action === 'run-backup-now') {
                    const progress = document.getElementById('backup-progress-fill');
                    if (progress) progress.style.width = '20%';
                    try {
                        const res = await fetch('/api/v1/admin/backup/run', {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${localStorage.getItem('fd_access_token') || ''}`,
                            },
                        });
                        const data = await res.json().catch(() => ({}));
                        if (!res.ok) throw new Error(data.error || 'Backup failed');
                        if (progress) progress.style.width = '100%';
                        const list = await API.admin.listBackups().catch(() => ({ backups: [] }));
                        state.backups = Array.isArray(list.backups) ? list.backups : [];
                        Components.toast('Settings backup created', 'success');
                        renderSection();
                    } catch (err) {
                        if (progress) progress.style.width = '0%';
                        Components.toast(err.message || 'Backup failed', 'error');
                    }
                    return;
                }

                if (action === 'backup-download') {
                    const filename = btn.getAttribute('data-backup-filename');
                    if (!filename) return;
                    try {
                        await API.admin.downloadBackup(filename);
                        Components.toast('Download started', 'success');
                    } catch (err) {
                        Components.toast(err?.message || 'Download failed', 'error');
                    }
                    return;
                }
                if (action === 'backup-restore') {
                    const filename = btn.getAttribute('data-backup-filename');
                    if (!filename) return;
                    const ok = await Components.confirm('Restore settings backup', 'This will merge saved admin settings into the server. Continue?', 'Restore');
                    if (!ok) return;
                    try {
                        await API.admin.restoreBackup(filename);
                        const data = await fetchServerSettings();
                        if (data) {
                            applyServerSettings(data);
                        }
                        Components.toast('Settings restored from backup', 'success');
                        renderSection();
                    } catch (err) {
                        Components.toast(err?.message || 'Restore failed', 'error');
                    }
                    return;
                }
                if (action === 'backup-delete') {
                    const filename = btn.getAttribute('data-backup-filename');
                    if (!filename) return;
                    const ok = await Components.confirm('Delete backup', `Delete ${filename}?`, 'Delete');
                    if (!ok) return;
                    try {
                        await API.admin.deleteBackup(filename);
                        state.backups = state.backups.filter((b) => b.filename !== filename);
                        Components.toast('Backup deleted', 'success');
                        renderSection();
                    } catch (err) {
                        Components.toast(err?.message || 'Delete failed', 'error');
                    }
                    return;
                }

                if (action === 'logo-upload-prompt') {
                    Components.toast('Logo uploader opened (drag & drop supported in full settings backend)', 'info');
                    return;
                }

                if (action === 'cancel-settings') {
                    state.settingsDraft = clone(state.settings);
                    state.settingsDirty = false;
                    state.settingsErrors = {};
                    renderSection();
                    return;
                }

                if (action === 'save-settings') {
                    if (!validateSettings()) {
                        renderSection();
                        return;
                    }
                    try {
                        await persistSettingsNow();
                    } catch (e) {
                        Components.toast(e?.message || 'Settings save failed', 'error');
                        return;
                    }
                    renderSection();
                    return;
                }

                if (action === 'danger-clear-trash') {
                    const ok = await Components.confirm('Clear all trash', 'This cannot be undone and all trashed files and folders will be permanently deleted.', 'Clear');
                    if (!ok) return;
                    try {
                        const res = await API.admin.purgeTrash(0);
                        Components.toast(formatPurgeTrashResult(res, 'Cleared'), 'success');
                        await load('storage');
                    } catch (err) {
                        Components.toast(err?.message || 'Failed to clear trash', 'error');
                    }
                    return;
                }

                if (action === 'danger-reset-sessions') {
                    const ok = await Components.confirm('Reset all user sessions', 'All users will be logged out immediately.', 'Reset');
                    if (!ok) return;
                    try {
                        await API.admin.revokeAllSessions();
                        Components.toast('All user sessions reset', 'success');
                    } catch (err) {
                        Components.toast(err?.message || 'Failed to reset sessions', 'error');
                    }
                    return;
                }

                if (action === 'danger-wipe-data') {
                    const confirmWord = String(document.getElementById('danger-confirm-input')?.value || '').trim();
                    if (confirmWord !== 'WIPE') {
                        Components.toast('Type WIPE to proceed', 'warning');
                        return;
                    }
                    const finalOk = await Components.confirm('Final confirmation', 'All files and user data will be irreversibly destroyed. Your admin account and settings are kept.', 'Wipe');
                    if (!finalOk) return;
                    try {
                        await API.admin.wipeAllData();
                        Components.toast('All data wiped', 'success');
                        history.pushState(null, '', '/#/files');
                        window.dispatchEvent(new Event('popstate'));
                    } catch (err) {
                        Components.toast(err?.message || 'Wipe failed', 'error');
                    }
                    return;
                }
            });
        });

        root.querySelectorAll('select[data-admin-action]').forEach((sel) => {
            sel.addEventListener('change', () => {
                sel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            });
        });

        root.querySelectorAll('[data-setting]').forEach((input) => {
            const isCheckbox = input.type === 'checkbox';
            const handler = () => {
                const key = input.getAttribute('data-setting');
                const value = isCheckbox ? Boolean(input.checked) : input.value;
                const previous = getSetting(key);
                if (typeof previous === 'number') {
                    setSetting(key, asNumber(value, previous));
                } else {
                    setSetting(key, value);
                }
                state.settingsDirty = JSON.stringify(state.settingsDraft) !== JSON.stringify(state.settings);
                validateSettings();
                if (key === 'general.allowed_types_unlimited' && state.section === 'settings' && state.settingsTab === 'general') {
                    renderSection();
                    return;
                }
                if (state.section === 'settings') {
                    const saveBtn = document.querySelector('[data-admin-action="save-settings"]');
                    if (saveBtn) saveBtn.disabled = !state.settingsDirty || Object.keys(state.settingsErrors).length > 0;
                }
            };
            input.addEventListener('input', handler);
            input.addEventListener('change', handler);
        });

        const search = document.getElementById('admin-users-search');
        if (search) {
            search.addEventListener('input', () => {
                state.usersSearch = search.value;
                state.usersPage = 1;
                renderSection();
            });
        }

        const typeInput = document.getElementById('new-type-chip');
        if (typeInput) {
            typeInput.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                if (state.settingsDraft.general.allowed_types_unlimited) return;
                e.preventDefault();
                const value = String(typeInput.value || '').replace(/^\./, '').trim().toLowerCase();
                if (!value) return;
                if (!state.settingsDraft.general.allowed_types.includes(value)) {
                    state.settingsDraft.general.allowed_types.push(value);
                    state.settingsDirty = true;
                    validateSettings();
                }
                renderSection();
            });
        }

        const wipeInput = document.getElementById('danger-confirm-input');
        const wipeBtn = document.getElementById('danger-wipe-btn');
        if (wipeInput && wipeBtn) {
            const updateWipe = () => {
                wipeBtn.disabled = String(wipeInput.value || '').trim() !== 'WIPE';
            };
            wipeInput.addEventListener('input', updateWipe);
            updateWipe();
        }

        const shell = document.getElementById('admin-shell');
        shell?.addEventListener('click', (e) => {
            if (!e.target.closest('[data-admin-action="toggle-user-menu"]') && !e.target.closest('.gd-popup-menu')) {
                closeAllRowMenus();
            }
        });
    }

    return {
        load,
    };
})();
