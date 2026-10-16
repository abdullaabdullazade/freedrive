// Native web localization. English source phrases are the fallback catalog.
const I18n = (() => {
    const languages = Object.freeze({ en: 'English', 'zh-CN': '简体中文' });
    let language = 'en';

    function normalize(value) {
        const tag = String(value || '').trim().replace(/_/g, '-').toLowerCase();
        if (tag === 'zh' || tag === 'zh-cn' || tag === 'zh-sg' || /^zh-hans(?:-|$)/.test(tag)) return 'zh-CN';
        if (/^en(?:-|$)/.test(tag)) return 'en';
        return null;
    }

    function resolve(siteLanguage) {
        return normalize(siteLanguage) || 'en';
    }

    function t(key, values = {}) {
        const source = String(key ?? '');
        const catalog = globalThis.FD_LOCALES?.[language];
        const message = catalog && Object.hasOwn(catalog, source) ? catalog[source] : source;
        // Callback replacement preserves literal $&, $', and $` in names or error messages.
        return message.replace(/\{(\d+)\}/g, (match, id) => values[id] == null ? match : String(values[id]));
    }

    function apply(root = document) {
        root.querySelectorAll('[data-i18n]').forEach((element) => {
            element.textContent = t(element.dataset.i18n);
        });
        ['title', 'placeholder', 'aria-label', 'content'].forEach((attribute) => {
            root.querySelectorAll(`[data-i18n-${attribute}]`).forEach((element) => {
                element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
            });
        });
    }

    async function init() {
        let siteLanguage = null;
        try {
            const response = await fetch('/api/v1/public/config', { signal: AbortSignal.timeout(2500) });
            if (response.ok) siteLanguage = (await response.json()).language;
        } catch { /* A missing endpoint or offline server must never block sign-in. */ }
        language = resolve(siteLanguage);
        // Only non-English sites download a catalog; English uses the source phrases.
        if (language !== 'en' && !globalThis.FD_LOCALES?.[language]) {
            try {
                await new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = `/locales/${language}.js`;
                    script.onload = resolve;
                    script.onerror = reject;
                    document.head.appendChild(script);
                });
            } catch { /* Fall back to English rather than blocking sign-in. */ }
            if (!globalThis.FD_LOCALES?.[language]) language = 'en';
        }
        document.documentElement.lang = language;
        apply();
    }

    function relative(value, unit) {
        return new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(value, unit);
    }

    function error(value) {
        const message = String(value ?? '');
        const translated = t(message);
        if (translated !== message || language === 'en') return translated;
        const statusError = /^(Request failed|Upload failed|Chunk upload failed|Download failed) \((\d+)\)$/.exec(message);
        if (statusError) return t(statusError[1] + ' ({0})', [statusError[2]]);
        for (const prefix of ['Upload rolled back because its encryption key could not be synced: ', 'Failed to load: ']) {
            if (message.startsWith(prefix)) return t(prefix + '{0}', [error(message.slice(prefix.length))]);
        }
        // These known API messages append technical details after a fixed prefix.
        for (const prefix of ['failed to send email: ', 'failed to create backup: ', 'registration failed: ', 'wipe failed: ']) {
            if (message.startsWith(prefix)) return t(prefix) + error(message.slice(prefix.length));
        }
        if (message.startsWith('quota exceeded:')) return t('quota exceeded') + '：' + message.slice('quota exceeded:'.length).trim();
        // JSON.parse messages differ per browser; keep only the position when one is given.
        if (/JSON/.test(message) && /Unexpected|Expected|not valid|Bad control|Unterminated/i.test(message)) {
            const lineColumn = /line (\d+) column (\d+)/i.exec(message);
            if (lineColumn) return t('JSON syntax error (line {0}, column {1})', { 0: lineColumn[1], 1: lineColumn[2] });
            const position = /position (\d+)/i.exec(message);
            return position ? t('JSON syntax error at position {0}', { 0: position[1] }) : t('JSON syntax error');
        }
        // Go/OS error details end in a fixed phrase ("mkdir /path: permission denied"); keep the path.
        const systemError = /^(.*?)(?::\s*|\s+)(permission denied|no such file or directory|file exists|no space left on device|read-only file system|connection refused|connection reset by peer|i\/o timeout|network is unreachable|no such host|context deadline exceeded|EOF|broken pipe|too many open files|operation not permitted)$/i.exec(message);
        if (systemError) return (systemError[1] ? systemError[1] + '：' : '') + t(systemError[2].toLowerCase());
        return message;
    }

    // Server-generated device names ("Chrome on Linux", "Desktop app"); custom names are kept.
    function device(value) {
        const name = String(value ?? '');
        if (language === 'en') return name;
        if (name === 'Desktop app' || name === 'Mobile app') return t(name);
        const match = /^(Browser|Edge|Chrome|Firefox|Safari|Opera) on (Unknown OS|Windows|macOS|Android|iOS|Linux)$/.exec(name);
        if (!match) return name;
        return t('{0} on {1}', { 0: t(match[1]), 1: t(match[2]) });
    }

    function label(value, english = value) {
        const labels = {
            all: 'All', viewer: 'Viewer', commenter: 'Commenter', editor: 'Editor', owner: 'Owner', admin: 'Admin', user: 'User', guest: 'Guest',
            active: 'Active', suspended: 'Suspended', open: 'open', invite: 'Invite-only', closed: 'closed',
            light: 'light', dark: 'dark', system: 'system', daily: 'daily', weekly: 'weekly', monthly: 'monthly',
            pending: 'pending', approved: 'approved', rejected: 'rejected', cancelled: 'Cancelled',
            success: 'Success', failed: 'Failed', file: 'File', folder: 'Folder', never: 'Never',
            login: 'Login', failed_login: 'Failed login', upload: 'File upload', download: 'Download',
            delete: 'Delete', restore: 'Restore', create: 'create', rename: 'Rename', move: 'Move',
            copy: 'Copy', comment: 'Comment', unshare: 'unshare',
            share: 'Share', register: 'Create account', logout: 'Sign out',
        };
        const key = String(value || '');
        if (language === 'en') return String(english ?? '');
        return t(labels[key] || key);
    }

    // Sorting locale: undefined keeps the browser default for English; Chinese sorts by pinyin.
    return { t, error, init, apply, resolve, normalize, relative, label, device, languages, get language() { return language; }, get collation() { return language === 'en' ? undefined : language; } };
})();
