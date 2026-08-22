import { useCallback, useEffect, useState } from "react";
import {
  api,
  onCryptoKeyQueued,
  onCryptoKeysSynced,
  onCryptoRecoverySetup,
  onCryptoUnlockFailed,
  onCryptoUnlocked,
  onMyDriveHydrateFailed,
  onSyncActivity,
  onSyncProgress,
  onSyncStatusChanged,
  onUploadProgress,
} from "../api/tauri";
import { ProfileMenu } from "../components/ProfileMenu";
import { AboutDialog } from "../components/AboutDialog";
import { SettingsMenu, type SettingsMenuAction } from "../components/SettingsMenu";
import { Sidebar } from "../components/Sidebar";
import { TopBar } from "../components/TopBar";
import { useNotifications } from "../hooks/useNotifications";
import { Home } from "./Home";
import { Notifications } from "./Notifications";
import { SyncActivity } from "./SyncActivity";
import type {
  ActivityItem,
  MainView,
  StorageInfo,
  SyncProgress,
  SyncStatus,
  User,
} from "../types";

interface MainAppProps {
  user: User | null;
  serverUrl: string | null;
  onLogout: () => void;
  onUserUpdate: (user: User | null) => void;
}

const defaultStatus: SyncStatus = {
  status: "up_to_date",
  message: "Up to date",
  last_synced_at: null,
  paused: false,
};

