import { api } from "../api/tauri";
import type { AppNotification } from "../types";

interface NotificationMiniCardProps {
  notification: AppNotification;
  onDismiss: (id: string) => void;
  onResumeSync: () => void;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function NotificationMiniCard({
  notification,
  onDismiss,
  onResumeSync,
}: NotificationMiniCardProps) {
  const handleAction = (action: string) => {
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

  const primaryAction = notification.actions?.find((a) => a.action === "dismiss")
    ?? notification.actions?.[0];

  return (
    <article className="notification-mini-card">
      <div className="notification-mini-card-top">
        <span className="notification-icon notification-icon-sm" aria-hidden>
          !
        </span>
        <div className="notification-mini-body">
          <div className="notification-mini-head">
            <h4 className="notification-mini-title">{notification.title}</h4>
            {notification.isNew && (
              <span className="notification-new-badge">New</span>
            )}
          </div>
          <p className="notification-mini-description">
            {truncate(notification.description, 120)}
          </p>
        </div>
      </div>
      {primaryAction && (
        <div className="notification-mini-actions">
          <button
            type="button"
            className="notification-action-btn"
            onClick={() => handleAction(primaryAction.action)}
          >
            {primaryAction.label}
          </button>
        </div>
      )}
    </article>
  );
}
