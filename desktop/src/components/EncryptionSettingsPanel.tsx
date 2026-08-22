interface EncryptionSettingsPanelProps {
  serverUrl: string | null;
  settingsError: string;
  keysImportMessage: string;
  keysImporting: boolean;
  keysExporting: boolean;
  cryptoUnlocked: boolean;
  serverHasCrypto: boolean;
  cryptoUnlockError: string;
  needsCryptoRecovery: boolean;
  recoveryCode: string;
  recoveryUnlocking: boolean;
  rotatePassword: string;
  rotatingKey: boolean;
  onRecoveryCodeChange: (value: string) => void;
  onRotatePasswordChange: (value: string) => void;
  onUnlockRecovery: () => void;
  onRotateCryptoKey: () => void;
  onExportKeys: () => void;
  onImportKeys: () => void;
  onBack?: () => void;
  embedded?: boolean;
}

export function EncryptionSettingsPanel({
  serverUrl,
  settingsError,
  keysImportMessage,
  keysImporting,
  keysExporting,
  cryptoUnlocked,
  serverHasCrypto,
  cryptoUnlockError,
  needsCryptoRecovery,
  recoveryCode,
  recoveryUnlocking,
  rotatePassword,
  rotatingKey,
  onRecoveryCodeChange,
  onRotatePasswordChange,
  onUnlockRecovery,
  onRotateCryptoKey,
  onExportKeys,
  onImportKeys,
  onBack,
  embedded = false,
}: EncryptionSettingsPanelProps) {
  return (
    <div className={`encryption-settings-panel${embedded ? " settings-panel-embedded" : ""}`}>
      {!embedded && onBack && (
        <button type="button" className="preferences-back-btn" onClick={onBack}>
          ← Settings
        </button>
      )}
      {!embedded && <h2>Encryption &amp; keys</h2>}
      {settingsError && <div className="error-banner">{settingsError}</div>}
      {!embedded && (
        <div className="form-group">
          <label>Server URL</label>
          <p className="settings-info-value">{serverUrl || "—"}</p>
        </div>
      )}
      <div className="form-group">
        <label>Encryption</label>
        {needsCryptoRecovery && (
          <div className="error-banner" style={{ marginBottom: 12 }}>
            Server lost encryption account data, but encrypted file keys are still on the server.
            Enter your recovery code below to restore access.
          </div>
        )}
        {cryptoUnlockError && (
          <div className="error-banner" style={{ marginBottom: 12 }}>
            {cryptoUnlockError}
          </div>
        )}
        {serverHasCrypto && !cryptoUnlocked && !cryptoUnlockError && !needsCryptoRecovery && (
          <div className="error-banner" style={{ marginBottom: 12 }}>
            Encryption is active on the server but not unlocked on this device. Sign out and sign
            in again with your password.
          </div>
        )}
        <p className="settings-hint">
          {cryptoUnlocked
            ? "Encryption is unlocked on this device. Keys sync across your devices."
            : serverHasCrypto
              ? "Encryption is configured on the server but not unlocked on this device. Sign out and sign in again with your password."
              : "Encryption unlocks automatically when you sign in. Keys sync across your devices."}
        </p>
        {needsCryptoRecovery && (
          <>
            <input
              type="text"
              placeholder="xxxx-xxxx-..."
              value={recoveryCode}
              onChange={(e) => onRecoveryCodeChange(e.target.value)}
              style={{ width: "100%", marginBottom: 8 }}
            />
            <button
              type="button"
              className="btn-secondary"
              style={{ marginBottom: 12 }}
              onClick={onUnlockRecovery}
              disabled={recoveryUnlocking}
            >
              {recoveryUnlocking ? "Restoring…" : "Restore encryption"}
            </button>
          </>
        )}
        <details className="settings-advanced" style={{ marginBottom: 12 }}>
          <summary style={{ cursor: "pointer", fontSize: 13, color: "#9aa0a6" }}>
            Advanced: rotate encryption key
          </summary>
          <p className="settings-hint" style={{ marginTop: 8 }}>
            Use if you suspect your encryption key was compromised. Requires your password.
          </p>
          <input
            type="password"
            placeholder="Account password"
            value={rotatePassword}
            onChange={(e) => onRotatePasswordChange(e.target.value)}
            style={{ width: "100%" }}
          />
          <button
            type="button"
            className="btn-secondary"
            style={{ marginTop: 8 }}
            onClick={onRotateCryptoKey}
            disabled={rotatingKey}
          >
            {rotatingKey ? "Rotating…" : "Rotate encryption key"}
          </button>
        </details>
        <label>Manual backup (optional)</label>
        <p className="settings-hint">
          Export/import below only if you need to move keys manually between devices.
        </p>
        {keysImportMessage && <div className="success-banner">{keysImportMessage}</div>}
        <div
          className="settings-actions"
          style={{ marginBottom: 0, justifyContent: "flex-start", gap: 8 }}
        >
          <button
            type="button"
            className="btn-secondary"
            onClick={onExportKeys}
            disabled={keysExporting || keysImporting}
          >
            {keysExporting ? "Exporting…" : "Export encryption keys"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={onImportKeys}
            disabled={keysExporting || keysImporting}
          >
            {keysImporting ? "Importing…" : "Import encryption keys"}
          </button>
        </div>
      </div>
    </div>
  );
}
