import { useEffect, useState } from "react";
import { api } from "../api/tauri";
import type { SyncMode } from "../types";

export function FreeDriveTab() {
  const [mode, setMode] = useState<SyncMode>("stream");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .getSyncMode()
      .then((value) => setMode(value === "mirror" ? "mirror" : "stream"))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  const handleChange = async (next: SyncMode) => {
    if (next === mode || saving) return;
    setError("");
    setSaving(true);
    try {
      await api.setSyncMode(next);
      setMode(next);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="preferences-loading">Loading sync options…</div>;
  }

  return (
    <div className="freedrive-tab">
      <div className="preferences-section-header">
        <h2>FreeDrive</h2>
        <p>
          Browse My Drive from File Explorer. Stream and mirror settings below apply only to{" "}
          <strong>My Drive</strong> in your FreeDrive folder.
        </p>
        <p className="preferences-section-note">
          Folders you add for sync (Documents, Downloads, etc.) upload copies to the cloud only.
          They are not shown inside FreeDrive.
        </p>
        <button
          type="button"
          className="btn-secondary preferences-open-explorer"
          onClick={() => api.openDriveFolder().catch((err) => setError(String(err)))}
        >
          Open in File Explorer
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="sync-mode-options">
        <label className={`sync-mode-card${mode === "stream" ? " selected" : ""}`}>
          <input
            type="radio"
            name="sync-mode"
            value="stream"
            checked={mode === "stream"}
            disabled={saving}
            onChange={() => handleChange("stream")}
          />
          <div className="sync-mode-card-body">
            <span className="sync-mode-title">Stream files (default)</span>
            <ul className="sync-mode-features">
              <li>Keep My Drive in the cloud only — no full folder download.</li>
              <li>Files appear as cloud placeholders in File Explorer.</li>
              <li>A file downloads when you open it, then frees disk space after you close it.</li>
              <li>
                Right-click FreeDrive Free up space or Download (Stream only), like Google Drive
                Online only / Available offline.
              </li>
              <li>Edits and new local files or folders upload to the server automatically.</li>
            </ul>
          </div>
        </label>

        <label className={`sync-mode-card${mode === "mirror" ? " selected" : ""}`}>
          <input
            type="radio"
            name="sync-mode"
            value="mirror"
            checked={mode === "mirror"}
            disabled={saving}
            onChange={() => handleChange("mirror")}
          />
          <div className="sync-mode-card-body">
            <span className="sync-mode-title">Mirror files</span>
            <ul className="sync-mode-features">
              <li>Keep a full local copy of My Drive under FreeDrive (uses disk space).</li>
              <li>Access My Drive files offline from your computer.</li>
              <li>New and changed files on the server download automatically.</li>
              <li>New local files and folders upload to the server automatically.</li>
              <li>
                No Free up space in Explorer — switch to Stream to reclaim disk (like Google Drive).
              </li>
            </ul>
          </div>
        </label>
      </div>

      <div className="preferences-info-box">
        <span className="preferences-info-icon" aria-hidden>
          i
        </span>
        <p>
          Both modes sync My Drive both ways, like Google Drive for desktop. Stream keeps most
          files as cloud placeholders; Free up space and Download appear only in Stream. Choose
          Mirror only if you want the entire My Drive folder stored locally. On Windows 11,
          FreeDrive right-click options appear under <strong>Show more options</strong> (or
          Shift+right-click).
        </p>
      </div>
    </div>
  );
}
