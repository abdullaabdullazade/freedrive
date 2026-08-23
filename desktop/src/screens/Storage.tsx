import { formatBytes } from "../api/tauri";
import type { StorageInfo } from "../types";

export function Storage({ storage, onOpenDrive }: { storage: StorageInfo | null; onOpenDrive: () => void }) {
  const percent = storage && storage.total_bytes > 0 ? Math.min(100, Math.round(storage.used_bytes / storage.total_bytes * 100)) : 0;
  return <section className="storage-page">
    <h1>Storage</h1>
    <div className="card storage-summary-card">
      <div className="storage-summary-heading"><div><h2>{storage ? formatBytes(storage.used_bytes) : "—"} used</h2><p>{storage ? `${formatBytes(storage.total_bytes)} total` : "Storage information unavailable"}</p></div><strong>{percent}%</strong></div>
      <div className="storage-summary-bar"><span style={{ width: `${percent}%` }} /></div>
      {storage && <div className="storage-summary-details"><span>Used: {formatBytes(storage.used_bytes)}</span><span>Available: {formatBytes(storage.free_bytes ?? Math.max(0, storage.total_bytes - storage.used_bytes))}</span></div>}
      <button type="button" className="btn-primary" onClick={onOpenDrive}>Manage files</button>
    </div>
  </section>;
}
