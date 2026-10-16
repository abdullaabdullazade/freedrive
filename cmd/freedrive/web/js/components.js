const Components = (() => {
    function toast(message, type = 'info', opts = {}) {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const el = document.createElement('div');
        el.className = `toast toast-${type}`;

        const msg = document.createElement('span');
        msg.className = 'toast-msg';
        msg.textContent = I18n.error(message);
        el.appendChild(msg);

        if (opts.actionText && typeof opts.onAction === 'function') {
            const action = document.createElement('button');
            action.className = 'toast-action';
            action.textContent = opts.actionText;
            action.addEventListener('click', () => {
                opts.onAction();
                removeToast(el);
            });
            el.appendChild(action);
        }

        container.appendChild(el);
        const timeout = typeof opts.duration === 'number' ? opts.duration : 4000;
        setTimeout(() => removeToast(el), timeout);
    }

    function removeToast(el) {
        if (!el || !el.parentElement) return;
        el.classList.add('toast-hide');
        setTimeout(() => el.remove(), 220);
    }

    function showModal(title, bodyHTML, buttons = []) {
        const overlay = document.getElementById('modal-overlay');
        if (!overlay) return;
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-body').innerHTML = bodyHTML;

        const footer = document.getElementById('modal-footer');
        footer.innerHTML = '';
        buttons.forEach((btn) => {
            const b = document.createElement('button');
            b.className = `btn ${btn.class || 'btn-secondary'}`;
            b.textContent = btn.text;
            b.addEventListener('click', async () => {
                if (btn.action) await btn.action();
                if (btn.close !== false) hideModal();
            });
            footer.appendChild(b);
        });

        overlay.classList.remove('hidden');
    }

    function hideModal() {
        document.getElementById('modal-overlay')?.classList.add('hidden');
    }

    function prompt(title, defaultValue = '', placeholder = '') {
        return new Promise((resolve) => {
            showModal(
                title,
                `<input id="prompt-input" style="width:100%;height:52px;padding:0 15px;border-radius:4px;border:1px solid #dadce0;background:#fff;color:#202124;font-size:16px;font-family:'Google Sans','Roboto',sans-serif;outline:none;box-sizing:border-box;transition:border-color .15s;" value="${escapeHtml(defaultValue)}" placeholder="${escapeHtml(placeholder)}" onfocus="this.style.borderColor='#1a73e8';this.style.borderWidth='2px'" onblur="this.style.borderColor='#dadce0';this.style.borderWidth='1px'">`,
                [
                    { text: I18n.t("Cancel"), action: () => resolve(null) },
                    { text: I18n.t('OK'), class: 'btn-primary', action: () => resolve(document.getElementById('prompt-input').value) },
                ]
            );
            setTimeout(() => {
                const i = document.getElementById('prompt-input');
                if (!i) return;
                i.focus();
                i.select();
                i.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !isComposing(e)) {
                        e.preventDefault();
                        resolve(i.value);
                        hideModal();
                    }
                });
            }, 10);
        });
    }

    function confirm(title, message, confirmText = I18n.t("Delete")) {
        return new Promise((resolve) => {
            showModal(title, `<p style="color:var(--fd-text-muted);font-size:13px;line-height:1.5;">${escapeHtml(message)}</p>`, [
                { text: I18n.t("Cancel"), action: () => resolve(false) },
                { text: confirmText, class: [I18n.t("Delete"), I18n.t("Delete forever")].includes(confirmText) ? 'btn-danger' : 'btn-primary', action: () => resolve(true) },
            ]);
        });
    }

    function formatSize(bytes) {
        const value = Number(bytes || 0);
        if (value <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const idx = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
        return `${(value / (1024 ** idx)).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
    }

    function formatDate(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        const now = new Date();
        const diff = now.getTime() - d.getTime();
        const minute = 60000;
        const hour = 60 * minute;
        const day = 24 * hour;
        if (diff < minute) return I18n.t("Just now");
        if (diff < hour) {
            const m = Math.floor(diff / minute);
            return I18n.t("{0} min ago", { 0: m });
        }
        if (diff < day) {
            const h = Math.floor(diff / hour);
            if (I18n.language === 'en') return `${h} ${h === 1 ? 'hr' : 'hrs'} ago`;
            return I18n.relative(-h, 'hour');
        }
        if (diff < day * 7) {
            const dd = Math.floor(diff / day);
            if (I18n.language === 'en') return `${dd} ${dd === 1 ? 'day' : 'days'} ago`;
            return I18n.relative(-dd, 'day');
        }
        return d.toLocaleDateString(I18n.language, { month: 'short', day: 'numeric', year: now.getFullYear() !== d.getFullYear() ? 'numeric' : undefined });
    }

    function formatAbsoluteDate(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        const datePart = d.toLocaleDateString(I18n.language, {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
        });
        const timePart = d.toLocaleTimeString(I18n.language, {
            hour: '2-digit',
            minute: '2-digit',
        });
        return I18n.t("{0} at {1}", { 0: datePart, 1: timePart });
    }

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function initials(name) {
        const src = String(name || 'U').trim();
        if (!src) return 'U';
        const parts = src.split(/\s+/);
        if (parts.length === 1) return parts[0][0].toUpperCase();
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    function uuid() {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();

        const bytes = new Uint8Array(16);
        if (window.crypto?.getRandomValues) {
            window.crypto.getRandomValues(bytes);
        } else {
            for (let i = 0; i < bytes.length; i += 1) {
                bytes[i] = Math.floor(Math.random() * 256);
            }
        }

        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;

        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    async function copyText(text) {
        const value = String(text || '');
        if (navigator.clipboard?.writeText && window.isSecureContext) {
            await navigator.clipboard.writeText(value);
            return;
        }

        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (!ok) throw new Error('Copy failed');
    }

    // True while an IME (Chinese, Japanese, Korean input) is composing text: Enter
    // picks a candidate and Escape cancels it, so neither should trigger app actions.
    function isComposing(e) {
        return Boolean(e?.isComposing) || e?.keyCode === 229;
    }

    // Decodes a text file: UTF-8 (BOM optional), UTF-16 with a BOM and, on Chinese sites,
    // GB18030/GBK, which Excel and Notepad use for Chinese CSV and TXT files on Windows.
    async function decodeText(blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
        if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
            if (I18n.language === 'zh-CN') {
                try { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); } catch { /* not GBK either */ }
            }
            return new TextDecoder('utf-8').decode(bytes);
        }
    }

    // Excel reads BOM-less CSV in the system code page, so non-ASCII CSV gets a UTF-8 BOM.
    function csvForExcel(text) {
        const value = String(text ?? '');
        return /[^\x00-\x7f]/.test(value) && !value.startsWith('\ufeff') ? `\ufeff${value}` : value;
    }

    function closeOnEscape() {
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || isComposing(e)) return;
            hideModal();
            document.getElementById('context-menu')?.classList.add('hidden');
            document.getElementById('share-modal-overlay')?.classList.add('hidden');
            document.getElementById('shortcuts-modal-overlay')?.classList.add('hidden');
            if (!FileManager.hasSelection?.()) {
                document.getElementById('details-panel')?.classList.add('hidden');
            }
        });
    }

    function init() {
        document.getElementById('modal-close')?.addEventListener('click', hideModal);
        document.getElementById('modal-overlay')?.addEventListener('click', (e) => {
            if (e.target === e.currentTarget) hideModal();
        });
        closeOnEscape();
    }

    return {
        isComposing,
        decodeText,
        csvForExcel,
        init,
        toast,
        showModal,
        hideModal,
        prompt,
        confirm,
        formatSize,
        formatDate,
        formatAbsoluteDate,
        escapeHtml,
        initials,
        uuid,
        copyText,
    };
})();
