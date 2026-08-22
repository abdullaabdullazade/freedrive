import { useRef } from "react";
import type { SyncStatus, User } from "../types";
import { NavIcon } from "./NavIcons";
import { UserAvatar } from "./UserAvatar";

interface TopBarProps {
  user: User | null;
  syncStatus: SyncStatus;
  cryptoUnlocked?: boolean;
  search: string;
  onSearchChange: (v: string) => void;
  onPauseResume: () => void;
  onSettingsClick: (rect: DOMRect) => void;
  onHelp?: () => void;
  onProfileClick: (rect: DOMRect) => void;
}

export function TopBar({
  user,
  syncStatus,
  cryptoUnlocked,
  search,
  onSearchChange,
  onPauseResume,
  onSettingsClick,
  onHelp,
  onProfileClick,
}: TopBarProps) {
  const avatarRef = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<HTMLButtonElement>(null);

  return (
    <header className="topbar">
      <div className="search-bar">
        <NavIcon name="search" />
        <input
          type="search"
          placeholder="Search in Drive"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>
      <div className="topbar-actions">
        {cryptoUnlocked !== undefined && (
          <span
            className="icon-btn crypto-lock-indicator"
            title={cryptoUnlocked ? "Encryption unlocked" : "Encryption locked"}
            aria-label={cryptoUnlocked ? "Encryption unlocked" : "Encryption locked"}
          >
            <NavIcon name={cryptoUnlocked ? "lock" : "lock_open"} />
          </span>
        )}
        <button
          type="button"
          className="icon-btn"
          title={syncStatus.paused ? "Resume sync" : "Pause sync"}
          onClick={onPauseResume}
        >
          <NavIcon name={syncStatus.paused ? "play" : "pause"} />
        </button>
        <button
          ref={settingsRef}
          type="button"
          className="icon-btn"
          title="Settings"
          onClick={() => {
            const rect = settingsRef.current?.getBoundingClientRect();
            if (rect) onSettingsClick(rect);
          }}
        >
          <NavIcon name="settings" />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Help"
          onClick={onHelp}
        >
          <NavIcon name="help" />
        </button>
        <button
          ref={avatarRef}
          type="button"
          className="avatar-btn"
          title={user?.email}
          onClick={() => {
            const rect = avatarRef.current?.getBoundingClientRect();
            if (rect) onProfileClick(rect);
          }}
        >
          <UserAvatar user={user} size="sm" />
        </button>
      </div>
    </header>
  );
}
