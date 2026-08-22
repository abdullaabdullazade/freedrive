import { useEffect, useRef, useState } from "react";
import { api, formatBytes } from "../api/tauri";
import type { StorageInfo, User } from "../types";
import { UserAvatar, displayName } from "./UserAvatar";

interface ProfileMenuProps {
  user: User | null;
  serverUrl: string | null;
  anchorRect: DOMRect | null;
  onClose: () => void;
  onSignOut: () => void;
}

export function ProfileMenu({
  user,
  serverUrl,
  anchorRect,
  onClose,
  onSignOut,
}: ProfileMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);

  useEffect(() => {
    api.getStorageInfo().then(setStorage).catch(() => setStorage(null));
  }, []);

  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!anchorRect) return null;

  const top = anchorRect.bottom + 8;
  const right = Math.max(16, window.innerWidth - anchorRect.right);

  const usedPct =
    storage && storage.total_bytes > 0
      ? Math.round((storage.used_bytes / storage.total_bytes) * 100)
      : null;
  const storageWarning = usedPct !== null && usedPct >= 80;
  const baseUrl = serverUrl?.replace(/\/$/, "") || "";

  return (
    <div
      ref={menuRef}
      className="profile-menu"
      style={{ top, right }}
      role="dialog"
      aria-label="Account menu"
    >
      <button type="button" className="profile-menu-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div className="profile-menu-header">
        <UserAvatar user={user} size="lg" />
        <div>
          <div className="profile-menu-greeting">Hi, {displayName(user)}!</div>
          <div className="profile-menu-email">{user?.email}</div>
        </div>
      </div>

      <div className="profile-actions">
        <button type="button" className="profile-action-btn" onClick={onSignOut}>
          Sign out
        </button>
      </div>

      {storage && storage.total_bytes > 0 && (
        <div className="profile-storage">
          <div className="profile-storage-row">
            {storageWarning && <span className="profile-storage-warn" aria-hidden>!</span>}
            <span>
              {formatBytes(storage.used_bytes)} of {formatBytes(storage.total_bytes)} used
            </span>
            <button
              type="button"
              className="profile-storage-link"
              onClick={() => api.openServerUrl("#/storage").catch(console.error)}
            >
              Manage storage
            </button>
          </div>
          <div className="profile-storage-bar">
            <div
              className="profile-storage-bar-fill"
              style={{ width: `${Math.min(100, usedPct ?? 0)}%` }}
            />
          </div>
        </div>
      )}

      <div className="profile-menu-footer">
        <a href={baseUrl ? `${baseUrl}/` : "#"} target="_blank" rel="noreferrer">
          Privacy Policy
        </a>
        <span aria-hidden>·</span>
        <a href={baseUrl ? `${baseUrl}/` : "#"} target="_blank" rel="noreferrer">
          Terms of Service
        </a>
      </div>
    </div>
  );
}
