const App = (() => {
    const USER_PREFS_KEY = 'fd_user_prefs';

    function getUserPrefs() {
        try {
            return JSON.parse(localStorage.getItem(USER_PREFS_KEY) || '{}') || {};
        } catch {
            return {};
        }
    }

    function setUserPrefs(next) {
        localStorage.setItem(USER_PREFS_KEY, JSON.stringify(next || {}));
    }

    function resolveAvatar(user, prefs) {
        const fromUser = String(user?.avatar_url || '').trim();
        if (fromUser) return fromUser;
        const fromPrefs = String(prefs?.profileAvatar || '').trim();
        if (fromPrefs) return fromPrefs;
        return String(localStorage.getItem('fd_profile_photo') || '').trim();
    }

    function syncAvatarCache(avatarUrl) {
        const prefs = getUserPrefs();
        const next = { ...prefs, profileAvatar: avatarUrl || '' };
        setUserPrefs(next);
        if (avatarUrl) {
            localStorage.setItem('fd_profile_photo', avatarUrl);
        } else {
            localStorage.removeItem('fd_profile_photo');
        }
    }

    function resizeAvatarDataURL(dataUrl, maxSize = 256, quality = 0.85) {
        return new Promise((resolve) => {
            if (!dataUrl || !String(dataUrl).startsWith('data:image/')) {
                resolve(dataUrl || '');
                return;
            }
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
                const w = Math.max(1, Math.round(img.width * scale));
                const h = Math.max(1, Math.round(img.height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    resolve(dataUrl);
                    return;
                }
                ctx.drawImage(img, 0, 0, w, h);
                try {
                    resolve(canvas.toDataURL('image/jpeg', quality));
                } catch {
                    resolve(dataUrl);
                }
            };
            img.onerror = () => resolve(dataUrl);
            img.src = dataUrl;
        });
    }

    async function refreshProfileFromServer() {
        try {
            const user = await API.me();
            if (user?.id) {
                API.setUser(user);
                syncAvatarCache(user.avatar_url || '');
                return user;
            }
        } catch {
            /* ignore */
        } finally {
            refreshUserUI();
        }
        return null;
    }

    function isAdminUser(user) {
        return String(user?.role || '').toLowerCase() === 'admin';
    }

    function syncAdminBtnVisibility() {
        const app = document.getElementById('app');
        const btn = document.getElementById('admin-btn');
        if (!app || !btn) return;

        const user = API.getUser();
        const inDriveMode = !app.classList.contains('admin-mode');
        const show = inDriveMode && isAdminUser(user);

        app.classList.toggle('admin-drive-access', show);
        btn.classList.toggle('hidden', !show);
        btn.disabled = !show;
        btn.setAttribute('aria-hidden', show ? 'false' : 'true');
    }

    function profileDisplayName(user) {
        if (!user) return 'User';
        const username = String(user.username || '').trim();
        if (username) return username;
        const email = String(user.email || '');
        const at = email.indexOf('@');
        return at > 0 ? email.slice(0, at) : (email || 'User');
    }

    async function refreshProfileStorage() {
        const storageEl = document.getElementById('profile-storage');
        const textEl = document.getElementById('profile-storage-text');
        const warnEl = document.getElementById('profile-storage-warn');
        const fillEl = document.getElementById('profile-storage-bar-fill');
        if (!storageEl || !textEl || !fillEl) return;

        try {
            const stats = await API.myStorage();
            const used = Number(stats?.used_bytes || 0);
            const total = Number(stats?.total_bytes || 0);
            if (!(total > 0)) {
                storageEl.classList.add('hidden');
                return;
            }
            const pct = Math.min(100, Math.round((used / total) * 100));
            textEl.textContent = `${Components.formatSize(used)} of ${Components.formatSize(total)} used`;
            fillEl.style.width = `${pct}%`;
            warnEl?.classList.toggle('hidden', pct < 80);
            storageEl.classList.remove('hidden');
        } catch {
            storageEl.classList.add('hidden');
        }
    }

    function populateProfileDropdown() {
        const user = API.getUser?.() || {};
        const displayName = profileDisplayName(user);
        const greeting = document.getElementById('profile-greeting');
        const emailEl = document.getElementById('profile-email');
        if (greeting) greeting.textContent = `Hi, ${displayName}!`;
        if (emailEl) emailEl.textContent = user.email || '';

        const initial = Components.initials(displayName || user.email || 'U');
        const lgAvatar = document.getElementById('profile-avatar-lg');
        const prefs = getUserPrefs();
        const savedPhoto = resolveAvatar(user, prefs);

        if (lgAvatar) {
            if (savedPhoto) {
                lgAvatar.textContent = '';
                lgAvatar.style.backgroundImage = `url(${savedPhoto})`;
                lgAvatar.style.backgroundSize = 'cover';
                lgAvatar.style.backgroundPosition = 'center';
            } else {
                lgAvatar.style.backgroundImage = '';
                lgAvatar.textContent = initial;
            }
        }

        refreshProfileStorage();
    }

    function refreshUserUI() {
        const user = API.getUser();
        if (user) {
            const prefs = getUserPrefs();
            const initial = Components.initials(user.username || user.email || 'U');
            const ua = document.getElementById('user-avatar');
            const ta = document.getElementById('topbar-avatar');
            const savedPhoto = resolveAvatar(user, prefs);

            if (ua) {
                ua.textContent = savedPhoto ? '' : initial;
                ua.style.backgroundImage = savedPhoto ? `url(${savedPhoto})` : '';
                ua.style.backgroundSize = savedPhoto ? 'cover' : '';
                ua.style.backgroundPosition = savedPhoto ? 'center' : '';
                ua.style.color = savedPhoto ? 'transparent' : '';
            }
            if (ta) {
                ta.innerHTML = '';
                ta.textContent = savedPhoto ? '' : initial;
                ta.style.backgroundImage = savedPhoto ? `url(${savedPhoto})` : '';
                ta.style.backgroundSize = savedPhoto ? 'cover' : '';
                ta.style.backgroundPosition = savedPhoto ? 'center' : '';
                ta.style.color = savedPhoto ? 'transparent' : '';
            }
            const un = document.getElementById('user-name');
            if (un) un.textContent = user.username || user.email;
            const ur = document.getElementById('user-role');
            if (ur) ur.textContent = user.role;

            const greeting = document.getElementById('profile-greeting');
            if (greeting) greeting.textContent = `Hi, ${profileDisplayName(user)}!`;
            const emailEl = document.getElementById('profile-email');
            if (emailEl) emailEl.textContent = user.email || '';
            const lgAvatar = document.getElementById('profile-avatar-lg');
            if (lgAvatar) {
                if (savedPhoto) {
                    lgAvatar.textContent = '';
                    lgAvatar.style.backgroundImage = `url(${savedPhoto})`;
                    lgAvatar.style.backgroundSize = 'cover';
                    lgAvatar.style.backgroundPosition = 'center';
                } else {
                    lgAvatar.style.backgroundImage = '';
                    lgAvatar.textContent = initial;
                }
            }
        }
        syncAdminBtnVisibility();
    }

    function applyTheme(theme) {
        const t = theme || 'system';
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const dark = t === 'dark' || (t === 'system' && prefersDark);
        document.body.classList.toggle('dark-mode', dark);
        document.body.dataset.fdTheme = t;
    }

    function formatEmailExpiry(iso) {
        if (!iso) return 'soon';
        try {
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return 'soon';
            return d.toLocaleString();
        } catch {
            return 'soon';
        }
    }

    async function openDriveSettings() {
        const user = API.getUser() || {};
        const prefs = getUserPrefs();
        const esc = Components.escapeHtml;
        const currentName = user.username || '';
        const nameParts = currentName.split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';
        const previewAvatar = resolveAvatar(user, prefs);
        const currentEmail = String(user.email || '').trim().toLowerCase();

        let pendingStatus = { pending: false };
        try {
            pendingStatus = await API.emailChangeStatus();
        } catch { /* ignore */ }

        const pendingBanner = pendingStatus.pending
            ? `<div id="settings-email-pending" style="margin-top:12px;padding:12px 14px;border-radius:8px;background:#e8f0fe;color:#174ea6;font-size:13px;line-height:1.45;">
                Check your inbox at <strong>${esc(pendingStatus.new_email_masked || 'your new address')}</strong>.
                The confirmation link expires ${esc(formatEmailExpiry(pendingStatus.expires_at))}.
            </div>`
            : '';

        Components.showModal('Settings', `
            <div class="drive-settings-modal" style="padding: 8px 0;">
                <div class="drive-settings-profile" style="margin-bottom: 24px;">
                    <div class="drive-settings-avatar ${previewAvatar ? 'has-photo' : ''}" id="settings-avatar-preview" style="${previewAvatar ? `background-image:url(${previewAvatar});` : ''}">${previewAvatar ? '' : esc(Components.initials(user.username || user.email || 'U'))}</div>
                    <div class="drive-settings-meta">
                        <div class="drive-settings-name">${esc(user.username || 'User')}</div>
                        <div class="drive-settings-email">${esc(user.email || 'No email')}</div>
                        <div class="drive-settings-avatar-actions">
                            <label class="drive-avatar-upload-btn" for="settings-avatar-input">Upload photo</label>
                            <button type="button" class="drive-avatar-remove-btn" id="settings-avatar-remove">Remove</button>
                        </div>
                    </div>
                </div>
                <div style="display:flex;flex-direction:column;gap:16px;">
                    <label class="drive-settings-field drive-settings-field-full">
                        <span style="font-size:13px;font-weight:500;color:#5f6368;display:block;margin-bottom:6px;">First name</span>
                        <input id="settings-first-name" type="text" value="${esc(firstName)}" placeholder="First name" style="width:100%;height:36px;border-radius:8px;border:1px solid #dadce0;padding:0 12px;font-size:14px;background:#fff;">
                    </label>
                    <label class="drive-settings-field drive-settings-field-full">
                        <span style="font-size:13px;font-weight:500;color:#5f6368;display:block;margin-bottom:6px;">Last name</span>
                        <input id="settings-last-name" type="text" value="${esc(lastName)}" placeholder="Last name" style="width:100%;height:36px;border-radius:8px;border:1px solid #dadce0;padding:0 12px;font-size:14px;background:#fff;">
                    </label>
                    <label class="drive-settings-field drive-settings-field-full">
                        <span style="font-size:13px;font-weight:500;color:#5f6368;display:block;margin-bottom:6px;">Email</span>
                        <input id="settings-email" type="email" value="${esc(user.email || '')}" placeholder="Email" autocomplete="email" style="width:100%;height:36px;border-radius:8px;border:1px solid #dadce0;padding:0 12px;font-size:14px;background:#fff;">
                        <span style="display:block;margin-top:6px;font-size:12px;color:#5f6368;">Confirmation link will be sent to the new address.</span>
                    </label>
                    <label class="drive-settings-field drive-settings-field-full hidden" id="settings-email-password-wrap">
                        <span style="font-size:13px;font-weight:500;color:#5f6368;display:block;margin-bottom:6px;">Current password</span>
                        <input id="settings-email-password" type="password" placeholder="Required to change email" autocomplete="current-password" style="width:100%;height:36px;border-radius:8px;border:1px solid #dadce0;padding:0 12px;font-size:14px;background:#fff;">
                    </label>
                    <button type="button" class="btn btn-secondary drive-settings-confirm-btn" id="settings-send-email-confirm">Confirm</button>
                    ${pendingBanner}
                    <div style="margin-top:8px;padding-top:20px;border-top:1px solid #e8eaed;">
                        <div style="font-size:13px;font-weight:500;color:#5f6368;margin-bottom:8px;">Keyboard shortcuts</div>
                        <p style="margin:0 0 12px;font-size:12px;color:#5f6368;line-height:1.45;">
                            View keyboard shortcuts for navigating and managing files.
                        </p>
                        <button type="button" class="btn btn-secondary" id="settings-keyboard-shortcuts-btn">
                            Keyboard shortcuts
                        </button>
                    </div>
                </div>
                <input id="settings-avatar-input" type="file" accept="image/*" hidden>
            </div>
        `, [
            { text: 'Cancel' },
            {
                text: 'Save',
                class: 'btn-primary',
                close: false,
                action: async () => {
                    const first = String(document.getElementById('settings-first-name')?.value || '').trim();
                    const last = String(document.getElementById('settings-last-name')?.value || '').trim();
                    const fullName = [first, last].filter(Boolean).join(' ');
                    if (!fullName) {
                        Components.toast('First or last name is required', 'error');
                        return;
                    }

                    const preview = document.getElementById('settings-avatar-preview');
                    const avatarRaw = preview && Object.prototype.hasOwnProperty.call(preview.dataset, 'avatar')
                        ? String(preview.dataset.avatar || '')
                        : resolveAvatar(user, prefs);

                    try {
                        const avatar = avatarRaw
                            ? await resizeAvatarDataURL(avatarRaw)
                            : '';
                        const updated = await API.updateMe({
                            username: fullName,
                            avatar_url: avatar,
                        });
                        API.setUser(updated);
                        syncAvatarCache(updated.avatar_url || '');
                        refreshUserUI();
                        Components.toast('Profile updated', 'success');
                        Components.hideModal();
                    } catch (err) {
                        Components.toast(err?.message || 'Failed to save profile', 'error');
                    }
                },
            },
        ]);

        const fileInput = document.getElementById('settings-avatar-input');
        const avatarPreview = document.getElementById('settings-avatar-preview');
        const removeBtn = document.getElementById('settings-avatar-remove');
        if (avatarPreview) avatarPreview.dataset.avatar = previewAvatar || '';

        fileInput?.addEventListener('change', async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async () => {
                const raw = String(reader.result || '');
                const result = await resizeAvatarDataURL(raw);
                if (!avatarPreview) return;
                avatarPreview.dataset.avatar = result;
                avatarPreview.textContent = '';
                avatarPreview.style.backgroundImage = `url(${result})`;
                avatarPreview.classList.add('has-photo');
            };
            reader.readAsDataURL(file);
        });

        removeBtn?.addEventListener('click', () => {
            if (!avatarPreview) return;
            avatarPreview.dataset.avatar = '';
            avatarPreview.textContent = esc(Components.initials(user.username || user.email || 'U'));
            avatarPreview.style.backgroundImage = '';
            avatarPreview.classList.remove('has-photo');
            if (fileInput) fileInput.value = '';
        });

        const emailInput = document.getElementById('settings-email');
        const passwordWrap = document.getElementById('settings-email-password-wrap');
        const passwordInput = document.getElementById('settings-email-password');
        const sendConfirmBtn = document.getElementById('settings-send-email-confirm');

        function syncEmailPasswordVisibility() {
            const nextEmail = String(emailInput?.value || '').trim().toLowerCase();
            const changing = Boolean(nextEmail && nextEmail !== currentEmail);
            passwordWrap?.classList.toggle('hidden', !changing);
            if (!changing && passwordInput) passwordInput.value = '';
        }

        emailInput?.addEventListener('input', syncEmailPasswordVisibility);
        syncEmailPasswordVisibility();

        sendConfirmBtn?.addEventListener('click', async () => {
            const newEmail = String(emailInput?.value || '').trim().toLowerCase();
            const password = String(passwordInput?.value || '');
            if (!newEmail || !newEmail.includes('@')) {
                Components.toast('Enter a valid email address', 'error');
                return;
            }
            if (newEmail === currentEmail) {
                Components.toast('Enter a different email address', 'error');
                return;
            }
            if (!password) {
                Components.toast('Current password is required to change email', 'error');
                return;
            }

            sendConfirmBtn.disabled = true;
            const prevLabel = sendConfirmBtn.textContent;
            sendConfirmBtn.textContent = 'Sending...';
            try {
                const result = await API.requestEmailChange(newEmail, password);
                Components.toast(`Confirmation link sent to ${result.new_email_masked || newEmail}`, 'success', { duration: 7000 });
                if (passwordInput) passwordInput.value = '';
                Components.hideModal();
                openDriveSettings();
            } catch (err) {
                Components.toast(err?.message || 'Failed to request email change', 'error');
            } finally {
                sendConfirmBtn.disabled = false;
                sendConfirmBtn.textContent = prevLabel;
            }
        });

        document.getElementById('settings-keyboard-shortcuts-btn')?.addEventListener('click', () => {
            Components.hideModal();
            FileManager.showShortcuts?.();
        });
    }

    async function openSecurityCenter() {
        const esc = Components.escapeHtml;
        let profile = API.getUser() || {};
        try {
            profile = await API.me();
            API.setUser(profile);
        } catch { /* use cached */ }

        const required = Boolean(profile.two_factor_required);
        const emailEnabled = Boolean(profile.email_2fa_enabled);
        const totpEnabled = Boolean(profile.totp_enabled);
        const phoneEnabled = Boolean(profile.login_approval_enabled);
        let phoneStatus = { enabled: phoneEnabled, has_trusted_mobile: false };
        try {
            phoneStatus = await API.loginApprovalStatus();
        } catch { /* ignore */ }

        const requiredNote = required
            ? '<p style="margin:12px 0 0;font-size:12px;color:#174ea6;line-height:1.45;">Your administrator requires two-factor authentication (authenticator app or email).</p>'
            : '';

        let needsRecovery = false;
        if (window.CryptoSync?.detectNeedsRecovery) {
            try {
                needsRecovery = await CryptoSync.detectNeedsRecovery();
            } catch { /* ignore */ }
        }
        const recoveryBanner = needsRecovery
            ? `<div id="security-crypto-recovery-banner" style="margin-bottom:12px;padding:12px 14px;border-radius:8px;background:#fce8e6;color:#c5221f;font-size:13px;line-height:1.45;">
                Server lost encryption account data, but encrypted file keys are still on the server. Enter your recovery code below to restore access.
            </div>`
            : '';
        const recoverySection = needsRecovery
            ? `<div id="security-crypto-recovery-section" style="margin-bottom:12px;">
                <input id="security-crypto-recovery-input" type="text" placeholder="xxxx-xxxx-..."
                    style="width:100%;height:40px;border-radius:8px;border:1px solid #dadce0;padding:0 12px;">
                <button type="button" class="btn btn-secondary" id="security-crypto-recovery-restore-btn" style="margin-top:8px;">
                    Restore encryption
                </button>
            </div>`
            : '';

        const totpBody = totpEnabled
            ? `<p style="margin:0;font-size:13px;color:#137333;line-height:1.45;">Authenticator app is enabled${profile.totp_enrolled_at ? ` (since ${esc(new Date(profile.totp_enrolled_at).toLocaleDateString())})` : ''}.</p>
               <button type="button" class="btn btn-secondary" id="security-totp-disable-btn" style="margin-top:12px;">Disable authenticator</button>`
            : `<p style="margin:0 0 12px;font-size:13px;color:#5f6368;line-height:1.45;">Use Google Authenticator, Authy, or 1Password for sign-in codes. Preferred when both methods are enabled.</p>
               <button type="button" class="btn btn-primary" id="security-totp-setup-btn">Set up authenticator</button>
               <div id="security-totp-setup-panel" class="hidden" style="margin-top:14px;"></div>`;

        const emailCanDisable = !(required && !totpEnabled);
        const emailBody = emailEnabled
            ? `<p style="margin:0;font-size:13px;color:#137333;line-height:1.45;">Email verification codes are enabled for ${esc(profile.email || 'your email')}.</p>
               <button type="button" class="btn btn-secondary" id="security-email-2fa-disable-btn" style="margin-top:12px;" ${emailCanDisable ? '' : 'disabled'}>Disable email codes</button>
               ${emailCanDisable ? '' : '<p style="margin:8px 0 0;font-size:12px;color:#174ea6;line-height:1.45;">Required by your administrator until an authenticator app is set up.</p>'}`
            : `<p style="margin:0 0 12px;font-size:13px;color:#5f6368;line-height:1.45;">Protect your account with a 6-digit code sent to ${esc(profile.email || 'your email')} each time you sign in.</p>
               <button type="button" class="btn btn-primary" id="security-email-2fa-enable-btn">Enable email codes</button>
               ${requiredNote}`;

        const phoneTrustedNote = phoneStatus.has_trusted_mobile
            ? '<p style="margin:8px 0 0;font-size:12px;color:#137333;line-height:1.45;">Trusted FreeDrive mobile app detected.</p>'
            : '<p style="margin:8px 0 0;font-size:12px;color:#b06000;line-height:1.45;">No trusted mobile app signed in yet. Install FreeDrive on your phone and stay signed in.</p>';
        const phoneBody = phoneEnabled
            ? `<p style="margin:0;font-size:13px;color:#137333;line-height:1.45;">Phone sign-in prompts are enabled.</p>
               ${phoneTrustedNote}
               <button type="button" class="btn btn-secondary" id="security-phone-approval-disable-btn" style="margin-top:12px;">Disable phone prompts</button>`
            : `<p style="margin:0 0 12px;font-size:13px;color:#5f6368;line-height:1.45;">When you sign in on a new computer or browser, FreeDrive can ask your phone to approve instead of an authenticator code. Requires the FreeDrive mobile app signed in.</p>
               <button type="button" class="btn btn-primary" id="security-phone-approval-enable-btn">Enable phone prompts</button>
               ${phoneTrustedNote}`;

        Components.showModal('Security', `
            <div class="drive-settings-modal" style="padding:8px 0;display:flex;flex-direction:column;gap:16px;">
                <div style="border:1px solid #e8eaed;border-radius:12px;padding:16px 18px;background:#fff;">
                    <div style="font-size:15px;font-weight:600;color:#202124;margin-bottom:4px;">Authenticator app</div>
                    <div style="font-size:13px;color:#5f6368;line-height:1.45;margin-bottom:12px;">Protect your account with a time-based code from an authenticator app.</div>
                    ${totpBody}
                </div>
                <div style="border:1px solid #e8eaed;border-radius:12px;padding:16px 18px;background:#fff;">
                    <div style="font-size:15px;font-weight:600;color:#202124;margin-bottom:4px;">Email two-factor authentication</div>
                    <div style="font-size:13px;color:#5f6368;line-height:1.45;margin-bottom:12px;">Protect your account with a verification code sent by email.</div>
                    ${emailBody}
                </div>
                <div style="border:1px solid #e8eaed;border-radius:12px;padding:16px 18px;background:#fff;">
                    <div style="font-size:15px;font-weight:600;color:#202124;margin-bottom:4px;">Phone sign-in prompts</div>
                    <div style="font-size:13px;color:#5f6368;line-height:1.45;margin-bottom:12px;">Approve sign-ins from your phone, like Google Prompt.</div>
                    ${phoneBody}
                </div>
                <div style="border:1px solid #e8eaed;border-radius:12px;padding:16px 18px;background:#fff;">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;">
                        <div style="font-size:15px;font-weight:600;color:#202124;">Devices</div>
                        <button type="button" class="btn btn-secondary" id="security-revoke-others-btn" style="font-size:12px;height:32px;">
                            Sign out other devices
                        </button>
                    </div>
                    <p style="margin:0 0 12px;font-size:12px;color:#5f6368;line-height:1.45;">
                        Devices currently signed in to your account. Signing out a device forces it to log in again.
                    </p>
                    <div id="security-sessions-list" style="display:flex;flex-direction:column;gap:8px;">
                        <div style="font-size:13px;color:#5f6368;">Loading devices…</div>
                    </div>
                </div>
                <div style="border:1px solid #e8eaed;border-radius:12px;padding:16px 18px;background:#fff;">
                    <div style="font-size:15px;font-weight:600;color:#202124;margin-bottom:8px;">Encryption</div>
                    ${recoveryBanner}
                    <p style="margin:0 0 8px;font-size:12px;color:#5f6368;line-height:1.45;">
                        Status: <strong id="security-crypto-status">${window.CryptoSync?.isUnlocked?.() ? 'Active' : 'Inactive'}</strong>
                        — encryption unlocks automatically when you sign in. Keys sync across your devices.
                    </p>
                    ${recoverySection}
                    <details style="font-size:13px;color:#5f6368;margin-bottom:12px;">
                        <summary style="cursor:pointer;">Advanced: rotate encryption key</summary>
                        <button type="button" class="btn btn-secondary" id="security-crypto-rotate-btn" style="margin-top:8px;">
                            Rotate encryption key
                        </button>
                    </details>
                    <div style="font-size:13px;font-weight:500;color:#5f6368;margin-bottom:6px;">Manual backup (optional)</div>
                    <p style="margin:0 0 12px;font-size:12px;color:#5f6368;line-height:1.45;">
                        Export/import below only if you need to move keys manually between browsers.
                    </p>
                    <div style="display:flex;flex-wrap:wrap;gap:8px;">
                        <button type="button" class="btn btn-secondary" id="security-export-keys-btn">Export encryption keys</button>
                        <button type="button" class="btn btn-secondary" id="security-import-keys-btn">Import encryption keys</button>
                    </div>
                    <input type="file" id="security-import-keys-input" accept="application/json,.json" hidden>
                </div>
            </div>
        `, [{ text: 'Close' }]);

        const setEmail2FA = async (next) => {
            if (required && !totpEnabled && !next) {
                Components.toast('Two-factor authentication is required by your administrator', 'info');
                return;
            }
            try {
                const updated = await API.updateMe({ email_2fa_enabled: next });
                API.setUser(updated);
                Components.toast(next ? 'Email verification codes enabled' : 'Email verification codes disabled', 'success');
                openSecurityCenter();
            } catch (err) {
                Components.toast(err?.message || 'Failed to update email two-factor setting', 'error');
            }
        };
        document.getElementById('security-email-2fa-enable-btn')?.addEventListener('click', () => setEmail2FA(true));
        document.getElementById('security-email-2fa-disable-btn')?.addEventListener('click', () => setEmail2FA(false));

        const setPhoneApproval = async (next) => {
            try {
                const updated = await API.updateMe({ login_approval_enabled: next });
                API.setUser(updated);
                Components.toast(next ? 'Phone sign-in prompts enabled' : 'Phone sign-in prompts disabled', 'success');
                openSecurityCenter();
            } catch (err) {
                Components.toast(err?.message || 'Failed to update phone prompt setting', 'error');
            }
        };
        document.getElementById('security-phone-approval-enable-btn')?.addEventListener('click', () => setPhoneApproval(true));
        document.getElementById('security-phone-approval-disable-btn')?.addEventListener('click', () => setPhoneApproval(false));

        const showBackupCodes = (codes) => {
            const list = (codes || []).map((c) => `<code style="display:inline-block;margin:2px 6px 2px 0;padding:4px 8px;background:#f1f3f4;border-radius:6px;">${esc(c)}</code>`).join('');
            Components.showModal('Backup codes', `
                <p style="margin:0 0 12px;font-size:13px;color:#5f6368;line-height:1.45;">
                    Save these one-time backup codes somewhere safe. Each code can be used once if you lose access to your authenticator.
                </p>
                <div style="line-height:1.8;">${list || 'No codes returned.'}</div>
            `, [{ text: 'Done', class: 'btn-primary', action: () => openSecurityCenter() }]);
        };

        document.getElementById('security-totp-setup-btn')?.addEventListener('click', async () => {
            const panel = document.getElementById('security-totp-setup-panel');
            const btn = document.getElementById('security-totp-setup-btn');
            if (!panel) return;
            try {
                if (btn) btn.disabled = true;
                const setup = await API.totpSetup();
                panel.classList.remove('hidden');
                panel.innerHTML = `
                    <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;">
                        <img src="${esc(setup.qr)}" alt="Authenticator QR code" width="160" height="160" style="border:1px solid #e8eaed;border-radius:8px;">
                        <div style="flex:1;min-width:180px;">
                            <p style="margin:0 0 8px;font-size:13px;color:#5f6368;line-height:1.45;">Scan this QR code, or enter the secret manually:</p>
                            <code style="display:block;word-break:break-all;padding:8px 10px;background:#f1f3f4;border-radius:8px;font-size:12px;">${esc(setup.secret)}</code>
                            <input id="security-totp-confirm-code" type="text" inputmode="numeric" maxlength="8" placeholder="6-digit code"
                                style="width:100%;height:40px;margin-top:12px;border-radius:8px;border:1px solid #dadce0;padding:0 12px;">
                            <button type="button" class="btn btn-primary" id="security-totp-confirm-btn" style="margin-top:8px;">Confirm</button>
                        </div>
                    </div>`;
                document.getElementById('security-totp-confirm-btn')?.addEventListener('click', async () => {
                    const code = String(document.getElementById('security-totp-confirm-code')?.value || '').trim();
                    if (code.length < 6) {
                        Components.toast('Enter the 6-digit code from your authenticator', 'error');
                        return;
                    }
                    try {
                        const result = await API.totpConfirm(code);
                        const updated = await API.me();
                        API.setUser(updated);
                        Components.toast('Authenticator app enabled', 'success');
                        showBackupCodes(result?.backup_codes || []);
                    } catch (err) {
                        Components.toast(err?.message || 'Failed to confirm authenticator', 'error');
                    }
                });
            } catch (err) {
                Components.toast(err?.message || 'Failed to start authenticator setup', 'error');
            } finally {
                if (btn) btn.disabled = false;
            }
        });

        document.getElementById('security-totp-disable-btn')?.addEventListener('click', async () => {
            const code = window.prompt('Enter a current authenticator code (or leave blank and enter password next):') || '';
            let password = '';
            if (!String(code).trim()) {
                password = window.prompt('Enter your account password to disable authenticator:') || '';
            }
            if (!String(code).trim() && !String(password).trim()) return;
            try {
                const updated = await API.totpDisable({ code: String(code).trim(), password: String(password) });
                if (updated?.id) API.setUser(updated);
                else {
                    const me = await API.me();
                    API.setUser(me);
                }
                Components.toast('Authenticator app disabled', 'success');
                openSecurityCenter();
            } catch (err) {
                Components.toast(err?.message || 'Failed to disable authenticator', 'error');
            }
        });

        const sessionsListEl = document.getElementById('security-sessions-list');
        const formatSessionTime = (iso) => {
            if (!iso) return 'Unknown';
            const ts = new Date(iso).getTime();
            if (Number.isNaN(ts)) return 'Unknown';
            const mins = Math.floor((Date.now() - ts) / 60000);
            if (mins < 1) return 'Just now';
            if (mins < 60) return `${mins} min ago`;
            const hours = Math.floor(mins / 60);
            if (hours < 24) return `${hours}h ago`;
            const days = Math.floor(hours / 24);
            if (days < 14) return `${days}d ago`;
            return new Date(iso).toLocaleDateString();
        };

        const renderSessions = async () => {
            if (!sessionsListEl) return;
            sessionsListEl.innerHTML = '<div style="font-size:13px;color:#5f6368;">Loading devices…</div>';
            try {
                const data = await API.auth.getSessions();
                const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
                if (!sessions.length) {
                    sessionsListEl.innerHTML = '<div style="font-size:13px;color:#5f6368;">No active devices.</div>';
                    return;
                }
                sessionsListEl.innerHTML = sessions.map((s) => {
                    const icon = s.device_type === 'desktop'
                        ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 5h16a1 1 0 0 1 1 1v10H3V6a1 1 0 0 1 1-1zm-1 13h18v2H3v-2z"/></svg>'
                        : '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-5v2h2v2H7v-2h2v-2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v7h16V6H4z"/></svg>';
                    const badge = s.current
                        ? '<span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;background:#e6f4ea;color:#137333;font-size:11px;font-weight:600;">This device</span>'
                        : '';
                    const revokeBtn = s.current
                        ? ''
                        : `<button type="button" class="btn btn-secondary security-revoke-session-btn" data-session-id="${esc(s.id)}" style="font-size:12px;height:30px;">Sign out</button>`;
                    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid #e8eaed;border-radius:10px;background:#fff;">
                        <div style="display:flex;align-items:flex-start;gap:12px;min-width:0;">
                            <div style="color:#5f6368;margin-top:2px;">${icon}</div>
                            <div style="min-width:0;">
                                <div style="font-size:14px;font-weight:500;color:#202124;">${esc(s.device_name || 'Unknown device')}${badge}</div>
                                <div style="font-size:12px;color:#5f6368;margin-top:2px;">${esc(s.ip_address || '—')} · Last active ${esc(formatSessionTime(s.last_seen_at))}</div>
                            </div>
                        </div>
                        ${revokeBtn}
                    </div>`;
                }).join('');

                sessionsListEl.querySelectorAll('.security-revoke-session-btn').forEach((btn) => {
                    btn.addEventListener('click', async () => {
                        const id = btn.getAttribute('data-session-id');
                        if (!id) return;
                        if (!window.confirm('Sign out this device? It will need to log in again.')) return;
                        btn.disabled = true;
                        try {
                            await API.auth.revokeSession(id);
                            Components.toast('Device signed out', 'success');
                            await renderSessions();
                        } catch (err) {
                            btn.disabled = false;
                            Components.toast(err?.message || 'Failed to sign out device', 'error');
                        }
                    });
                });
            } catch (err) {
                sessionsListEl.innerHTML = `<div style="font-size:13px;color:#c5221f;">${esc(err?.message || 'Failed to load devices')}</div>`;
            }
        };

        document.getElementById('security-revoke-others-btn')?.addEventListener('click', async () => {
            if (!window.confirm('Sign out all other devices? They will need to log in again.')) return;
            const btn = document.getElementById('security-revoke-others-btn');
            if (btn) btn.disabled = true;
            try {
                await API.auth.revokeOtherSessions();
                Components.toast('Other devices signed out', 'success');
                await renderSessions();
            } catch (err) {
                Components.toast(err?.message || 'Failed to sign out other devices', 'error');
            } finally {
                if (btn) btn.disabled = false;
            }
        });

        renderSessions();

        document.getElementById('security-export-keys-btn')?.addEventListener('click', async () => {
            try {
                if (!CryptoModule.canEncrypt()) {
                    Components.toast('Encryption is not available in this browser session', 'error');
                    return;
                }
                const exportData = await CryptoModule.exportAllKeys();
                const count = Object.keys(exportData.keys || {}).length;
                if (count === 0) {
                    Components.toast('No encryption keys found in this browser', 'info');
                    return;
                }
                CryptoModule.downloadKeyExport(exportData);
                Components.toast(`Exported ${count} encryption key${count === 1 ? '' : 's'}`, 'success');
            } catch (err) {
                Components.toast(err?.message || 'Failed to export encryption keys', 'error');
            }
        });

        const importKeysInput = document.getElementById('security-import-keys-input');
        document.getElementById('security-import-keys-btn')?.addEventListener('click', () => {
            importKeysInput?.click();
        });
        importKeysInput?.addEventListener('change', async () => {
            const file = importKeysInput.files?.[0];
            importKeysInput.value = '';
            if (!file) return;
            try {
                if (!CryptoModule.canEncrypt()) {
                    Components.toast('Encryption is not available in this browser session', 'error');
                    return;
                }
                const text = await file.text();
                const exportData = CryptoModule.parseKeyExportFile(text);
                const count = await CryptoModule.importAllKeys(exportData);
                if (count === 0) {
                    Components.toast('No valid keys found in import file', 'info');
                    return;
                }
                Components.toast(`Imported ${count} encryption key${count === 1 ? '' : 's'}`, 'success');
            } catch (err) {
                Components.toast(err?.message || 'Failed to import encryption keys', 'error');
            }
        });

        document.getElementById('security-crypto-recovery-restore-btn')?.addEventListener('click', async () => {
            const recovery = String(document.getElementById('security-crypto-recovery-input')?.value || '').trim();
            if (!recovery) {
                Components.toast('Enter your recovery code', 'error');
                return;
            }
            try {
                await CryptoSync.restoreWithRecoveryCode(recovery);
                const statusEl = document.getElementById('security-crypto-status');
                if (statusEl) statusEl.textContent = 'Active';
                document.getElementById('security-crypto-recovery-banner')?.remove();
                document.getElementById('security-crypto-recovery-section')?.remove();
                Components.toast('Encryption restored', 'success');
            } catch (err) {
                Components.toast(err?.message || 'Recovery failed', 'error');
            }
        });

        document.getElementById('security-crypto-rotate-btn')?.addEventListener('click', async () => {
            if (!window.CryptoSync?.rotateAccountKey) return;
            const password = window.prompt('Enter your password to rotate your encryption key:');
            if (!password) return;
            try {
                const result = await CryptoSync.rotateAccountKey(password);
                if (result?.recoveryCode && CryptoSync.showRecoverySetupModal) {
                    await CryptoSync.showRecoverySetupModal(result.recoveryCode);
                }
                const statusEl = document.getElementById('security-crypto-status');
                if (statusEl) statusEl.textContent = 'Active';
                Components.toast('Encryption key rotated', 'success');
            } catch (err) {
                Components.toast(err?.message || 'Key rotation failed', 'error');
            }
        });
    }

    function init() {
        // Migrate the old hash login URL to the canonical history route.
        if (window.location.hash === '#/login') {
            history.replaceState(null, '', `/login${window.location.search}`);
        }

        if (window.location.hash.startsWith('#/public-share/')) {
            showPublicShareDownload();
            return;
        }
        if (!window.location.hash && window.location.pathname.startsWith('/admin') && window.location.pathname !== '/admin') {
            // We use history wrapper below, do not convert to hash.
            // Allow pathname to dictate routing.
        }

        Components.init();
        Auth.init();
        Upload.init();
        FileManager.init();
        if (API.isLoggedIn()) SidebarTree.init();

        if (API.isLoggedIn()) {
            if (window.location.pathname === '/login') {
                history.replaceState(null, '', '/');
            }
            showApp();
        } else {
            const authPath = window.location.pathname;
            if (authPath !== '/login' && !authPath.startsWith('/reset-password') && !authPath.startsWith('/confirm-email')) {
                history.replaceState(null, '', '/login');
            }
            showAuth();
        }

        bindGlobalUI();
        window.addEventListener('hashchange', handleRoute);
        window.addEventListener('popstate', handleRoute);
        
        // Attach ripple effect to interactive elements
        initRipple();
        
        handleRoute();
    }

    function showPublicShareDownload() {
        document.getElementById('auth-screen')?.classList.add('hidden');
        document.getElementById('app')?.classList.add('hidden');

        const route = window.location.hash.slice('#/public-share/'.length);
        const [rawToken, rawQuery = ''] = route.split('?');
        const token = decodeURIComponent(rawToken || '');
        const keyText = new URLSearchParams(rawQuery).get('k') || '';

        const page = document.createElement('main');
        page.className = 'public-share-page';
        page.innerHTML = `
            <section class="public-share-card" aria-labelledby="public-share-title">
                <div class="public-share-logo">FreeDrive</div>
                <h1 id="public-share-title">Encrypted file</h1>
                <p>The decryption key stays in this link and is never sent to the server.</p>
                <input id="public-share-password" type="password" placeholder="Link password, if required" autocomplete="off">
                <button id="public-share-download" type="button" class="btn btn-primary">Download and decrypt</button>
                <p id="public-share-status" role="status" aria-live="polite"></p>
            </section>`;
        document.body.appendChild(page);

        const button = page.querySelector('#public-share-download');
        const status = page.querySelector('#public-share-status');
        button?.addEventListener('click', async () => {
            if (!token || !keyText) {
                status.textContent = 'This encrypted link is incomplete.';
                return;
            }
            button.disabled = true;
            status.textContent = 'Downloading encrypted file…';
            try {
                const password = page.querySelector('#public-share-password')?.value || '';
                const response = await fetch(`/api/v1/public/share/${encodeURIComponent(token)}/download`, {
                    headers: password ? { 'X-Share-Password': password } : {},
                    cache: 'no-store',
                });
                if (!response.ok) throw new Error('Link is invalid, expired, or requires the correct password.');
                const iv = response.headers.get('X-File-IV') || '';
                if (!iv) throw new Error('The encrypted file metadata is incomplete.');
                status.textContent = 'Decrypting in your browser…';
                const key = await CryptoModule.importKey(keyText);
                const plaintext = await CryptoModule.decryptFile(
                    await response.arrayBuffer(), key, CryptoModule.base64ToUint8(iv),
                );
                const disposition = response.headers.get('Content-Disposition') || '';
                const match = disposition.match(/filename="([^"]+)"/i);
                const fileName = (match?.[1] || 'freedrive-download').replace(/[\\/\r\n]/g, '_');
                const blob = new Blob([plaintext], {
                    type: response.headers.get('X-File-Mime') || 'application/octet-stream',
                });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = fileName;
                anchor.click();
                setTimeout(() => URL.revokeObjectURL(url), 1200);
                status.textContent = 'File decrypted and downloaded.';
            } catch (error) {
                status.textContent = error?.message || 'Download failed.';
            } finally {
                button.disabled = false;
            }
        });
    }

    function bindGlobalUI() {
        const newBtn = document.getElementById('new-menu-btn');
        const newDropdown = document.getElementById('new-dropdown');
        const helpDropdown = document.getElementById('help-dropdown');
        const searchFilterPanel = document.getElementById('search-filter-panel');
        const sidebar = document.getElementById('sidebar');
        const sidebarResizer = document.getElementById('sidebar-resizer');
        const detailsPanel = document.getElementById('details-panel');
        const notificationsPanel = document.getElementById('notifications-panel');
        const contentArea = document.getElementById('content-area');

        const closeTransientPanels = () => {
            newDropdown?.classList.add('hidden');
            helpDropdown?.classList.add('hidden');
            searchFilterPanel?.classList.add('hidden');
            document.getElementById('profile-dropdown')?.classList.add('hidden');
        };
        const closeRightPanels = () => {
            FileManager.hideDetailsPanel();
            notificationsPanel?.classList.add('hidden');
        };

        const clampSidebarWidth = (rawWidth) => {
            const min = 220;
            const max = Math.max(min, Math.min(420, window.innerWidth - 420));
            return Math.min(max, Math.max(min, rawWidth));
        };

        const applySidebarWidth = (rawWidth) => {
            const clamped = clampSidebarWidth(rawWidth);
            document.documentElement.style.setProperty('--fd-sidebar-w', `${clamped}px`);
            return clamped;
        };

        const restoreSidebarWidth = () => {
            const saved = Number(localStorage.getItem('fd_sidebar_w') || 0);
            if (Number.isFinite(saved) && saved > 0) {
                applySidebarWidth(saved);
            }
        };

        const bindSidebarResizer = () => {
            if (!sidebar || !sidebarResizer) return;

            restoreSidebarWidth();
            let isResizing = false;
            let pointerId = null;
            let startX = 0;
            let startWidth = 0;

            const stopResize = (e) => {
                if (!isResizing) return;
                if (e && pointerId !== null && e.pointerId !== pointerId) return;

                isResizing = false;
                pointerId = null;
                document.body.classList.remove('is-resizing-sidebar');
                document.removeEventListener('pointermove', onPointerMove);
                document.removeEventListener('pointerup', stopResize);
                document.removeEventListener('pointercancel', stopResize);

                const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--fd-sidebar-w'), 10);
                if (Number.isFinite(current) && current > 0) {
                    localStorage.setItem('fd_sidebar_w', String(current));
                }
            };

            const onPointerMove = (e) => {
                if (!isResizing || e.pointerId !== pointerId) return;
                e.preventDefault();
                const nextWidth = startWidth + (e.clientX - startX);
                applySidebarWidth(nextWidth);
            };

            sidebarResizer.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || window.matchMedia('(max-width: 1100px)').matches) return;
                e.preventDefault();
                isResizing = true;
                pointerId = e.pointerId;
                startX = e.clientX;
                startWidth = sidebar.getBoundingClientRect().width;
                document.body.classList.add('is-resizing-sidebar');
                document.addEventListener('pointermove', onPointerMove);
                document.addEventListener('pointerup', stopResize);
                document.addEventListener('pointercancel', stopResize);
            });

            window.addEventListener('resize', () => {
                if (window.matchMedia('(max-width: 1100px)').matches) return;
                const current = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--fd-sidebar-w'), 10);
                if (Number.isFinite(current)) {
                    applySidebarWidth(current);
                }
            });
        };

        bindSidebarResizer();

        const closeMobileSidebar = () => {
            sidebar?.classList.remove('open');
        };

        document.getElementById('sidebar-toggle')?.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebar?.classList.toggle('open');
        });

        document.getElementById('sidebar-scrim')?.addEventListener('click', () => {
            closeMobileSidebar();
        });

        sidebar?.addEventListener('click', (e) => {
            if (!window.matchMedia('(max-width: 1100px)').matches) return;
            const target = e.target;
            if (!target) return;
            if (!target.closest('.nav-item, .context-item')) return;
            closeMobileSidebar();
        });

        document.getElementById('topbar-settings')?.addEventListener('click', () => {
            openDriveSettings();
        });
        document.getElementById('topbar-security')?.addEventListener('click', () => {
            openSecurityCenter();
        });

        const shouldIgnorePanelDismiss = (target) => {
            if (!target) return true;
            if (target.closest('#details-panel, #notifications-panel, #notifications-btn, #info-btn')) return true;
            if (target.closest('.file-row, .file-card')) return true;
            if (target.closest('.modal-overlay:not(.hidden), #editor-overlay:not(.hidden), #context-menu')) return true;
            if (target.closest('#new-dropdown, #help-dropdown, .sidebar, #profile-dropdown, #topbar-profile-wrap, .search-wrap')) return true;
            return false;
        };

        document.addEventListener('click', (e) => {
            const notifOpen = notificationsPanel && !notificationsPanel.classList.contains('hidden');
            if (!notifOpen) return;
            if (shouldIgnorePanelDismiss(e.target)) return;
            notificationsPanel.classList.add('hidden');
        });

        newBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            const shouldOpen = newDropdown?.classList.contains('hidden');
            closeTransientPanels();
            if (!shouldOpen) return;
            newDropdown?.style.setProperty('position', 'absolute');
            newDropdown?.style.setProperty('left', '8px');
            newDropdown?.style.setProperty('top', '68px');
            newDropdown?.classList.remove('hidden');
        });

        newDropdown?.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        document.addEventListener('click', () => {
            closeTransientPanels();
        });

        document.addEventListener('click', (e) => {
            if (!window.matchMedia('(max-width: 1100px)').matches) return;
            const target = e.target;
            if (target && (target.closest('#sidebar') || target.closest('#sidebar-toggle') || target.closest('#sidebar-scrim'))) return;
            closeMobileSidebar();
        });

        document.getElementById('new-folder-action')?.addEventListener('click', () => FileManager.createFolder());
        document.getElementById('new-doc-action')?.addEventListener('click', () => FileManager.createQuickFile('Document.txt', 'text/plain', ''));
        document.getElementById('new-sheet-action')?.addEventListener('click', () => FileManager.createQuickFile('Spreadsheet.csv', 'text/csv', 'Column 1,Column 2\n,\n'));
        document.getElementById('new-presentation-action')?.addEventListener('click', () => FileManager.createQuickFile('Presentation.md', 'text/markdown', '# New Presentation\n'));

        document.getElementById('file-upload-action')?.addEventListener('click', () => document.getElementById('file-input')?.click());
        document.getElementById('folder-upload-action')?.addEventListener('click', () => document.getElementById('folder-input')?.click());

        document.getElementById('file-input')?.addEventListener('change', (e) => {
            const files = e.target.files;
            if (files?.length) Upload.handleFiles(files);
            e.target.value = '';
        });

        document.getElementById('folder-input')?.addEventListener('change', (e) => {
            const files = e.target.files;
            if (files?.length) Upload.handleFolderFiles(files);
            e.target.value = '';
        });

        const main = document.querySelector('.main-content');
        if (main) {
            let dragCounter = 0;
            main.addEventListener('dragenter', (e) => {
                e.preventDefault();
                if (!FileManager.canAcceptUploads()) return;
                dragCounter += 1;
                document.getElementById('drop-overlay')?.classList.remove('hidden');
            });
            main.addEventListener('dragleave', (e) => {
                e.preventDefault();
                dragCounter -= 1;
                if (dragCounter <= 0) {
                    dragCounter = 0;
                    document.getElementById('drop-overlay')?.classList.add('hidden');
                }
            });
            main.addEventListener('dragover', (e) => e.preventDefault());
            main.addEventListener('drop', async (e) => {
                e.preventDefault();
                dragCounter = 0;
                document.getElementById('drop-overlay')?.classList.add('hidden');
                if (!FileManager.canAcceptUploads()) {
                    Components.toast('Connect a computer to upload files here', 'info');
                    return;
                }
                try {
                    const files = await Upload.collectFromDataTransfer(e.dataTransfer);
                    if (files.length) Upload.uploadFileTree(files);
                } catch {
                    Components.toast('Could not read dropped files', 'error');
                }
            });
        }

        document.querySelector('.search-wrap')?.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        document.getElementById('search-options')?.addEventListener('click', (e) => {
            e.stopPropagation();
            newDropdown?.classList.add('hidden');
            helpDropdown?.classList.add('hidden');
            FileManager.hideSearchDropdown();
            searchFilterPanel?.classList.toggle('hidden');
            if (!searchFilterPanel?.classList.contains('hidden')) {
                FileManager.syncAdvancedSearchDependentFields();
            }
        });

        searchFilterPanel?.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        document.getElementById('adv-search-close')?.addEventListener('click', (e) => {
            e.stopPropagation();
            searchFilterPanel?.classList.add('hidden');
        });

        document.getElementById('adv-search-reset')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            FileManager.resetAdvancedSearchForm();
        });

        document.getElementById('adv-search-learn')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            FileManager.showAdvancedSearchHelp();
        });

        document.getElementById('filter-owner')?.addEventListener('change', () => {
            FileManager.syncAdvancedSearchDependentFields();
        });

        document.getElementById('filter-modified')?.addEventListener('change', () => {
            FileManager.syncAdvancedSearchDependentFields();
        });

        document.getElementById('search-filter-apply')?.addEventListener('click', () => {
            FileManager.applyAdvancedSearch();
            searchFilterPanel?.classList.add('hidden');
        });

        document.getElementById('help-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            newDropdown?.classList.add('hidden');
            searchFilterPanel?.classList.add('hidden');
            helpDropdown?.classList.toggle('hidden');
        });

        helpDropdown?.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        document.getElementById('help-shortcuts')?.addEventListener('click', () => FileManager.showShortcuts());
        document.getElementById('help-feedback')?.addEventListener('click', () => {
            Components.showModal('Send feedback', '<p style="margin:0;color:#5f6368;font-size:14px;line-height:1.45;">Email your administrator or open an issue in the FreeDrive repository with steps to reproduce and screenshots.</p>', [{ text: 'OK', class: 'btn-primary' }]);
        });
        document.getElementById('help-center')?.addEventListener('click', () => {
            window.open('https://github.com/abdullaabdullazade/freedrive', '_blank', 'noopener');
        });

        document.getElementById('shortcuts-close')?.addEventListener('click', () => {
            document.getElementById('shortcuts-modal-overlay')?.classList.add('hidden');
        });

        document.getElementById('notifications-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            FileManager.toggleNotificationsPanel();
        });

        document.getElementById('notifications-mark-read')?.addEventListener('click', () => FileManager.markAllNotificationsRead());

        // ── Profile dropdown toggle ──
        const profileBtn = document.getElementById('profile-avatar-btn');
        const profileDropdown = document.getElementById('profile-dropdown');

        profileBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            closeTransientPanels();
            const opening = profileDropdown?.classList.contains('hidden');
            profileDropdown?.classList.toggle('hidden');
            if (opening) populateProfileDropdown();
        });

        document.getElementById('profile-dropdown-close')?.addEventListener('click', (e) => {
            e.stopPropagation();
            profileDropdown?.classList.add('hidden');
        });

        document.getElementById('profile-manage-storage')?.addEventListener('click', (e) => {
            e.stopPropagation();
            profileDropdown?.classList.add('hidden');
            window.location.hash = '#/storage';
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#profile-dropdown, #profile-avatar-btn')) {
                profileDropdown?.classList.add('hidden');
            }
        });

        // ── Sign out ──
        document.getElementById('logout-btn')?.addEventListener('click', async () => {
            profileDropdown?.classList.add('hidden');
            try { await API.auth.logout(); } catch {}
            if (window.CryptoSync?.lockAndClearDevice) {
                await CryptoSync.lockAndClearDevice();
            }
            API.clearAuth();
            SidebarTree.invalidateAll();
            history.replaceState(null, '', '/login');
            showAuth();
        });

        document.getElementById('admin-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            history.pushState(null, '', '/admin/dashboard');
            handleRoute();
        });

        document.querySelectorAll('.admin-nav-item[href^="/admin"]').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                history.pushState(null, '', link.getAttribute('href'));
                handleRoute();
            });
        });

        document.getElementById('bulk-share')?.addEventListener('click', () => FileManager.bulkShare());
        document.getElementById('bulk-download')?.addEventListener('click', () => FileManager.bulkDownload());
        document.getElementById('bulk-move')?.addEventListener('click', () => FileManager.bulkMove());
        document.getElementById('bulk-restore')?.addEventListener('click', () => FileManager.bulkRestore());
        document.getElementById('bulk-delete')?.addEventListener('click', () => FileManager.bulkDelete());

        document.getElementById('free-space-btn')?.addEventListener('click', () => FileManager.showLargestFiles());

        document.getElementById('details-close')?.addEventListener('click', () => FileManager.hideDetailsPanel());
        document.getElementById('details-share-btn')?.addEventListener('click', () => FileManager.shareSelectedItem());
        document.getElementById('details-share-btn2')?.addEventListener('click', () => FileManager.shareSelectedItem());
        document.getElementById('details-download-btn')?.addEventListener('click', () => FileManager.downloadSelected());
        document.getElementById('details-rename-btn')?.addEventListener('click', () => FileManager.renameSelected());
        document.getElementById('details-delete-btn')?.addEventListener('click', () => FileManager.deleteSelected());

        document.getElementById('share-modal-close')?.addEventListener('click', () => FileManager.closeShareModal());
        document.getElementById('share-done')?.addEventListener('click', async () => {
            try {
                await FileManager.saveShareModal();
            } catch (err) {
                Components.toast(err?.message || 'Failed to save sharing settings', 'error');
            }
        });
        document.getElementById('share-copy-link')?.addEventListener('click', async () => {
            try { await FileManager.copyCurrentShareLink(); } catch { Components.toast('Failed to copy link', 'error'); }
        });
        document.getElementById('share-copy-link-footer')?.addEventListener('click', async () => {
            try { await FileManager.copyCurrentShareLink(); } catch { Components.toast('Failed to copy link', 'error'); }
        });

        [
            'new-folder-action',
            'file-upload-action',
            'folder-upload-action',
            'new-doc-action',
            'new-sheet-action',
            'new-presentation-action',
        ].forEach((id) => {
            document.getElementById(id)?.addEventListener('click', () => {
                newDropdown?.classList.add('hidden');
            });
        });

        document.addEventListener('keydown', (e) => FileManager.handleShortcut(e));
    }

    function showAuth() {
        const app = document.getElementById('app');
        app?.classList.remove('admin-mode', 'admin-drive-access');
        document.getElementById('admin-btn')?.classList.add('hidden');
        document.getElementById('auth-screen').classList.remove('hidden');
        app?.classList.add('hidden');
    }

    async function showApp() {
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');

        const user = API.getUser();
        if (user) {
            // Prefer server profile over stale localStorage avatar/name cache.
            if (user.avatar_url) syncAvatarCache(user.avatar_url);
            refreshUserUI();
            await refreshProfileFromServer();
        } else {
            syncAdminBtnVisibility();
        }

        const prefs = getUserPrefs();
        applyTheme(prefs.theme || 'system');
        if (!window.location.hash && prefs.startPage) {
            window.location.hash = prefs.startPage;
        }

        SidebarTree.init();
        if (window.CryptoSync?.ensureUnlockedOnAppLoad) {
            await CryptoSync.ensureUnlockedOnAppLoad();
        }
        handleRoute();
    }

    function setLayoutMode(isAdminMode) {
        const app = document.getElementById('app');
        app?.classList.toggle('admin-mode', Boolean(isAdminMode));
        if (isAdminMode) {
            document.getElementById('details-panel')?.classList.add('hidden');
            document.getElementById('notifications-panel')?.classList.add('hidden');
            app?.classList.remove('details-open');
        }
        syncAdminBtnVisibility();
    }

    function setActiveNav(page) {
        document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
        document.getElementById(`nav-${page}`)?.classList.add('active');
    }

    async function handleRoute() {
        if (!API.isLoggedIn()) return;

        try {
        let pathRoute = window.location.pathname;
        let hash = window.location.hash;

        // If they navigate to /admin fallback or root
        if (pathRoute === '/admin') {
            history.replaceState(null, '', '/admin/dashboard');
            pathRoute = '/admin/dashboard';
        }

        const user = API.getUser() || {};
        const isAdminRoute = pathRoute.startsWith('/admin') || hash === '#/admin' || hash.startsWith('#/admin/');

        if (isAdminRoute) {
            if (String(user.role || '').toLowerCase() !== 'admin') {
                Components.toast('Admin access required', 'error');
                setLayoutMode(false);
                window.location.hash = '#/files';
                return;
            }

            setLayoutMode(true);
            let section = 'dashboard';
            
            if (hash.startsWith('#/admin/')) {
                section = (hash.split('/')[2] || 'dashboard').toLowerCase();
                // Sync path with the hash navigation
                history.replaceState(null, '', `/admin/${section}`);
                // Clear the hash so it doesn't stay in the URL
                if (window.location.hash) {
                    history.replaceState(null, '', `/admin/${section}`);
                }
            } else if (pathRoute.startsWith('/admin/')) {
                section = (pathRoute.split('/')[2] || 'dashboard').toLowerCase();
            }

            setActiveNav(`admin-${section}`);
            AdminPanel.load(section);
            return;
        }

        hash = hash || '#/files';
        setLayoutMode(false);

        if (hash === '#/home') {
            setActiveNav('home');
            FileManager.loadHome();
            return;
        }
        if (hash === '#/recent') {
            setActiveNav('recent');
            FileManager.loadRecent();
            return;
        }
        if (hash === '#/computers' || hash.startsWith('#/computers/')) {
            setActiveNav('computers');
            const folderId = hash.startsWith('#/computers/') ? hash.split('/')[2] : null;
            FileManager.loadComputerFolder(folderId);
            return;
        }
        if (hash === '#/starred') {
            setActiveNav('starred');
            FileManager.loadStarred();
            return;
        }
        if (hash === '#/shared-with') {
            setActiveNav('shared-with');
            FileManager.loadSharedWithMe();
            return;
        }
        if (hash === '#/shared-by') {
            window.location.replace('#/files');
            return;
        }
        if (hash === '#/offline') {
            setActiveNav('offline');
            FileManager.loadOffline();
            return;
        }
        if (hash === '#/trash') {
            setActiveNav('trash');
            FileManager.loadTrash();
            return;
        }
        if (hash === '#/activity') {
            setActiveNav('activity');
            FileManager.loadActivity();
            return;
        }
        if (hash === '#/storage') {
            setActiveNav('storage');
            FileManager.loadStoragePage();
            return;
        }
        if (hash.startsWith('#/open/')) {
            const openPart = hash.slice('#/open/'.length);
            const [fileId, rawQuery = ''] = openPart.split('?');
            const query = new URLSearchParams(rawQuery);
            const sharedKey = query.get('k') || '';
            setActiveNav('files');
            FileManager.loadFolder(null);
            SidebarTree.syncWithRoute();
            if (fileId) {
                setTimeout(async () => {
                    try {
                        if (sharedKey) {
                            try {
                                const keyObj = await CryptoModule.importKey(sharedKey);
                                await CryptoModule.storeKey(fileId, keyObj);
                            } catch {
                                // Continue; open flow will report if decryption fails.
                            }
                        }
                        const file = await API.files.get(fileId);
                        if (file) FileManager.openFileById(file);
                    } catch {
                        Components.toast('File not found or access denied', 'error');
                    }
                }, 400);
            }
            return;
        }

        if (hash.startsWith('#/files')) {
            setActiveNav('files');
            const folderId = hash.split('/')[2] || null;
            FileManager.loadFolder(folderId);
            SidebarTree.syncWithRoute();
            return;
        }

        window.location.hash = '#/files';
        } finally {
            syncAdminBtnVisibility();
        }
    }

    function initRipple() {
        const RIPPLE_SEL = '.btn, .btn-icon, .nav-item, .upload-btn, .context-item, .md3-chip-btn, .link-btn, .tab-btn, .sort-col';

        function attachRipple(el) {
            if (el._rippleBound) return;
            el._rippleBound = true;
            el.addEventListener('pointerdown', (e) => {
                const rect = el.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const size = Math.max(rect.width, rect.height) * 2;

                const wave = document.createElement('span');
                wave.className = 'ripple-wave';
                wave.style.cssText = `
                    width:${size}px; height:${size}px;
                    left:${x - size/2}px; top:${y - size/2}px;
                `;
                el.style.position = el.style.position || 'relative';
                el.style.overflow = 'hidden';
                el.appendChild(wave);

                wave.addEventListener('animationend', () => wave.remove(), { once: true });
            });
        }

        document.querySelectorAll(RIPPLE_SEL).forEach(attachRipple);

        // also attach to dynamically added elements via delegation
        document.addEventListener('pointerdown', (e) => {
            const el = e.target.closest(RIPPLE_SEL);
            if (el) attachRipple(el);
        }, true);
    }

    return {
        init,
        showAuth,
        showApp,
        handleRoute,
    };
})();

document.addEventListener('DOMContentLoaded', App.init);
