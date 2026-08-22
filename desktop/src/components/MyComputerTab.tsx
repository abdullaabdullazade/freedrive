import { useCallback, useEffect, useState } from "react";
import { api } from "../api/tauri";
import type { SyncFolder } from "../types";

interface MyComputerTabProps {
  onFoldersChanged?: () => void;
}

export function MyComputerTab({ onFoldersChanged }: MyComputerTabProps) {
  const [folders, setFolders] = useState<SyncFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const loadFolders = useCallback(async () => {
    try {
      const items = await api.getSyncFolders();
      setFolders(items);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  const handleAddFolder = async () => {
    if (adding) return;
    setError("");
    setAdding(true);
    try {
      const path = await Promise.race([
        api.pickFolder(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 120_000)),
      ]);
      if (!path) return;
      await api.addSyncFolder(path);
      await loadFolders();
      onFoldersChanged?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (folder: SyncFolder) => {
    const confirmed = window.confirm(
      `Stop syncing "${folder.label}"?\n\nLocal files will stay on your computer. Files already on the server are not deleted.`,
    );
    if (!confirmed) return;

    setError("");
    setRemovingId(folder.id);
    try {
      await api.removeSyncFolder(folder.id);
      await loadFolders();
      onFoldersChanged?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setRemovingId(null);
    }
  };

  if (loading) {
    return <div className="preferences-loading">Loading folders…</div>;
  }

  if (folders.length === 0) {
    return (
      <div className="preferences-empty-state">
        <div className="preferences-empty-illustration" aria-hidden>
          <span className="preferences-empty-cloud">☁</span>
          <span className="preferences-empty-folders">📁</span>
        </div>
        <h2>Safely back up your files</h2>
        <p>
          Upload, store and sync your files to FreeDrive. Choose a folder on your computer to get
          started.
        </p>
        {error && <div className="error-banner">{error}</div>}
        <button
          type="button"
          className="btn-primary preferences-add-btn"
          onClick={handleAddFolder}
          disabled={adding}
        >
          {adding ? "Adding…" : "Add folder"}
        </button>
      </div>
    );
  }

  return (
    <div className="my-computer-tab">
      <div className="preferences-section-header">
        <h2>My computer</h2>
        <p>These folders on your computer are backed up to FreeDrive.</p>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <ul className="sync-folder-list">
        {folders.map((folder) => (
          <li key={folder.id} className="sync-folder-row">
            <div className="sync-folder-icon" aria-hidden>
              📁
            </div>
            <div className="sync-folder-info">
              <span className="sync-folder-label">{folder.label}</span>
              <span className="sync-folder-path">{folder.local_path}</span>
            </div>
            <button
              type="button"
              className="btn-text sync-folder-remove"
              onClick={() => handleRemove(folder)}
              disabled={removingId === folder.id}
            >
              {removingId === folder.id ? "Removing…" : "Remove"}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn-secondary"
        onClick={handleAddFolder}
        disabled={adding}
      >
        {adding ? "Adding…" : "Add folder"}
      </button>
    </div>
  );
}
