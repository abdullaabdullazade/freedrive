import { useEffect, useState } from "react";
import { api, formatRelativeTime } from "../api/tauri";
import { NotificationMiniCard } from "../components/NotificationMiniCard";
import { UploadProgressRing } from "../components/UploadProgressRing";
import { NavIcon } from "../components/NavIcons";
import type {
  ActivityItem,
  AppNotification,
  SharedItem,
  SyncProgress,
  SyncStatus,
} from "../types";

interface HomeProps {
  syncStatus: SyncStatus;
  syncProgress: SyncProgress | null;
  activity: ActivityItem[];
  notifications: AppNotification[];
  onDismiss: (id: string) => void;
  onGoToNotifications: () => void;
  onViewSyncActivity: () => void;
  onResumeSync: () => void;
  onFoldersChanged: () => void;
  onOpenDrive: () => void;
  onViewShared: () => void;
  onManageStorage: () => void;
  onOpenPreferences: () => void;
  onOpenAbout: () => void;
}

function formatFileCount(count: number): string {
  return `${count} file${count === 1 ? "" : "s"}`;
}

export function Home({
  syncStatus,
  syncProgress,
  activity,
  notifications,
  onDismiss,
  onGoToNotifications,
  onViewSyncActivity,
  onResumeSync,
  onFoldersChanged,
  onOpenDrive,
  onViewShared,
  onManageStorage,
  onOpenPreferences,
  onOpenAbout,
}: HomeProps) {
  const [addingFolder, setAddingFolder] = useState(false);
  const [sharedItems, setSharedItems] = useState<SharedItem[]>([]);
  const recent = activity.slice(0, 3);
  const miniNotifications = notifications.slice(0, 2);
  const hasNotifications = miniNotifications.length > 0;

  const isError = syncStatus.status === "error";
  const isSyncing = syncStatus.status === "syncing";
  const isOffline = syncStatus.status === "offline";
  const isPaused = syncStatus.paused;
  const isUpToDate = syncStatus.status === "up_to_date";

  const fileCount =
    syncProgress && syncProgress.total > 0
      ? syncProgress.total
      : activity.length;

  const statusTitle = isPaused
    ? "Sync paused"
    : isError
      ? syncStatus.message
      : isSyncing
        ? syncStatus.message || "Syncing…"
        : isUpToDate
          ? "Up to date"
          : syncStatus.message;

  const statusSubtitle = isOffline
    ? syncStatus.message
    : isSyncing
      ? syncStatus.message.toLowerCase().includes("freeing up")
        ? "Reclaiming local disk space"
        : formatFileCount(fileCount)
      : `Synced ${formatRelativeTime(syncStatus.last_synced_at)}`;

  useEffect(() => {
    api
      .getSharedWithMe()
      .then((items) => {
        const sorted = [...items].sort((a, b) => {
          const at = a.share.created_at ? new Date(a.share.created_at).getTime() : 0;
          const bt = b.share.created_at ? new Date(b.share.created_at).getTime() : 0;
          return bt - at;
        });
        setSharedItems(sorted.slice(0, 3));
      })
      .catch(() => setSharedItems([]));
  }, []);

  const handleAddFolder = async () => {
    if (addingFolder) return;
    setAddingFolder(true);
    try {
      const path = await Promise.race([
        api.pickFolder(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 120_000)),
      ]);
      if (!path) return;
      await api.addSyncFolder(path);
      onFoldersChanged();
    } catch (err) {
      console.error("add folder failed:", err);
    } finally {
      setAddingFolder(false);
    }
  };

  const caughtUpTitle = hasNotifications
    ? "Things need your attention"
    : isError
      ? "Sync needs attention"
      : isSyncing
        ? "Sync in progress"
        : "You're all caught up!";

  return (
    <div className="home-grid">
      <div className="home-left-column">
        <div className="card sync-status-card">
          <div className="status-card-header">
            <div
              className={`status-icon${isSyncing ? " status-icon-syncing" : ""}${isError ? " status-icon-error" : ""}`}
            >
              <NavIcon name={isError ? "error" : isSyncing ? "sync" : isUpToDate || isPaused ? "cloud" : "sync"} />
            </div>
            <div className="status-card-heading">
              <div className={`status-title${isError ? " status-error" : ""}`}>
                {statusTitle}
              </div>
              <div className="status-subtitle">{statusSubtitle}</div>
            </div>
          </div>

          {isError && (
            <button
              type="button"
              className="btn-secondary sync-status-retry"
              onClick={() => api.resumeSync()}
            >
              Retry sync
            </button>
          )}

          <div className="activity-mini-list activity-mini-list-fixed">
            {recent.length === 0 ? (
              <div className="sync-activity-empty">No recent activity yet</div>
            ) : (
              recent.map((item) => (
                <div key={item.id} className="activity-mini-item">
                  <span className="activity-mini-file-icon" aria-hidden>
                    <NavIcon name="file" />
                  </span>
                  <div className="activity-mini-body">
                    <div className="name">{item.name}</div>
                    <div
                      className={`detail${item.status === "error" ? " detail-error" : ""}`}
                    >
                      {item.detail}
                    </div>
                  </div>
                  {item.status === "synced" && <span className="status-check"><NavIcon name="check" /></span>}
                  {item.status === "deleted" && (
                    <span className="status-deleted" aria-label="Removed" title="Removed">
                      <svg
                        className="status-deleted-icon"
                        viewBox="0 0 24 24"
                        width="16"
                        height="16"
                        aria-hidden
                      >
                        <path
                          fill="currentColor"
                          d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v9h-2V9zm4 0h2v9h-2V9zM6 7h12l-1 14H7L6 7z"
                        />
                      </svg>
                    </span>
                  )}
                  {item.status === "uploading" && (
                    <UploadProgressRing progress={item.progress} />
                  )}
                  {item.status === "error" && <span className="status-error-mark"><NavIcon name="close" /></span>}
                </div>
              ))
            )}
          </div>

          <button type="button" className="btn-primary sync-status-view-all" onClick={onViewSyncActivity}>
            View all
          </button>
        </div>

        <div className="card">
          <h3 className="home-panel-title">Shared with me</h3>
          <div className="shared-with-mini-list">
            {sharedItems.length === 0 ? (
              <div className="empty-state" style={{ padding: 16 }}>
                Nothing shared with you yet
              </div>
            ) : (
              sharedItems.map((item) => (
                <div key={item.share.id} className="activity-mini-item">
                  <span><NavIcon name={item.item_type === "folder" ? "folder" : "file"} /></span>
                  <div style={{ flex: 1 }}>
                    <div className="name">{item.item_name}</div>
                    <div className="detail">
                      Shared by {item.owner_name || "someone"}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={onViewShared}
          >
            View all
          </button>
        </div>
      </div>

      <div className="home-right-column">
        <div className="card caught-up-card">
          <h3 className="status-title" style={{ fontSize: 18, marginBottom: 8 }}>
            {caughtUpTitle}
          </h3>
          {hasNotifications ? (
            <>
              <div className="notification-mini-list">
                {miniNotifications.map((n) => (
                  <NotificationMiniCard
                    key={n.id}
                    notification={n}
                    onDismiss={onDismiss}
                    onResumeSync={onResumeSync}
                    onManageStorage={onManageStorage}
                  />
                ))}
              </div>
              {notifications.length > 0 && (
                <button
                  type="button"
                  className="home-see-all-link"
                  onClick={onGoToNotifications}
                >
                  See all
                </button>
              )}
            </>
          ) : (
            <p className="caught-up-text">
              {isError
                ? "Some files could not be synced. Use Retry sync or check Sync activity for details."
                : isSyncing
                  ? "Files are being uploaded. Check Sync activity for details."
                  : "Things that need your attention will show here."}
            </p>
          )}
        </div>

        <div className="card">
          <h3 style={{ fontSize: 16, marginBottom: 12 }}>Quick links</h3>
          <div className="quick-links">
            <button
              type="button"
              className="quick-link"
              onClick={handleAddFolder}
              disabled={addingFolder}
            >
              + Add more folders to sync
            </button>
            <button type="button" className="quick-link" onClick={onOpenDrive}>
              Open My Drive
            </button>
            <button type="button" className="quick-link" onClick={onOpenPreferences}>
              Sync and offline preferences
            </button>
            <button type="button" className="quick-link" onClick={onOpenAbout}>
              About FreeDrive
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
