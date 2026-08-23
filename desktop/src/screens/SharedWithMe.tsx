import { useEffect, useState } from "react";
import { api } from "../api/tauri";
import { FileViewer } from "../components/FileViewer";
import type { SharedItem } from "../types";
import { DriveBrowser } from "./DriveBrowser";
import { NavIcon } from "../components/NavIcons";

export function SharedWithMe({ search }: { search: string }) {
  const [items, setItems] = useState<SharedItem[]>([]);
  const [folder, setFolder] = useState<{ id: string; name: string; readOnly: boolean } | null>(null);
  const [preview, setPreview] = useState<{ id: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    api.getSharedWithMe().then(setItems).catch((err) => setError(String(err))).finally(() => setLoading(false));
  }, []);

  if (folder) return <DriveBrowser search={search} root={folder} readOnly={folder.readOnly} onExitRoot={() => setFolder(null)} />;
  const query = search.trim().toLowerCase();
  const visible = query ? items.filter((item) => item.item_name.toLowerCase().includes(query)) : items;
  return (
    <section className="drive-browser">
      <header className="drive-browser-header"><div><h1>Shared with me</h1><p className="settings-hint">Files and folders other people shared with you.</p></div></header>
      {error && <div className="error-banner">{error}</div>}
      {loading ? <div className="preferences-loading">Loading shared items…</div> : visible.length === 0 ? <div className="drive-browser-empty">Nothing shared with you yet.</div> : (
        <div className="drive-browser-table" role="table" aria-label="Shared files">
          <div className="drive-browser-row drive-browser-columns" role="row"><span>Name</span><span>Type</span><span>Owner</span><span>Action</span></div>
          {visible.map((item) => {
            const isFolder = item.item_type === "folder";
            const open = () => isFolder ? setFolder({ id: item.item_id, name: item.item_name, readOnly: item.share.permission !== "write" }) : setPreview({ id: item.item_id, name: item.item_name });
            return <div className="drive-browser-row" role="row" key={item.share.id}>
              <button className="drive-item-name" type="button" onClick={open}><NavIcon name={isFolder ? "folder" : "file"} /> {item.item_name}</button>
              <span>{isFolder ? "Folder" : "File"}</span><span>{item.owner_name || "—"}</span>
              <button className="drive-item-action" type="button" onClick={open}>Open</button>
            </div>;
          })}
        </div>
      )}
      {preview && <FileViewer fileId={preview.id} fallbackName={preview.name} onClose={() => setPreview(null)} />}
    </section>
  );
}
