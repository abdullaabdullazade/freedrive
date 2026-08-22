import type { MainView } from "../types";
import { Logo } from "./Logo";
import { NavIcon } from "./NavIcons";

interface SidebarProps {
  view: MainView;
  notificationCount?: number;
  onNavigate: (view: MainView) => void;
  onOpenFolder: () => void;
}

export function Sidebar({
  view,
  notificationCount = 0,
  onNavigate,
  onOpenFolder,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <Logo />
      <button type="button" className="open-folder-btn" onClick={onOpenFolder}>
        <NavIcon name="folder" />
        Open Drive folder
      </button>
      <nav>
        <button
          type="button"
          className={`nav-item${view === "home" ? " active" : ""}`}
          onClick={() => onNavigate("home")}
        >
          <NavIcon name="home" />
          <span className="nav-label">Home</span>
        </button>
        <button
          type="button"
          className={`nav-item${view === "sync" ? " active" : ""}`}
          onClick={() => onNavigate("sync")}
        >
          <NavIcon name="sync" />
          <span className="nav-label">Sync activity</span>
        </button>
        <button
          type="button"
          className={`nav-item${view === "notifications" ? " active" : ""}`}
          onClick={() => onNavigate("notifications")}
        >
          <NavIcon name="notifications" />
          <span className="nav-label">Notifications</span>
          {notificationCount > 0 && (
            <span className="nav-badge" aria-label={`${notificationCount} notifications`}>
              {notificationCount}
            </span>
          )}
        </button>
      </nav>
    </aside>
  );
}
