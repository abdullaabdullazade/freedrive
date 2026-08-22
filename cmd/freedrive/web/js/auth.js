// ========================================
// FreeDrive — Auth UI
// ========================================

const Auth = (() => {
    let pendingLoginPassword = '';
    let approvalPollTimer = null;

    function friendlyAuthError(err) {
        const raw = String(err?.message || err || '').trim();
        const lower = raw.toLowerCase();
        if (!raw || lower === 'failed to fetch' || lower.includes('networkerror') || lower.includes('load failed')) {
            return 'Cannot reach the server. Check the FreeDrive URL (HTTPS / reverse proxy) and try again.';
        }
        if (lower.includes('session expired')) {
            return 'Session expired. Please sign in again.';
        }
        if (lower.includes('invalid email or password')) {
            return 'Invalid email or password. Use the exact email from account registration (Admin → Users if unsure).';
        }
        if (lower.includes('must match the invite email')) {
            return 'This invite requires the email address it was sent to. Check the invite email or ask your admin for a new invite.';
        }
        if (lower.includes('account suspended')) {
            return 'Your account has been suspended. Contact your FreeDrive administrator.';
        }
        if (lower.includes('registration is closed')) {
            return 'New account registration is currently closed.';
        }
        if (lower.includes('verification code') || lower.includes('two-factor')) {
            return raw;
        }
        if (lower.includes('access denied from this network')) {
            return 'Sign-in is not allowed from this network. Contact your administrator.';
        }
        return raw || 'Something went wrong. Please try again.';
    }

    function showTwoFAForm(challengeId, emailMasked, method, methodsAvailable) {
        stopApprovalPoll();
        document.getElementById('login-form')?.classList.add('hidden');
        document.getElementById('register-form')?.classList.add('hidden');
        document.getElementById('reset-form')?.classList.add('hidden');
        document.getElementById('confirm-email-form')?.classList.add('hidden');
        document.getElementById('login-approval-form')?.classList.add('hidden');
        document.querySelector('.auth-tabs')?.classList.add('hidden');

        const form = document.getElementById('twofa-form');
        form?.classList.remove('hidden');

        const titleEl = document.querySelector('.auth-logo h1');
        const subtitleEl = document.querySelector('.auth-logo .tagline');
        if (titleEl) titleEl.textContent = 'Verify sign-in';
        if (subtitleEl) subtitleEl.textContent = 'two-factor authentication';

        const activeMethod = method === 'totp' ? 'totp' : 'email';
        const methods = Array.isArray(methodsAvailable) ? methodsAvailable : [];
        const methodInput = document.getElementById('twofa-method');
        if (methodInput) methodInput.value = activeMethod;

        const messageEl = document.getElementById('twofa-message');
        if (messageEl) {
            if (activeMethod === 'totp') {
                messageEl.textContent = 'Enter the 6-digit code from your authenticator app (or a backup code).';
            } else {
                messageEl.textContent = emailMasked
                    ? `Enter the 6-digit code sent to ${emailMasked}.`
                    : 'Enter the 6-digit code sent to your email.';
            }
        }

        const sendEmailBtn = document.getElementById('twofa-send-email-btn');
        if (sendEmailBtn) {
            const canFallback = activeMethod === 'totp' && methods.includes('email');
            sendEmailBtn.classList.toggle('hidden', !canFallback);
        }

        const challengeInput = document.getElementById('twofa-challenge-id');
        if (challengeInput) challengeInput.value = challengeId || '';

        const codeInput = document.getElementById('twofa-code');
        if (codeInput) {
            codeInput.value = '';
            codeInput.placeholder = activeMethod === 'totp' ? 'Authenticator or backup code' : '6-digit code';
            codeInput.focus();
        }
        clearFormError('twofa-error');
    }

    function showLoginForm() {
        stopApprovalPoll();
        document.getElementById('twofa-form')?.classList.add('hidden');
        document.getElementById('login-approval-form')?.classList.add('hidden');
        document.getElementById('register-form')?.classList.add('hidden');
        document.getElementById('reset-form')?.classList.add('hidden');
        document.getElementById('confirm-email-form')?.classList.add('hidden');
        document.getElementById('login-form')?.classList.remove('hidden');
        document.querySelector('.auth-tabs')?.classList.remove('hidden');

        const titleEl = document.querySelector('.auth-logo h1');
        const subtitleEl = document.querySelector('.auth-logo .tagline');
        if (titleEl) titleEl.textContent = 'Sign in';
        if (subtitleEl) subtitleEl.textContent = 'to continue to FreeDrive';
        clearFormError('login-error');
        clearFormError('twofa-error');
        clearFormError('login-approval-error');
    }

    function stopApprovalPoll() {
        if (approvalPollTimer) {
            clearTimeout(approvalPollTimer);
            approvalPollTimer = null;
        }
    }

    function showLoginApprovalForm(challengeId, challengeToken, deviceName) {
        stopApprovalPoll();
        document.getElementById('login-form')?.classList.add('hidden');
        document.getElementById('register-form')?.classList.add('hidden');
        document.getElementById('reset-form')?.classList.add('hidden');
        document.getElementById('confirm-email-form')?.classList.add('hidden');
        document.getElementById('twofa-form')?.classList.add('hidden');
        document.querySelector('.auth-tabs')?.classList.add('hidden');
        document.getElementById('login-approval-form')?.classList.remove('hidden');

        const titleEl = document.querySelector('.auth-logo h1');
        const subtitleEl = document.querySelector('.auth-logo .tagline');
        if (titleEl) titleEl.textContent = 'Check your phone';
        if (subtitleEl) subtitleEl.textContent = 'confirm sign-in';

        document.getElementById('login-approval-id').value = challengeId || '';
        document.getElementById('login-approval-token').value = challengeToken || '';
        const msg = document.getElementById('login-approval-message');
        if (msg) {
            msg.innerHTML = deviceName
                ? `Open FreeDrive on your phone and tap <strong>Yes, it's me</strong> to approve sign-in to <strong>${Components.escapeHtml(deviceName)}</strong>.`
                : `Open FreeDrive on your phone and tap <strong>Yes, it's me</strong> to finish signing in.`;
        }
        clearFormError('login-approval-error');
        scheduleApprovalPoll();
    }

    function scheduleApprovalPoll() {
        stopApprovalPoll();
        approvalPollTimer = setTimeout(async () => {
            const id = document.getElementById('login-approval-id')?.value;
            const token = document.getElementById('login-approval-token')?.value;
            if (!id || !token) return;
            try {
                const data = await API.auth.pollLoginApproval(id, token);
                if (data?.status === 'pending') {
                    scheduleApprovalPoll();
                    return;
                }
                if (data?.status === 'denied') {
                    setFormError('login-approval-error', 'Sign-in denied on your phone.');
                    return;
                }
                if (data?.status === 'expired') {
                    setFormError('login-approval-error', 'Sign-in request expired.');
                    return;
                }
                if (data?.status === 'approved' && data?.tokens) {
                    stopApprovalPoll();
                    await completeLogin(data, pendingLoginPassword);
                    pendingLoginPassword = '';
                    return;
                }
                scheduleApprovalPoll();
            } catch (err) {
                setFormError('login-approval-error', friendlyAuthError(err));
                scheduleApprovalPoll();
            }
        }, 2000);
    }

    async function completeLogin(data, password) {
        if (!data?.tokens?.access_token || !data?.user) {
            throw new Error('Login response was incomplete. Please try again.');
        }
        API.setTokens(data.tokens);
        API.setUser(data.user);
        if (data.user?.avatar_url) {
            try {
                const prefs = JSON.parse(localStorage.getItem('fd_user_prefs') || '{}') || {};
                prefs.profileAvatar = data.user.avatar_url;
                localStorage.setItem('fd_user_prefs', JSON.stringify(prefs));
                localStorage.setItem('fd_profile_photo', data.user.avatar_url);
            } catch { /* ignore */ }
        }
        if (password && window.CryptoSync?.ensureUnlockedAfterLogin) {
            await CryptoSync.ensureUnlockedAfterLogin(password);
        }
        Components.toast('Welcome back, ' + (data.user.username || data.user.email) + '!', 'success');
        history.replaceState(null, '', '/');
        App.showApp();
    }

    function setFormError(id, message) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = message || '';
    }

    function clearFormError(id) {
        setFormError(id, '');
    }

    function showForgotPasswordHelp() {
        const loginEmail = String(document.getElementById('login-email')?.value || '').trim();
        Components.showModal(
            'Forgot password',
            `<p style="margin:0 0 12px;color:#5f6368;font-size:14px;line-height:1.45;">
                Enter the email on your FreeDrive account. If it exists, we will send a reset link (requires SMTP).
            </p>
            <input id="forgot-email-input" type="email" autocomplete="email"
                style="width:100%;height:48px;padding:0 14px;border-radius:8px;border:1px solid #dadce0;font-size:15px;box-sizing:border-box;"
                value="${Components.escapeHtml(loginEmail)}" placeholder="you@example.com">`,
            [
                { text: 'Cancel', class: 'btn-secondary' },
                {
                    text: 'Send reset link',
                    class: 'btn-primary',
                    action: async () => {
                        const email = String(document.getElementById('forgot-email-input')?.value || '').trim().toLowerCase();
                        if (!email) {
                            Components.toast('Enter your account email', 'error');
                            return false;
                        }
                        try {
                            await API.auth.forgotPassword(email);
                            Components.toast('If that account exists, a reset link was sent.', 'success');
                        } catch (err) {
                            Components.toast(err?.message || 'Failed to send reset link', 'error');
                            return false;
                        }
                    },
                },
            ]
        );
        setTimeout(() => document.getElementById('forgot-email-input')?.focus(), 50);
    }

    function init() {
        // Tab switching
        document.querySelectorAll('.auth-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                const tabName = tab.dataset.tab;
                stopApprovalPoll();
                document.getElementById('login-form').classList.toggle('hidden', tabName !== 'login');
                document.getElementById('register-form').classList.toggle('hidden', tabName !== 'register');
                document.getElementById('login-approval-form')?.classList.add('hidden');
                document.getElementById('twofa-form')?.classList.add('hidden');
                clearFormError('login-error');
                clearFormError('register-error');
            });
        });

        document.getElementById('forgot-password-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            showForgotPasswordHelp();
        });

        document.getElementById('twofa-back-btn')?.addEventListener('click', () => {
            showLoginForm();
        });

        document.getElementById('login-approval-back-btn')?.addEventListener('click', () => {
            showLoginForm();
        });

        document.getElementById('twofa-send-email-btn')?.addEventListener('click', async () => {
            const challengeId = String(document.getElementById('twofa-challenge-id')?.value || '').trim();
            const btn = document.getElementById('twofa-send-email-btn');
            clearFormError('twofa-error');
            if (!challengeId) return;
            try {
                if (btn) btn.disabled = true;
                const data = await API.auth.send2FAEmail(challengeId);
                showTwoFAForm(data.challenge_id, data.email_masked, data.method, data.methods_available);
                Components.toast('Verification code sent by email', 'success');
            } catch (err) {
                const msg = friendlyAuthError(err);
                setFormError('twofa-error', msg);
                Components.toast(msg, 'error');
            } finally {
                if (btn) btn.disabled = false;
            }
        });

        document.getElementById('twofa-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const challengeId = String(document.getElementById('twofa-challenge-id')?.value || '').trim();
            const code = String(document.getElementById('twofa-code')?.value || '').trim();
            const method = String(document.getElementById('twofa-method')?.value || 'email');
            const btn = document.getElementById('twofa-btn');
            clearFormError('twofa-error');

            const minLen = method === 'totp' ? 6 : 6;
            if (!challengeId || code.length < minLen) {
                const msg = method === 'totp'
                    ? 'Enter an authenticator code or backup code'
                    : 'Enter the 6-digit verification code';
                setFormError('twofa-error', msg);
                Components.toast(msg, 'error');
                return;
            }

            try {
                btn.disabled = true;
                btn.querySelector('.btn-loader').classList.remove('hidden');
                btn.querySelector('span').textContent = 'Verifying...';
                const data = await API.auth.verify2FA(challengeId, code);
                await completeLogin(data, pendingLoginPassword);
                pendingLoginPassword = '';
            } catch (err) {
                const msg = friendlyAuthError(err);
                setFormError('twofa-error', msg);
                Components.toast(msg, 'error');
            } finally {
                btn.disabled = false;
                btn.querySelector('.btn-loader').classList.add('hidden');
                btn.querySelector('span').textContent = 'Verify';
            }
        });

        // Parse ?invite= / ?email= from URL
        const queryParams = new URLSearchParams(window.location.search);
        const inviteCodeParam = queryParams.get('invite');
        const inviteEmailParam = String(queryParams.get('email') || '').trim().toLowerCase();
        if (inviteCodeParam) {
            document.querySelector('.auth-tab[data-tab="register"]')?.click();
            const regInput = document.getElementById('reg-invite');
            if (regInput) regInput.value = inviteCodeParam;
            const emailInput = document.getElementById('reg-email');
            if (emailInput && inviteEmailParam) {
                emailInput.value = inviteEmailParam;
                emailInput.readOnly = true;
                emailInput.title = 'This invite requires this email address';
            }
        }

        // Parse /reset-password link mode
        const inResetMode = window.location.pathname.startsWith('/reset-password');
        const inConfirmEmailMode = window.location.pathname.startsWith('/confirm-email');
        if (inResetMode) {
            const token = queryParams.get('token') || '';
            const email = queryParams.get('email') || '';
            document.getElementById('login-form')?.classList.add('hidden');
            document.getElementById('register-form')?.classList.add('hidden');
            document.getElementById('reset-form')?.classList.remove('hidden');
            document.querySelector('.auth-tabs')?.classList.add('hidden');
            const titleEl = document.querySelector('.auth-logo h1');
            const subtitleEl = document.querySelector('.auth-logo .tagline');
            if (titleEl) titleEl.textContent = 'Reset password';
            if (subtitleEl) subtitleEl.textContent = 'set a new password for your account';
            const emailInput = document.getElementById('reset-email');
            if (emailInput) emailInput.value = email;

            document.getElementById('reset-form')?.addEventListener('submit', async (e) => {
                e.preventDefault();
                const newPassword = String(document.getElementById('reset-password')?.value || '');
                const confirm = String(document.getElementById('reset-password-confirm')?.value || '');
                const finalEmail = String(document.getElementById('reset-email')?.value || '').trim().toLowerCase();
                const btn = document.getElementById('reset-btn');
                clearFormError('reset-error');

                if (!token || !finalEmail) {
                    const msg = 'Invalid reset link';
                    setFormError('reset-error', msg);
                    Components.toast(msg, 'error');
                    return;
                }
                if (newPassword.length < 6) {
                    const msg = 'Password must be at least 6 characters';
                    setFormError('reset-error', msg);
                    Components.toast(msg, 'error');
                    return;
                }
                if (newPassword !== confirm) {
                    const msg = 'Passwords do not match';
                    setFormError('reset-error', msg);
                    Components.toast(msg, 'error');
                    return;
                }

                try {
                    btn.disabled = true;
                    btn.querySelector('.btn-loader').classList.remove('hidden');
                    btn.querySelector('span').textContent = 'Resetting...';
                    const recoveryCode = String(document.getElementById('reset-recovery-code')?.value || '').trim();
                    let cryptoUpdate = null;
                    if (recoveryCode && window.CryptoSync?.buildCryptoUpdateForReset) {
                        try {
                            cryptoUpdate = await CryptoSync.buildCryptoUpdateForReset(token, finalEmail, newPassword, recoveryCode);
                        } catch (cryptoErr) {
                            const msg = cryptoErr?.message || 'Invalid recovery code';
                            setFormError('reset-error', msg);
                            Components.toast(msg, 'error');
                            return;
                        }
                    }
                    await API.auth.resetPassword(token, finalEmail, newPassword, cryptoUpdate);
                    Components.toast('Password reset successful. Please sign in.', 'success');
                    window.location.replace('/login');
                } catch (err) {
                    const msg = friendlyAuthError(err);
                    setFormError('reset-error', msg);
                    Components.toast(msg, 'error');
                } finally {
                    btn.disabled = false;
                    btn.querySelector('.btn-loader').classList.add('hidden');
                    btn.querySelector('span').textContent = 'Reset password';
                }
            });
        }

        if (inConfirmEmailMode) {
            const token = queryParams.get('token') || '';
            document.getElementById('login-form')?.classList.add('hidden');
            document.getElementById('register-form')?.classList.add('hidden');
            document.getElementById('reset-form')?.classList.add('hidden');
            document.getElementById('confirm-email-form')?.classList.remove('hidden');
            document.querySelector('.auth-tabs')?.classList.add('hidden');
            const titleEl = document.querySelector('.auth-logo h1');
            const subtitleEl = document.querySelector('.auth-logo .tagline');
            if (titleEl) titleEl.textContent = 'Confirm email';
            if (subtitleEl) subtitleEl.textContent = 'verify your new FreeDrive address';

            const messageEl = document.getElementById('confirm-email-message');
            const loginBtn = document.getElementById('confirm-email-login-btn');

            if (!token) {
                const msg = 'Invalid confirmation link';
                setFormError('confirm-email-error', msg);
                if (messageEl) messageEl.textContent = msg;
                Components.toast(msg, 'error');
                return;
            }

            (async () => {
                try {
                    const data = await API.auth.confirmEmail(token);
                    const newEmail = String(data?.email || '').trim();
                    const successMsg = newEmail
                        ? `Email updated to ${newEmail}. Sign in with your new address.`
                        : 'Email updated. Please sign in with your new address.';
                    if (messageEl) messageEl.textContent = successMsg;
                    clearFormError('confirm-email-error');
                    Components.toast('Email confirmed. Please sign in.', 'success');
                    API.clearAuth();
                    loginBtn?.classList.remove('hidden');
                    history.replaceState(null, '', '/');
                } catch (err) {
                    const msg = friendlyAuthError(err);
                    if (/invalid|expired/i.test(msg)) {
                        setFormError('confirm-email-error', 'This confirmation link is invalid or has expired.');
                        if (messageEl) messageEl.textContent = 'This confirmation link is invalid or has expired.';
                    } else {
                        setFormError('confirm-email-error', msg);
                        if (messageEl) messageEl.textContent = msg;
                    }
                    Components.toast(msg, 'error');
                }
            })();

            loginBtn?.addEventListener('click', () => {
                window.location.replace('/login');
            });
        }

        // Login form
        document.getElementById('login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = String(document.getElementById('login-email').value || '').trim().toLowerCase();
            const password = document.getElementById('login-password').value;
            const btn = document.getElementById('login-btn');
            clearFormError('login-error');

            try {
                btn.disabled = true;
                btn.querySelector('.btn-loader').classList.remove('hidden');
                btn.querySelector('span').textContent = 'Signing in...';

                const data = await API.auth.login(email, password);
                if (data?.requires_login_approval) {
                    pendingLoginPassword = password;
                    showLoginApprovalForm(data.challenge_id, data.challenge_token, data.pending_device_name);
                    return;
                }
                if (data?.requires_2fa) {
                    pendingLoginPassword = password;
                    showTwoFAForm(data.challenge_id, data.email_masked, data.method, data.methods_available);
                    return;
                }
                await completeLogin(data, password);
            } catch (err) {
                const msg = friendlyAuthError(err);
                setFormError('login-error', msg);
                Components.toast(msg, 'error');
            } finally {
                btn.disabled = false;
                btn.querySelector('.btn-loader').classList.add('hidden');
                btn.querySelector('span').textContent = 'Sign In';
            }
        });

        // Register form
        document.getElementById('register-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('reg-username').value;
            const email = String(document.getElementById('reg-email').value || '').trim().toLowerCase();
            const password = document.getElementById('reg-password').value;
            const inviteCode = String(document.getElementById('reg-invite').value || '').trim();
            const btn = document.getElementById('register-btn');
            clearFormError('register-error');

            try {
                btn.disabled = true;
                btn.querySelector('.btn-loader').classList.remove('hidden');
                btn.querySelector('span').textContent = 'Creating account...';

                await API.auth.register(email, username, password, inviteCode);

                // Auto-login after registration
                const data = await API.auth.login(email, password);
                if (data?.requires_login_approval) {
                    pendingLoginPassword = password;
                    showLoginApprovalForm(data.challenge_id, data.challenge_token, data.pending_device_name);
                    return;
                }
                if (data?.requires_2fa) {
                    pendingLoginPassword = password;
                    showTwoFAForm(data.challenge_id, data.email_masked, data.method, data.methods_available);
                    return;
                }
                await completeLogin(data, password);
            } catch (err) {
                const msg = friendlyAuthError(err);
                setFormError('register-error', msg);
                Components.toast(msg, 'error');
            } finally {
                btn.disabled = false;
                btn.querySelector('.btn-loader').classList.add('hidden');
                btn.querySelector('span').textContent = 'Create Account';
            }
        });

        if (window.location.pathname === '/login') {
            const notice = sessionStorage.getItem('fd_auth_notice');
            if (notice) {
                sessionStorage.removeItem('fd_auth_notice');
                showLoginForm();
                setFormError('login-error', notice);
            }
        }
    }

    return { init };
})();
