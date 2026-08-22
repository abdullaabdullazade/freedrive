import { api } from "../api/tauri";
import type { AppNotification } from "../types";

interface NotificationsProps {
  notifications: AppNotification[];
  dontShowChecked: Record<string, boolean>;
  onDismiss: (id: string) => void;
  onDontShowChange: (id: string, checked: boolean) => void;
  onResumeSync: () => void;
}

export function Notifications({
  notifications,
  dontShowChecked,
  onDismiss,
  onDontShowChange,
  onResumeSync,
}: NotificationsProps) {
  const handleAction = (notification: AppNotification, action: string) => {
    if (action === "dismiss") {
      onDismiss(notification.id);
      return;
    }
    if (action === "manage_storage") {
      api.openServerUrl("#/storage").catch(console.error);
      onDismiss(notification.id);
      return;
    }
    if (action === "retry_sync") {
      onResumeSync();
      onDismiss(notification.id);
    }
  };

  if (notifications.length === 0) {
    return (
      <div className="notifications-page">
        <h2 className="page-title">Notifications</h2>
        <div className="card caught-up-card">
          <h3 className="status-title" style={{ fontSize: 18, marginBottom: 8 }}>
            You&apos;re all caught up!
          </h3>
          <p className="caught-up-text">
            Things that need your attention will show here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="notifications-page">
      <h2 className="page-title">Notifications</h2>
      <div className="notification-list">
        {notifications.map((n) => (
          <article key={n.id} className="notification-card">
            <div className="notification-card-top">
              <span className="notification-icon" aria-hidden>
                !
              </span>
              <div className="notification-card-head">
                <h3 className="notification-title">{n.title}</h3>
                <div className="notification-card-meta">
                  {n.isNew && <span className="notification-new-badge">New</span>}
                  <button
                    type="button"
                    className="notification-close"
                    aria-label="Dismiss"
                    onClick={() => onDismiss(n.id)}
                  >
                    ×
                  </button>
                </div>
              </div>
            </div>
            <p className="notification-description">{n.description}</p>
            <div className="notification-card-footer">
              <label className="notification-dont-show">
                <input
                  type="checkbox"
                  checked={!!dontShowChecked[n.id]}
                  onChange={(e) => onDontShowChange(n.id, e.target.checked)}
                />
                Don&apos;t show this again
              </label>
              <div className="notification-actions">
                {(n.actions ?? []).map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    className="notification-action-btn"
                    onClick={() => handleAction(n, action.action)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
