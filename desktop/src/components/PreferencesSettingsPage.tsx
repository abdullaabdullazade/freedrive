import { api } from "../api/tauri";
import { EncryptionSettingsPanel } from "./EncryptionSettingsPanel";
import { ExplorerIntegrationPanel } from "./ExplorerIntegrationPanel";
import type { useEncryptionSettings } from "../hooks/useEncryptionSettings";
import { AdvancedSyncSettings } from "./AdvancedSyncSettings";

type EncryptionState = ReturnType<typeof useEncryptionSettings>;

interface PreferencesSettingsPageProps {
  serverUrl: string | null;
  launchOnLogin: boolean;
  startMinimized: boolean;
  onBackToSync: () => void;
  onLaunchOnLoginChange: (enabled: boolean) => void;
  onStartMinimizedChange: (enabled: boolean) => void;
  encryption: EncryptionState;
}

export function PreferencesSettingsPage({
  serverUrl,
  launchOnLogin,
  startMinimized,
  onBackToSync,
  onLaunchOnLoginChange,
  onStartMinimizedChange,
  encryption,
}: PreferencesSettingsPageProps) {
  return (
    <div className="preferences-settings-page">
      <button type="button" className="preferences-settings-back" onClick={onBackToSync}>
        ← FreeDrive
      </button>

      <section className="preferences-settings-section">
        <h3>Launch</h3>
        <label className="preferences-settings-checkbox-row">
          <input
            type="checkbox"
            checked={launchOnLogin}
            onChange={(e) => onLaunchOnLoginChange(e.target.checked)}
          />
          <span>Launch FreeDrive when you log in to your computer</span>
        </label>
        <label className="preferences-settings-checkbox-row">
          <input
            type="checkbox"
            checked={startMinimized}
            onChange={(e) => onStartMinimizedChange(e.target.checked)}
          />
          <span>Start minimized (hide to the system tray)</span>
        </label>
      </section>

      <section className="preferences-settings-section">
        <h3>Sync &amp; network</h3>
        <AdvancedSyncSettings />
      </section>

      <section className="preferences-settings-section">
        <h3>Diagnostics</h3>
        <button
          type="button"
          className="preferences-settings-row"
          onClick={() => api.openSyncLogFolder().catch(console.error)}
        >
          <span>Open sync log folder</span>
          <span className="preferences-settings-chevron" aria-hidden>
            ›
          </span>
        </button>
      </section>

      <section className="preferences-settings-section">
        <h3>Security</h3>
        <EncryptionSettingsPanel
          embedded
          serverUrl={serverUrl}
          settingsError={encryption.settingsError}
          keysImportMessage={encryption.keysImportMessage}
          keysImporting={encryption.keysImporting}
          keysExporting={encryption.keysExporting}
          backupPassword={encryption.backupPassword}
          cryptoUnlocked={encryption.cryptoUnlocked}
          serverHasCrypto={encryption.serverHasCrypto}
          cryptoUnlockError={encryption.cryptoUnlockError}
          needsCryptoRecovery={encryption.needsCryptoRecovery}
          recoveryCode={encryption.recoveryCode}
          recoveryUnlocking={encryption.recoveryUnlocking}
          rotatePassword={encryption.rotatePassword}
          rotatingKey={encryption.rotatingKey}
          onRecoveryCodeChange={encryption.setRecoveryCode}
          onRotatePasswordChange={encryption.setRotatePassword}
          onUnlockRecovery={encryption.handleUnlockRecovery}
          onRotateCryptoKey={encryption.handleRotateCryptoKey}
          onExportKeys={encryption.handleExportEncryptionKeys}
          onImportKeys={encryption.handleImportEncryptionKeys}
          onBackupPasswordChange={encryption.setBackupPassword}
        />
      </section>

      <section className="preferences-settings-section">
        <h3>File Explorer</h3>
        <ExplorerIntegrationPanel embedded />
      </section>

      <section className="preferences-settings-section">
        <h3>Server</h3>
        <p className="settings-info-value preferences-settings-server-url">
          {serverUrl || "—"}
        </p>
      </section>
    </div>
  );
}
