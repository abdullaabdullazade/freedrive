import { useCallback, useEffect, useState } from "react";
import { api, formatBytes, onDriveUploadProgress } from "../api/tauri";
import type { DriveFile, DriveFolder, DriveUploadProgressEvent } from "../types";
import { DriveItemDialog, type ManagedDriveItem } from "../components/DriveItemDialog";
import { FileViewer } from "../components/FileViewer";
import { NavIcon, type NavIconName } from "../components/NavIcons";
import { previewKindFor } from "../utils/filePreview";

interface Crumb {
  id?: string;
  name: string;
}

interface DriveBrowserProps {
  search: string;
  root?: { id: string; name: string };
  onExitRoot?: () => void;
  readOnly?: boolean;
}

function fileIcon(file: DriveFile): NavIconName {
  const kind = previewKindFor(file.mime_type, file.name);
  if (kind === "audio") return "audio";
  if (kind === "video") return "video";
  if (kind === "image") return "image";
  return "file";
}

export function DriveBrowser({ search, root, onExitRoot, readOnly = false }: DriveBrowserProps) {
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [crumbs, setCrumbs] = useState<Crumb[]>([root || { name: "My Drive" }]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<ManagedDriveItem | null>(null);
  const [preview, setPreview] = useState<{ id: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<DriveUploadProgressEvent | null>(null);
  const [uploadMessage, setUploadMessage] = useState("");

  const current = crumbs[crumbs.length - 1];

  useEffect(() => {
    setCrumbs([root || { name: "My Drive" }]);
  }, [root?.id, root?.name]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onDriveUploadProgress(setUploadProgress).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, []);
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

  const uploadFiles = async () => {
    setUploading(true);
    setUploadProgress(null);
    setUploadMessage("");
    setError("");
    try {
      const uploaded = await api.uploadDriveFiles(current.id);
      if (uploaded.length > 0) {
        setUploadMessage(`${uploaded.length} file${uploaded.length === 1 ? "" : "s"} uploaded securely.`);
        await loadFolder(current.id);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  const uploadPercent = uploadProgress?.bytes_total
    ? Math.min(100, Math.round((uploadProgress.bytes_sent / uploadProgress.bytes_total) * 100))
    : 0;

  return (
    <section className="drive-browser">
      <header className="drive-browser-header">
        <div>
          {onExitRoot && <button type="button" className="btn-text" onClick={onExitRoot}>← Shared with me</button>}
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
        {!readOnly && <div className="drive-browser-header-actions">
          <button type="button" className="btn-secondary drive-upload-button" onClick={() => void uploadFiles()} disabled={!!search.trim() || uploading}><NavIcon name="upload" />{uploading ? "Uploading…" : "Upload files"}</button>
          <button type="button" className="btn-primary" onClick={createFolder} disabled={!!search.trim() || uploading}>New folder</button>
        </div>}
      </header>

      {error && <div className="error-banner">{error}</div>}
      {uploadMessage && <div className="success-banner" role="status">{uploadMessage}</div>}
      {uploading && <div className="drive-upload-progress" role="status" aria-live="polite">
        <NavIcon name="upload" />
        <div><strong>{uploadProgress?.name || "Preparing encrypted upload…"}</strong><span>{uploadProgress ? `File ${uploadProgress.file_index} of ${uploadProgress.file_count} · ${formatBytes(uploadProgress.bytes_sent)} of ${formatBytes(uploadProgress.bytes_total)}` : "Choose one or more files"}</span></div>
        <div className="drive-upload-track" aria-label={`${uploadPercent}% uploaded`}><span style={{ width: `${uploadPercent}%` }} /></div>
      </div>}
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
              <button className="drive-item-name" type="button" onClick={() => openFolder(folder)}><NavIcon name="folder" /> {folder.name}</button>
              <span>Folder</span><span>—</span>
              {readOnly ? <span>—</span> : <button className="drive-item-action" type="button" onClick={() => setSelected({ type: "folder", value: folder })}>Manage</button>}
            </div>
          ))}
          {files.map((file) => (
            <div className="drive-browser-row" role="row" key={`file-${file.id}`}>
              <button className="drive-item-name" type="button" onClick={() => setPreview({ id: file.id, name: file.name })}><NavIcon name={fileIcon(file)} /> {file.name}</button>
              <span>{file.mime_type || "File"}</span><span>{formatBytes(file.size)}</span>
              <div className="drive-item-actions">
                <button className="drive-item-action" type="button" onClick={() => setPreview({ id: file.id, name: file.name })}>Open</button>
                {!readOnly && <button className="drive-item-action" type="button" onClick={() => setSelected({ type: "file", value: file })}>Manage</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {selected && <DriveItemDialog item={selected} onClose={() => setSelected(null)} onChanged={() => loadFolder(current.id)} onOpenFile={(id, name) => { setSelected(null); setPreview({ id, name }); }} />}
      {preview && <FileViewer fileId={preview.id} fallbackName={preview.name} onClose={() => setPreview(null)} />}
    </section>
  );
}
