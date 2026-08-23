import { useCallback, useEffect, useState } from "react";
import { api, formatBytes } from "../api/tauri";
import { DriveItemDialog, type ManagedDriveItem } from "../components/DriveItemDialog";
import { FileViewer } from "../components/FileViewer";
import { NavIcon, type NavIconName } from "../components/NavIcons";
import type { DriveFile, DriveFolder } from "../types";
import { previewKindFor } from "../utils/filePreview";

type CollectionKind = "recent" | "starred" | "trash";

const titles: Record<CollectionKind, string> = {
  recent: "Recent",
  starred: "Starred",
  trash: "Trash",
};

function fileIcon(file: DriveFile): NavIconName {
  const kind = previewKindFor(file.mime_type, file.name);
  return kind === "audio" || kind === "video" || kind === "image" ? kind : "file";
}

export function DriveCollection({ kind, search }: { kind: CollectionKind; search: string }) {
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<ManagedDriveItem | null>(null);
  const [preview, setPreview] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api.getDriveCollection(kind);
      setFolders(result.folders);
      setFiles(result.files);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => { void load(); }, [load]);

  const query = search.trim().toLowerCase();
  const shownFolders = query ? folders.filter((item) => item.name.toLowerCase().includes(query)) : folders;
  const shownFiles = query ? files.filter((item) => item.name.toLowerCase().includes(query)) : files;

  const restore = async (type: "file" | "folder", id: string) => {
    try { await api.restoreDriveItem(type, id); await load(); } catch (err) { setError(String(err)); }
  };
  const removeForever = async (type: "file" | "folder", id: string, name: string) => {
    if (!window.confirm(`Delete “${name}” forever? This cannot be undone.`)) return;
    try { await api.permanentlyDeleteDriveItem(type, id); await load(); } catch (err) { setError(String(err)); }
  };
  const emptyTrash = async () => {
    if (!window.confirm("Empty Trash? All items will be deleted forever.")) return;
    try { await api.emptyDriveTrash(); await load(); } catch (err) { setError(String(err)); }
  };

  return <section className="drive-browser">
    <header className="drive-browser-header">
      <div><h1>{titles[kind]}</h1><p className="settings-hint">{kind === "trash" ? "Items in Trash can be restored or permanently deleted." : kind === "starred" ? "Files you marked as important." : "Files you opened or changed recently."}</p></div>
      {kind === "trash" && (folders.length > 0 || files.length > 0) && <button type="button" className="btn-secondary danger-button" onClick={() => void emptyTrash()}>Empty Trash</button>}
    </header>
    {error && <div className="error-banner">{error}</div>}
    {loading ? <div className="preferences-loading">Loading {titles[kind].toLowerCase()}…</div> : shownFolders.length === 0 && shownFiles.length === 0 ? <div className="drive-browser-empty">No items found.</div> : <div className="drive-browser-table" role="table" aria-label={titles[kind]}>
      <div className="drive-browser-row drive-browser-columns" role="row"><span>Name</span><span>Type</span><span>Size</span><span>Actions</span></div>
      {shownFolders.map((folder) => <div className="drive-browser-row" role="row" key={folder.id}>
        <span className="drive-item-name"><NavIcon name="folder" /> {folder.name}</span><span>Folder</span><span>—</span>
        <div className="drive-item-actions"><button className="drive-item-action" type="button" onClick={() => void restore("folder", folder.id)}>Restore</button><button className="drive-item-action danger-text" type="button" onClick={() => void removeForever("folder", folder.id, folder.name)}>Delete forever</button></div>
      </div>)}
      {shownFiles.map((file) => <div className="drive-browser-row" role="row" key={file.id}>
        <button className="drive-item-name" type="button" disabled={kind === "trash"} onClick={() => setPreview({ id: file.id, name: file.name })}><NavIcon name={fileIcon(file)} /> {file.name}</button><span>{file.mime_type || "File"}</span><span>{formatBytes(file.size)}</span>
        {kind === "trash" ? <div className="drive-item-actions"><button className="drive-item-action" type="button" onClick={() => void restore("file", file.id)}>Restore</button><button className="drive-item-action danger-text" type="button" onClick={() => void removeForever("file", file.id, file.name)}>Delete forever</button></div> : <div className="drive-item-actions"><button className="drive-item-action" type="button" onClick={() => setPreview({ id: file.id, name: file.name })}>Open</button><button className="drive-item-action" type="button" onClick={() => setSelected({ type: "file", value: file })}>Manage</button></div>}
      </div>)}
    </div>}
    {selected && <DriveItemDialog item={selected} onClose={() => setSelected(null)} onChanged={load} onOpenFile={(id, name) => { setSelected(null); setPreview({ id, name }); }} />}
    {preview && <FileViewer fileId={preview.id} fallbackName={preview.name} onClose={() => setPreview(null)} />}
  </section>;
}
