import { useEffect, useState } from "react";
import { api } from "../api/tauri";
import type { DesktopSyncSettings, RemoteSyncFolder } from "../types";

const defaults: DesktopSyncSettings = {
  proxy_url: "",
  upload_limit_kbps: 0,
  download_limit_kbps: 0,
  excluded_patterns: [],
  excluded_remote_folder_ids: [],
};

export function AdvancedSyncSettings() {
  const [settings, setSettings] = useState(defaults);
  const [remoteFolders, setRemoteFolders] = useState<RemoteSyncFolder[]>([]);
  const [patterns, setPatterns] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([api.getDesktopSyncSettings(), api.getRemoteSyncFolders().catch(() => [])])
      .then(([loaded, folders]) => {
        setSettings(loaded);
        setPatterns(loaded.excluded_patterns.join("\n"));
        setRemoteFolders(folders.filter((folder) => !folder.is_trashed));
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const next = await api.setDesktopSyncSettings({
        ...settings,
        excluded_patterns: patterns.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
      });
      setSettings(next);
      setPatterns(next.excluded_patterns.join("\n"));
      setMessage("Sync and network settings saved.");
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleRemoteFolder = (id: string) => {
    setSettings((current) => ({
      ...current,
      excluded_remote_folder_ids: current.excluded_remote_folder_ids.includes(id)
        ? current.excluded_remote_folder_ids.filter((candidate) => candidate !== id)
        : [...current.excluded_remote_folder_ids, id],
    }));
  };

  if (loading) return <div className="preferences-loading">Loading advanced sync settings…</div>;

  return (
    <div className="advanced-sync-settings">
      {error && <div className="error-banner">{error}</div>}
      {message && <div className="success-banner">{message}</div>}

      <label className="advanced-setting-field">
        <span>Proxy URL</span>
        <input
          type="url"
          placeholder="https://proxy.example:8080 (optional)"
          value={settings.proxy_url}
          onChange={(event) => setSettings({ ...settings, proxy_url: event.target.value })}
        />
      </label>

      <div className="advanced-setting-grid">
        <label className="advanced-setting-field">
          <span>Upload limit (KB/s)</span>
          <input
            type="number"
            min="0"
            value={settings.upload_limit_kbps}
            onChange={(event) => setSettings({ ...settings, upload_limit_kbps: Number(event.target.value) || 0 })}
          />
        </label>
        <label className="advanced-setting-field">
          <span>Download limit (KB/s)</span>
          <input
            type="number"
            min="0"
            value={settings.download_limit_kbps}
            onChange={(event) => setSettings({ ...settings, download_limit_kbps: Number(event.target.value) || 0 })}
          />
        </label>
      </div>
      <p className="settings-hint">Use 0 for unlimited bandwidth.</p>

      <label className="advanced-setting-field">
        <span>Exclude paths</span>
        <textarea
          rows={4}
          placeholder={"**/*.tmp\nprivate/**\n**/build/**"}
          value={patterns}
          onChange={(event) => setPatterns(event.target.value)}
        />
      </label>
      <p className="settings-hint">One glob pattern per line. Excluded paths are not uploaded.</p>

      {remoteFolders.length > 0 && (
        <fieldset className="selective-sync-folders">
          <legend>My Drive selective sync</legend>
          <p className="settings-hint">Unchecked folders stay in the cloud and are omitted from Stream/Mirror.</p>
          {remoteFolders.map((folder) => (
            <label key={folder.id}>
              <input
                type="checkbox"
                checked={!settings.excluded_remote_folder_ids.includes(folder.id)}
                onChange={() => toggleRemoteFolder(folder.id)}
              />
              <span>{folder.name}</span>
            </label>
          ))}
        </fieldset>
      )}

      <button type="button" className="btn-primary" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save sync settings"}
      </button>
    </div>
  );
}
