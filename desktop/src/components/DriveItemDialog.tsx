import { useCallback, useEffect, useState } from "react";
import { api, formatBytes } from "../api/tauri";
import type { DriveFile, DriveFileVersion, DriveFolder, DriveItemShares } from "../types";

export type ManagedDriveItem =
  | { type: "file"; value: DriveFile }
  | { type: "folder"; value: DriveFolder };

interface Props {
  item: ManagedDriveItem;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}

export function DriveItemDialog({ item, onClose, onChanged }: Props) {
  const [name, setName] = useState(item.value.name);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [destination, setDestination] = useState(
    item.type === "file" ? item.value.folder_id || "" : item.value.parent_id || "",
  );
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState<"read" | "write">("read");
  const [linkPassword, setLinkPassword] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [versions, setVersions] = useState<DriveFileVersion[] | null>(null);
  const [shares, setShares] = useState<DriveItemShares>({ user_shares: [], links: [] });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadShares = useCallback(async () => {
    setShares(await api.getDriveItemShares(item.type, item.value.id));
  }, [item.type, item.value.id]);

  useEffect(() => {
    Promise.all([api.listDriveFolders().then((items) => {
      setFolders(items.filter((folder) => !folder.is_trashed && folder.id !== item.value.id));
    }), loadShares()]).catch((err) => setError(String(err)));
  }, [item.value.id, loadShares]);

  const run = async (action: () => Promise<unknown>, success: string, close = false) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(success);
      await onChanged();
      if (close) onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const loadVersions = async () => {
    if (item.type !== "file") return;
    setBusy(true);
    setError("");
    try {
      setVersions(await api.getDriveFileVersions(item.value.id));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const createLink = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api.createDriveShareLink(item.type, item.value.id, linkPassword);
      setShareUrl(result.url || "");
      setMessage("Share link created.");
      await loadShares();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drive-dialog-overlay" role="presentation" onClick={onClose}>
      <section className="drive-dialog" role="dialog" aria-modal="true" aria-labelledby="drive-item-title" onClick={(event) => event.stopPropagation()}>
        <header>
          <div><span className="settings-hint">{item.type === "folder" ? "Folder" : "File"}</span><h2 id="drive-item-title">{item.value.name}</h2></div>
          <button type="button" className="drive-dialog-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        {error && <div className="error-banner">{error}</div>}
        {message && <div className="success-banner">{message}</div>}

        <div className="drive-dialog-section">
          <h3>Rename and organize</h3>
          <div className="drive-dialog-inline">
            <input value={name} onChange={(event) => setName(event.target.value)} aria-label="Item name" />
            <button type="button" className="btn-secondary" disabled={busy || !name.trim()} onClick={() => run(
              () => api.updateDriveItem(item.type, item.value.id, { name }), "Name updated.",
            )}>Rename</button>
          </div>
          <div className="drive-dialog-inline">
            <select value={destination} onChange={(event) => setDestination(event.target.value)} aria-label="Move destination">
              <option value="">My Drive</option>
              {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(
              () => api.updateDriveItem(item.type, item.value.id, { parent_id: destination || null, move_requested: true }),
              "Item moved.", true,
            )}>Move</button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(
              () => api.updateDriveItem(item.type, item.value.id, { starred: !item.value.is_starred }),
              item.value.is_starred ? "Removed from Starred." : "Added to Starred.", true,
            )}>{item.value.is_starred ? "Unstar" : "Star"}</button>
          </div>
        </div>

        {item.type === "file" && (
          <div className="drive-dialog-section">
            <h3>File</h3>
            <div className="drive-dialog-actions">
              <button type="button" className="btn-secondary" onClick={() => api.openServerUrl(`#/files/${item.value.id}`)}>Open</button>
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(
                () => api.downloadDriveFile(item.value.id, item.value.name), "Download saved.",
              )}>Download decrypted copy</button>
              <button type="button" className="btn-secondary" disabled={busy} onClick={loadVersions}>Version history</button>
            </div>
            {versions && (
              <div className="drive-version-list">
                {versions.length === 0 && <p className="settings-hint">No older versions.</p>}
                {versions.map((version) => (
                  <div key={version.id}>
                    <span>Version {version.version} · {formatBytes(version.size)} · {new Date(version.created_at).toLocaleString()}</span>
                    <button type="button" className="drive-item-action" disabled={busy} onClick={() => run(
                      () => api.restoreDriveFileVersion(item.value.id, version.version),
                      `Version ${version.version} restored.`,
                    )}>Restore</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="drive-dialog-section">
          <h3>Share</h3>
          <div className="drive-dialog-inline">
            <input type="email" placeholder="person@example.com" value={email} onChange={(event) => setEmail(event.target.value)} />
            <select value={permission} onChange={(event) => setPermission(event.target.value as "read" | "write")}>
              <option value="read">Viewer</option><option value="write">Editor</option>
            </select>
            <button type="button" className="btn-secondary" disabled={busy || !email.trim()} onClick={() => run(
              async () => {
                await api.shareDriveItemWithUser(item.type, item.value.id, email, permission);
                setEmail("");
                await loadShares();
              }, "Shared with user.",
            )}>Share</button>
          </div>
          {item.type === "file" && <div className="drive-dialog-inline">
            <input type="password" placeholder="Optional link password" value={linkPassword} onChange={(event) => setLinkPassword(event.target.value)} />
            <button type="button" className="btn-secondary" disabled={busy} onClick={createLink}>Create encrypted link</button>
          </div>}
          {shareUrl && <div className="drive-share-link"><input readOnly value={shareUrl} /><button type="button" className="btn-secondary" onClick={() => navigator.clipboard.writeText(shareUrl)}>Copy</button></div>}
          {(shares.user_shares.length > 0 || shares.links.length > 0) && (
            <div className="drive-share-list">
              {shares.user_shares.map((entry) => (
                <div key={entry.share.id}>
                  <span>User {entry.share.shared_with}</span>
                  <select
                    aria-label="Share permission"
                    value={entry.share.permission}
                    disabled={busy}
                    onChange={(event) => void run(async () => {
                      await api.updateDriveUserShare(entry.share.id, event.target.value as "read" | "write");
                      await loadShares();
                    }, "Permission updated.")}
                  ><option value="read">Viewer</option><option value="write">Editor</option></select>
                  <button type="button" className="drive-item-action" disabled={busy} onClick={() => void run(async () => {
                    await api.revokeDriveUserShare(entry.share.id);
                    await loadShares();
                  }, "User access revoked.")}>Revoke</button>
                </div>
              ))}
              {shares.links.map((link) => (
                <div key={link.id}>
                  <span>Public link · {link.has_password ? "password protected" : "no password"} · {link.download_count} downloads</span>
                  <button type="button" className="drive-item-action" disabled={busy} onClick={() => void run(async () => {
                    await api.revokeDriveShareLink(link.id);
                    await loadShares();
                  }, "Link revoked.")}>Revoke</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer>
          <button type="button" className="btn-danger" disabled={busy} onClick={() => {
            if (window.confirm(`Move “${item.value.name}” to trash?`)) {
              void run(() => api.trashDriveItem(item.type, item.value.id), "Moved to trash.", true);
            }
          }}>Move to Trash</button>
          <button type="button" className="btn-primary" onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}
