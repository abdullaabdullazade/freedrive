import { useCallback, useEffect, useState } from "react";
import { api, formatBytes } from "../api/tauri";
import type { DriveFile, DriveFolder } from "../types";
import { DriveItemDialog, type ManagedDriveItem } from "../components/DriveItemDialog";

interface Crumb {
  id?: string;
  name: string;
}

export function DriveBrowser({ search }: { search: string }) {
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ name: "My Drive" }]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<ManagedDriveItem | null>(null);

  const current = crumbs[crumbs.length - 1];
  const loadFolder = useCallback(async (folderId?: string) => {
    setLoading(true);
    setError("");
    try {
      const contents = await api.browseDrive(folderId);
      setFolders(contents.folders.filter((folder) => !folder.is_trashed));
      setFiles(contents.files);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const query = search.trim();
    const timer = window.setTimeout(async () => {
      if (!query) {
        await loadFolder(current.id);
        return;
      }
      setLoading(true);
      setError("");
      try {
        const result = await api.searchDrive(query);
        setFolders(result.folders.filter((folder) => !folder.is_trashed));
        setFiles(result.files);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    }, query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [current.id, loadFolder, search]);

  const openFolder = (folder: DriveFolder) => {
    setCrumbs((previous) => [...previous, { id: folder.id, name: folder.name }]);
  };

  const createFolder = async () => {
    const name = window.prompt("New folder name");
    if (!name?.trim()) return;
    try {
      await api.createDriveFolder(name, current.id);
      await loadFolder(current.id);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <section className="drive-browser">
      <header className="drive-browser-header">
        <div>
          <h1>{search.trim() ? `Search results for “${search.trim()}”` : current.name}</h1>
          {!search.trim() && (
            <nav className="drive-breadcrumbs" aria-label="Drive folder">
              {crumbs.map((crumb, index) => (
                <button
                  type="button"
                  key={`${crumb.id || "root"}-${index}`}
                  onClick={() => setCrumbs((previous) => previous.slice(0, index + 1))}
                >
                  {crumb.name}
                </button>
              ))}
            </nav>
          )}
        </div>
        <button type="button" className="btn-primary" onClick={createFolder} disabled={!!search.trim()}>
          New folder
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}
      {loading ? (
        <div className="preferences-loading">Loading Drive…</div>
      ) : folders.length === 0 && files.length === 0 ? (
        <div className="drive-browser-empty">No files or folders found.</div>
      ) : (
        <div className="drive-browser-table" role="table" aria-label="My Drive files">
          <div className="drive-browser-row drive-browser-columns" role="row">
            <span>Name</span><span>Type</span><span>Size</span><span>Actions</span>
          </div>
          {folders.map((folder) => (
            <div className="drive-browser-row" role="row" key={`folder-${folder.id}`}>
              <button className="drive-item-name" type="button" onClick={() => openFolder(folder)}>📁 {folder.name}</button>
              <span>Folder</span><span>—</span>
              <button className="drive-item-action" type="button" onClick={() => setSelected({ type: "folder", value: folder })}>Manage</button>
            </div>
          ))}
          {files.map((file) => (
            <div className="drive-browser-row" role="row" key={`file-${file.id}`}>
              <button className="drive-item-name" type="button" onClick={() => api.openServerUrl(`#/files/${file.id}`)}>📄 {file.name}</button>
              <span>{file.mime_type || "File"}</span><span>{formatBytes(file.size)}</span>
              <div className="drive-item-actions">
                <button className="drive-item-action" type="button" onClick={() => api.openServerUrl(`#/files/${file.id}`)}>Open</button>
                <button className="drive-item-action" type="button" onClick={() => setSelected({ type: "file", value: file })}>Manage</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {selected && <DriveItemDialog item={selected} onClose={() => setSelected(null)} onChanged={() => loadFolder(current.id)} />}
    </section>
  );
}