export function MainApp({ user, serverUrl, onLogout, onUserUpdate }: MainAppProps) {
  const [view, setView] = useState<MainView>("home");
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(defaultStatus);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [search, setSearch] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileAnchor, setProfileAnchor] = useState<DOMRect | null>(null);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [settingsAnchor, setSettingsAnchor] = useState<DOMRect | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [activityErrorsOnly, setActivityErrorsOnly] = useState(false);
  const [hydrateWarning, setHydrateWarning] = useState("");
  const [folderError, setFolderError] = useState("");
  const [explorerWarning, setExplorerWarning] = useState("");
  const [cryptoUnlocked, setCryptoUnlocked] = useState(false);
  const [cryptoUnlockError, setCryptoUnlockError] = useState("");
  const [needsCryptoRecovery, setNeedsCryptoRecovery] = useState(false);

  const refreshCryptoStatus = useCallback(async () => {
    try {
      const status = await api.getCryptoStatus();
      setCryptoUnlocked(status.unlocked);
      setNeedsCryptoRecovery(status.needs_recovery);
      if (status.unlocked) {
        setCryptoUnlockError("");
      }
    } catch {
      setCryptoUnlocked(false);
      setNeedsCryptoRecovery(false);
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      const profile = await api.getProfile();
      onUserUpdate(profile);
    } catch {
      /* profile fetch optional */
    }
  }, [onUserUpdate]);

  const refreshStorage = useCallback(async () => {
    try {
      const storage = await api.getStorageInfo();
      setStorageInfo(storage);
    } catch {
      /* storage optional */
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const status = await api.getSyncStatus();
      setSyncStatus(status);
    } catch {
      /* sync engine may not be ready */
    }
    try {
      const items = await api.getSyncActivity();
      setActivity(items);
    } catch {
      /* activity db may not be ready */
    }
    refreshStorage();
  }, [refreshStorage]);

  const {
    notifications,
    badgeCount,
    dismiss,
    markAllSeen,
    setDontShowFor,
    dontShowChecked,
  } = useNotifications(syncStatus, activity, storageInfo);

  useEffect(() => {
    refreshProfile();
    refresh();
    refreshCryptoStatus();
    api
      .getExplorerIntegrationStatus()
      .then((status) => {
        if (status.registered && !status.connected) {
          setExplorerWarning(
            "File Explorer integration is disconnected. Use Open Drive folder to reconnect.",
          );
        }
      })
      .catch(() => {
        /* optional status */
      });
    const unsubs: (() => void)[] = [];
    onSyncStatusChanged((status) => {
      setSyncStatus(status);
      if (status.status !== "syncing") {
        setSyncProgress(null);
      }
    }).then((u) => unsubs.push(u));
    onSyncProgress((progress) => {
      if (progress.phase === "done") {
        setSyncProgress(null);
        return;
      }
      if (
        progress.total > 0 ||
        progress.phase === "syncing" ||
        progress.message?.startsWith("Scanning complete")
      ) {
        setSyncProgress(progress);
      }
      if (progress.show_in_ui === false) return;
      if (progress.phase === "syncing") {
        setSyncStatus((prev) => ({
          ...prev,
          status: "syncing",
          message: progress.message,
        }));
      }
    }).then((u) => unsubs.push(u));
    onSyncActivity((item) => {
      setActivity((prev) => {
        const name = item.name || "File";
        const status = item.status || "uploading";
        const detail = item.detail || "";
        const appendOnly =
          status === "deleted" || detail === "Restored from cloud";
        const prevProgress = !appendOnly
          ? prev.find((a) => a.name === name)?.progress
          : undefined;
        const row: ActivityItem = {
          id: typeof item.id === "number" ? item.id : Date.now(),
          name,
          detail,
          file_size: item.file_size || 0,
          status,
          created_at: new Date().toISOString(),
          progress: status === "uploading" ? prevProgress : undefined,
        };
        if (appendOnly) {
          return [row, ...prev].slice(0, 50);
        }
        const idx = prev.findIndex((a) => a.name === name);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...row, id: prev[idx].id };
          return next;
        }
        return [row, ...prev].slice(0, 50);
      });
    }).then((u) => unsubs.push(u));
    onUploadProgress((prog) => {
      const total = prog.bytes_total > 0 ? prog.bytes_total : 0;
      const fraction = total > 0 ? Math.min(1, prog.bytes_sent / total) : 0;
      setActivity((prev) => {
        const idx = prev.findIndex((a) => a.name === prog.name);
        if (idx < 0) return prev;
        if (prev[idx].status !== "uploading") return prev;
        if (prev[idx].progress === fraction) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], progress: fraction };
        return next;
      });
    }).then((u) => unsubs.push(u));
    onMyDriveHydrateFailed((event) => {
      const isWebKey =
        event.message.includes("uploaded via web") ||
        event.message.includes("encryption key not available");
      setHydrateWarning(
        isWebKey
          ? "Could not decrypt this file yet. Sign out and sign in again to sync encryption keys, or open Preferences for export/import."
          : event.message,
      );
    }).then((u) => unsubs.push(u));
    onCryptoRecoverySetup(() => {
      api.openPreferencesWindow().catch(console.error);
      setCryptoUnlocked(true);
    }).then((u) => unsubs.push(u));
    onCryptoKeysSynced(() => {
      setCryptoUnlocked(true);
      setCryptoUnlockError("");
    }).then((u) => unsubs.push(u));
    onCryptoUnlocked(() => {
      setCryptoUnlocked(true);
      setCryptoUnlockError("");
      refreshCryptoStatus();
    }).then((u) => unsubs.push(u));
    onCryptoUnlockFailed((message) => {
      setCryptoUnlockError(message);
      setCryptoUnlocked(false);
      refreshCryptoStatus();
    }).then((u) => unsubs.push(u));
    onCryptoKeyQueued((message) => {
      setHydrateWarning(message);
    }).then((u) => unsubs.push(u));
    const interval = setInterval(refresh, 10000);
    return () => {
      unsubs.forEach((u) => u());
      clearInterval(interval);
    };
  }, [refresh, refreshProfile, refreshCryptoStatus]);

  useEffect(() => {
    if (view === "notifications") {
      markAllSeen();
    }
  }, [view, markAllSeen]);

  useEffect(() => {
    if (profileOpen) {
      void refreshStorage();
    }
  }, [profileOpen, refreshStorage]);

  useEffect(() => {
    const onFocus = () => {
      void refreshStorage();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshStorage]);

  const handleSettingsAction = (action: SettingsMenuAction) => {
    switch (action) {
      case "preferences":
        api.openPreferencesWindow().catch(console.error);
        break;
      case "error-list":
        setActivityErrorsOnly(true);
        setView("sync");
        break;
      case "about":
        setAboutOpen(true);
        break;
      case "help":
        api.openProjectUrl().catch(console.error);
        break;
      case "quit":
        api.quitApp().catch(console.error);
        break;
    }
  };

  const handlePauseResume = async () => {
    try {
      if (syncStatus.paused) {
        await api.resumeSync();
      } else {
        await api.pauseSync();
      }
      refresh();
    } catch (err) {
      console.error("pause/resume failed:", err);
    }
  };

  const handleSignOut = async () => {
    try {
      await api.logout();
      setProfileOpen(false);
      onLogout();
    } catch (err) {
      console.error("sign out failed:", err);
    }
  };

  const handleOpenDriveFolder = async () => {
    setFolderError("");
    setExplorerWarning("");
    try {
      await api.openDriveFolder();
    } catch (err) {
      const message = String(err);
      setFolderError(message);
      setExplorerWarning(message);
    }
  };

  const recoveryBanner = needsCryptoRecovery
    ? "Encryption recovery required. Open Preferences → Settings → Encryption & keys."
    : "";

  return (
    <div className="main-layout">
      <Sidebar
        view={view}
        notificationCount={badgeCount}
        onNavigate={(next) => {
          if (next === "sync") setActivityErrorsOnly(false);
          setView(next);
        }}
        onOpenFolder={handleOpenDriveFolder}
      />
      <div className="main-content">
        {(folderError ||
          explorerWarning ||
          hydrateWarning ||
          cryptoUnlockError ||
          recoveryBanner) && (
          <div className="error-banner" style={{ margin: "8px 16px 0" }}>
            {cryptoUnlockError || recoveryBanner || hydrateWarning || folderError || explorerWarning}
          </div>
        )}
        <TopBar
          user={user}
          syncStatus={syncStatus}
          cryptoUnlocked={cryptoUnlocked}
          search={search}
          onSearchChange={setSearch}
          onPauseResume={handlePauseResume}
          onSettingsClick={(rect) => {
            setSettingsAnchor(rect);
            setSettingsMenuOpen((open) => !open);
            setProfileOpen(false);
          }}
          onHelp={() => api.openProjectUrl().catch(console.error)}
          onProfileClick={(rect) => {
            setProfileAnchor(rect);
            setProfileOpen((open) => !open);
            setSettingsMenuOpen(false);
          }}
        />
        <div className="content-area">
          {view === "home" && (
            <Home
              syncStatus={syncStatus}
              syncProgress={syncProgress}
              activity={activity}
              notifications={notifications}
              onDismiss={dismiss}
              onGoToNotifications={() => setView("notifications")}
              onViewSyncActivity={() => {
                setActivityErrorsOnly(false);
                setView("sync");
              }}
              onResumeSync={handlePauseResume}
              onFoldersChanged={refresh}
            />
          )}
          {view === "sync" && (
            <SyncActivity
              syncStatus={syncStatus}
              activity={activity}
              search={search}
              errorsOnly={activityErrorsOnly}
              onErrorsOnlyChange={setActivityErrorsOnly}
            />
          )}
          {view === "notifications" && (
            <Notifications
              notifications={notifications}
              dontShowChecked={dontShowChecked}
              onDismiss={dismiss}
              onDontShowChange={setDontShowFor}
              onResumeSync={handlePauseResume}
            />
          )}
        </div>
      </div>

      {settingsMenuOpen && (
        <SettingsMenu
          anchorRect={settingsAnchor}
          onClose={() => setSettingsMenuOpen(false)}
          onAction={handleSettingsAction}
        />
      )}

      {aboutOpen && (
        <AboutDialog serverUrl={serverUrl} onClose={() => setAboutOpen(false)} />
      )}

      {profileOpen && (
        <ProfileMenu
          user={user}
          serverUrl={serverUrl}
          anchorRect={profileAnchor}
          onClose={() => setProfileOpen(false)}
          onSignOut={handleSignOut}
        />
      )}
    </div>
  );
}
