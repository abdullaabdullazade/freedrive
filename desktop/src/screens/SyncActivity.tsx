import { formatBytes, formatRelativeTime } from "../api/tauri";
import { UploadProgressRing } from "../components/UploadProgressRing";
import { ConflictResolver } from "../components/ConflictResolver";
import type { ActivityItem, SyncStatus } from "../types";

interface SyncActivityProps {
  syncStatus: SyncStatus;
  activity: ActivityItem[];
  search: string;
  errorsOnly?: boolean;
  onErrorsOnlyChange?: (errorsOnly: boolean) => void;
}

function statusLabel(status: string) {
  switch (status) {
    case "synced":
      return { text: "Synced", className: "synced" };
    case "uploading":
      return { text: "Uploading", className: "uploading" };
    case "error":
      return { text: "Error", className: "error" };
    case "skipped":
      return { text: "Skipped", className: "skipped" };
    case "deleted":
      return { text: "Removed", className: "deleted" };
    case "conflict":
      return { text: "Conflict copy", className: "conflict" };
    default:
      return { text: status, className: "" };
  }
}

export function SyncActivity({
  syncStatus,
  activity,
  search,
  errorsOnly = false,
  onErrorsOnlyChange,
}: SyncActivityProps) {
  let filtered = errorsOnly ? activity.filter((a) => a.status === "error") : activity;
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter((a) => a.name.toLowerCase().includes(q));
  }

  const isError = syncStatus.status === "error";
  const isSyncing = syncStatus.status === "syncing";
  const isOffline = syncStatus.status === "offline";
  const isUpToDate = syncStatus.status === "up_to_date";

  const headerTitle = syncStatus.paused
    ? "Sync paused"
    : isError
      ? syncStatus.message
      : isSyncing
        ? syncStatus.message
        : isUpToDate
          ? "Up to date"
          : syncStatus.message;

  return (
    <div className="sync-panel">
      <div className="sync-panel-header">
        <div className="status-icon">
          {isError ? "!" : isSyncing ? "↻" : isOffline ? "×" : isUpToDate ? "☁" : "↻"}
        </div>
        <div style={{ flex: 1 }}>
          <div className={`status-title${isError ? " status-error" : ""}`}>
            {headerTitle}
          </div>
          <div className="status-subtitle">
            {isOffline
              ? syncStatus.message
              : isSyncing
              ? syncStatus.message || "Sync in progress…"
              : `Synced ${formatRelativeTime(syncStatus.last_synced_at)}`}
          </div>
        </div>
        {onErrorsOnlyChange && (
          <div className="sync-filter-toggle" role="group" aria-label="Activity filter">
            <button
              type="button"
              className={!errorsOnly ? "active" : ""}
              onClick={() => onErrorsOnlyChange(false)}
            >
              All
            </button>
            <button
              type="button"
              className={errorsOnly ? "active" : ""}
              onClick={() => onErrorsOnlyChange(true)}
            >
              Errors
            </button>
          </div>
        )}
      </div>

      <ConflictResolver />

      <table className="sync-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>File size</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {filtered.length === 0 ? (
            <tr>
              <td colSpan={3}>
                <div className="empty-state">
                  {errorsOnly ? "No sync errors" : "No sync activity yet"}
                </div>
              </td>
            </tr>
          ) : (
            filtered.map((item) => {
              const st = statusLabel(item.status);
              return (
                <tr key={item.id} className={item.status === "error" ? "row-error" : ""}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span>📄</span>
                      <div>
                        <div>{item.name}</div>
                        <div
                          className={`activity-detail${
                            item.status === "error" ? " detail-error" : ""
                          }`}
                        >
                          {item.detail}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>{formatBytes(item.file_size)}</td>
                  <td>
                    <span className={`status-badge ${st.className}`}>
                      {item.status === "uploading" && (
                        <UploadProgressRing
                          progress={item.progress}
                          className="status-upload-ring-inline"
                        />
                      )}
                      {st.text === "Synced" && "✓ "}
                      {st.text}
                    </span>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
