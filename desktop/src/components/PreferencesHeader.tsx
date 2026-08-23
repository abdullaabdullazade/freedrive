import type { RefObject } from "react";
import type { User } from "../types";
import { NavIcon } from "./NavIcons";
import { UserAvatar } from "./UserAvatar";

export type PreferencesView = "sync" | "settings";

interface PreferencesHeaderProps {
  user: User | null;
  preferencesView: PreferencesView;
  onHelp: () => void;
  onOpenSettings: () => void;
  onProfileClick: (rect: DOMRect) => void;
  avatarButtonRef: RefObject<HTMLButtonElement | null>;
}

export function PreferencesHeader({
  user,
  preferencesView,
  onHelp,
  onOpenSettings,
  onProfileClick,
  avatarButtonRef,
}: PreferencesHeaderProps) {
  return (
    <header className="preferences-header">
      <div className="preferences-header-brand">
        <img src="/logo.svg" alt="" className="logo-icon" width={28} height={28} />
        <span>FreeDrive</span>
      </div>
      <div className="preferences-header-actions">
        <button type="button" className="icon-btn" title="Help" onClick={onHelp}>
          <NavIcon name="help" />
        </button>
        <button
          type="button"
          className={`icon-btn${preferencesView === "settings" ? " active" : ""}`}
          title="Settings"
          onClick={onOpenSettings}
        >
          <NavIcon name="settings" />
        </button>
        <button
          ref={avatarButtonRef}
          type="button"
          className="avatar-btn"
          title={user?.email}
          onClick={() => {
            const rect = avatarButtonRef.current?.getBoundingClientRect();
            if (rect) onProfileClick(rect);
          }}
        >
          <UserAvatar user={user} size="sm" />
        </button>
      </div>
    </header>
  );
}
