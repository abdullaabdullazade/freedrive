import { useEffect, useState } from "react";
import { api } from "../api/tauri";
import type { ExplorerIntegrationStatus } from "../types";

interface ExplorerIntegrationPanelProps {
  onBack?: () => void;
  embedded?: boolean;
}

export function ExplorerIntegrationPanel({
  onBack,
  embedded = false,
}: ExplorerIntegrationPanelProps) {
  const [status, setStatus] = useState<ExplorerIntegrationStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .getExplorerIntegrationStatus()
      .then(setStatus)
      .catch((err) => setError(String(err)));
  }, []);

  return (
    <div className={`explorer-integration-panel${embedded ? " settings-panel-embedded" : ""}`}>
      {!embedded && onBack && (
        <button type="button" className="preferences-back-btn" onClick={onBack}>
          ← Settings
        </button>
      )}
      {!embedded && <h2>Explorer integration</h2>}
      {error && <div className="error-banner">{error}</div>}
      {status && (
        <>
          <ul className="explorer-status-list">
            <li>
              <span>{status.native_streaming_supported ? "Connected" : "Local mirror ready"}</span>
              <span>{status.connected ? "Yes" : "No"}</span>
            </li>
            <li>
              <span>Integration</span>
              <span>
                {status.native_streaming_supported
                  ? status.registered
                    ? "Windows Cloud Files"
                    : "Not registered"
                  : `${status.platform} folder mirror`}
              </span>
            </li>
            <li>
              <span>Sync root</span>
              <span className="settings-info-value">{status.sync_root_path}</span>
            </li>
            <li>
              <span>My Drive path</span>
              <span className="settings-info-value">{status.my_drive_path}</span>
            </li>
          </ul>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => api.openDriveFolder().catch((err) => setError(String(err)))}
          >
            Open My Drive folder
          </button>
        </>
      )}
    </div>
  );
}
