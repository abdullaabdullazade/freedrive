import { useEffect, useRef, useState } from "react";
import { api } from "../api/tauri";
import { Logo } from "../components/Logo";

interface SignInProps {
  defaultServerUrl?: string;
  onSuccess: () => void;
}

export function SignIn({ defaultServerUrl = "http://localhost:8080", onSuccess }: SignInProps) {
  const [serverUrl, setServerUrl] = useState(defaultServerUrl);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [registerMode, setRegisterMode] = useState(false);
  const [username, setUsername] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [twoFactor, setTwoFactor] = useState<{
    challenge_id: string;
    email_masked: string;
    method: string;
    methods_available: string[];
  } | null>(null);
  const [loginApproval, setLoginApproval] = useState<{
    challenge_id: string;
    challenge_token: string;
    pending_device_name?: string;
  } | null>(null);
  const [code, setCode] = useState("");
  const pollStop = useRef(false);

  useEffect(() => {
    if (!loginApproval) return;
    pollStop.current = false;
    const tick = async () => {
      if (pollStop.current || !loginApproval) return;
      try {
        const result = await api.pollLoginApproval(
          serverUrl,
          loginApproval.challenge_id,
          loginApproval.challenge_token,
          password,
        );
        if (result.type === "success") {
          pollStop.current = true;
          onSuccess();
          return;
        }
        if (result.type === "login_approval") {
          // still waiting
        }
      } catch (err) {
        pollStop.current = true;
        setError(String(err));
        setLoginApproval(null);
        setLoading(false);
        return;
      }
      if (!pollStop.current) {
        window.setTimeout(() => void tick(), 2000);
      }
    };
    setLoading(true);
    void tick();
    return () => {
      pollStop.current = true;
    };
  }, [loginApproval, serverUrl, password, onSuccess]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await api.login(serverUrl, email, password);
      if (result.type === "two_factor") {
        setTwoFactor({
          challenge_id: result.challenge_id,
          email_masked: result.email_masked,
          method: result.method || "email",
          methods_available: result.methods_available || [],
        });
        setCode("");
        setLoading(false);
      } else if (result.type === "login_approval") {
        setLoginApproval({
          challenge_id: result.challenge_id,
          challenge_token: result.challenge_token,
          pending_device_name: result.pending_device_name,
        });
      } else {
        onSuccess();
        setLoading(false);
      }
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  };

  const handle2FA = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!twoFactor) return;
    setError("");
    setLoading(true);
    try {
      await api.verify2FA(serverUrl, twoFactor.challenge_id, code, password);
      onSuccess();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      await api.register(serverUrl, email, username, password, inviteCode);
      setRegisterMode(false);
      setPassword("");
      setInviteCode("");
      setSuccess("Account created. You can sign in now.");
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSendEmail = async () => {
    if (!twoFactor) return;
    setError("");
    setLoading(true);
    try {
      const result = await api.send2FAEmail(serverUrl, twoFactor.challenge_id);
      if (result.type === "two_factor") {
        setTwoFactor({
          challenge_id: result.challenge_id,
          email_masked: result.email_masked,
          method: result.method || "email",
          methods_available: result.methods_available || [],
        });
        setCode("");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const isTotp = twoFactor?.method === "totp";
  const canEmailFallback = Boolean(
    twoFactor && isTotp && twoFactor.methods_available.includes("email"),
  );

  return (
    <div className="signin-layout">
      <div className="signin-left">
        <div className="signin-header">
          <Logo />
          <button type="button" className="icon-btn">⋮</button>
        </div>

        {loginApproval ? (
          <>
            <h1 className="signin-title">Check your phone</h1>
            <p className="signin-subtitle">
              Open FreeDrive on your phone and tap <strong>Yes, it&apos;s me</strong> to finish
              signing in
              {loginApproval.pending_device_name
                ? ` to ${loginApproval.pending_device_name}`
                : ""}
              .
            </p>
            {error && <div className="error-banner">{error}</div>}
            <p className="signin-subtitle">Waiting for approval…</p>
            <button
              type="button"
              className="btn-text"
              onClick={() => {
                pollStop.current = true;
                setLoginApproval(null);
                setLoading(false);
              }}
            >
              Cancel
            </button>
          </>
        ) : !twoFactor ? (
          <>
            <h1 className="signin-title">{registerMode ? "Create your account" : "Sign in to get started"}</h1>
            <p className="signin-subtitle">
              {registerMode
                ? "Create an account directly on your FreeDrive server."
                : "Connect this desktop app to your FreeDrive server."}
            </p>
            {error && <div className="error-banner">{error}</div>}
            {success && <div className="success-banner">{success}</div>}
            <form onSubmit={registerMode ? handleRegister : handleLogin}>
              <div className="form-group">
                <label htmlFor="server">Server URL</label>
                <input
                  id="server"
                  type="url"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="https://drive.example.com"
                  required
                />
              </div>
              {registerMode && (
                <div className="form-group">
                  <label htmlFor="username">Username</label>
                  <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
                </div>
              )}
              <div className="form-group">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {registerMode && (
                <div className="form-group">
                  <label htmlFor="invite-code">Invite code <span className="settings-hint">(if required)</span></label>
                  <input id="invite-code" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} autoComplete="off" />
                </div>
              )}
              <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={loading}>
                  {loading ? (registerMode ? "Creating…" : "Signing in…") : (registerMode ? "Create account" : "Sign in")}
                </button>
                <button type="button" className="btn-text" onClick={() => { setError(""); setSuccess(""); setRegisterMode((value) => !value); }}>
                  {registerMode ? "Back to sign in" : "Create account"}
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <h1 className="signin-title">Two-factor authentication</h1>
            <p className="signin-subtitle">
              {isTotp
                ? "Enter the code from your authenticator app (or a backup code)."
                : `Enter the code sent to ${twoFactor.email_masked}`}
            </p>
            {error && <div className="error-banner">{error}</div>}
            <form onSubmit={handle2FA}>
              <div className="form-group">
                <label htmlFor="code">{isTotp ? "Authenticator code" : "Email code"}</label>
                <input
                  id="code"
                  type="text"
                  inputMode={isTotp ? "text" : "numeric"}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
              </div>
              <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={loading}>
                  Verify
                </button>
                {canEmailFallback ? (
                  <button
                    type="button"
                    className="btn-text"
                    onClick={handleSendEmail}
                    disabled={loading}
                  >
                    Send code by email
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn-text"
                  onClick={() => setTwoFactor(null)}
                >
                  Back
                </button>
              </div>
            </form>
          </>
        )}
      </div>
      <div className="signin-right">
        <div className="signin-illustration" aria-hidden>
          <img src="/logo.svg" alt="" />
          <strong>FreeDrive</strong>
          <span>Your files, securely available on this device.</span>
        </div>
      </div>
    </div>
  );
}
