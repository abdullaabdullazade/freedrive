import { useCallback, useMemo, useState } from "react";
import type {
  ActivityItem,
  AppNotification,
  StorageInfo,
  SyncStatus,
} from "../types";

const DISMISSED_KEY = "fd_dismissed_notifications";
const DONT_SHOW_KEY = "fd_dont_show_notifications";
const SEEN_KEY = "fd_seen_notifications";

function loadSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

function saveSet(key: string, values: Set<string>) {
  localStorage.setItem(key, JSON.stringify([...values]));
}

function formatGb(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 10) return `${Math.round(gb)} GB`;
  return `${gb.toFixed(1)} GB`;
}

function buildNotifications(
  syncStatus: SyncStatus,
  activity: ActivityItem[],
  storage: StorageInfo | null,
): AppNotification[] {
  const items: AppNotification[] = [];

  if (storage && storage.total_bytes > 0) {
    const pct = (storage.used_bytes / storage.total_bytes) * 100;
    if (pct >= 90) {
      items.push({
        id: "storage_critical",
        kind: "storage_critical",
        title: "Almost out of storage",
        description:
          "If you run out, you can't save to Drive, send and receive emails on Gmail or back up to Google Photos.",
        actions: [
          { label: "OK", action: "dismiss" },
          { label: "Manage storage", action: "manage_storage" },
        ],
      });
    } else if (pct >= 80) {
      items.push({
        id: "storage_warning",
        kind: "storage_warning",
        title: "Storage is getting full",
        description: `You're using ${Math.round(pct)}% of your ${formatGb(storage.total_bytes)} storage. Free up space or upgrade to avoid sync issues.`,
        actions: [
          { label: "OK", action: "dismiss" },
          { label: "Manage storage", action: "manage_storage" },
        ],
      });
    }
  }

  if (syncStatus.status === "error") {
    items.push({
      id: "sync_error",
      kind: "sync_error",
      title: "Sync error",
      description:
        syncStatus.message ||
        "FreeDrive couldn't finish syncing your files. Check your connection and try again.",
      actions: [
        { label: "OK", action: "dismiss" },
        { label: "Retry sync", action: "retry_sync" },
      ],
    });
  }

  if (syncStatus.paused) {
    items.push({
      id: "sync_paused",
      kind: "sync_paused",
      title: "Sync is paused",
      description:
        "Your files aren't syncing while pause is on. Resume sync to keep everything up to date.",
      actions: [
        { label: "OK", action: "dismiss" },
        { label: "Resume sync", action: "retry_sync" },
      ],
    });
  }

  const errorFiles = activity.filter((a) => a.status === "error").slice(0, 3);
  for (const file of errorFiles) {
    items.push({
      id: `file_error_${file.id}`,
      kind: "file_error",
      title: `Couldn't sync ${file.name}`,
      description:
        file.detail ||
        "This file couldn't be uploaded or updated. It will retry automatically when possible.",
      actions: [{ label: "OK", action: "dismiss" }],
    });
  }

  return items;
}

export function useNotifications(
  syncStatus: SyncStatus,
  activity: ActivityItem[],
  storage: StorageInfo | null,
) {
  const [dismissed, setDismissed] = useState(() => loadSet(DISMISSED_KEY));
  const [dontShow, setDontShow] = useState(() => loadSet(DONT_SHOW_KEY));
  const [seen, setSeen] = useState(() => loadSet(SEEN_KEY));
  const [dontShowChecked, setDontShowChecked] = useState<Record<string, boolean>>(
    {},
  );

  const allNotifications = useMemo(
    () => buildNotifications(syncStatus, activity, storage),
    [syncStatus, activity, storage],
  );

  const activeNotifications = useMemo(
    () =>
      allNotifications
        .filter((n) => !dontShow.has(n.id))
        .filter((n) => !dismissed.has(n.id))
        .map((n) => ({
          ...n,
          isNew: !seen.has(n.id),
        })),
    [allNotifications, dontShow, dismissed, seen],
  );

  const badgeCount = activeNotifications.length;

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveSet(DISMISSED_KEY, next);
      return next;
    });
    if (dontShowChecked[id]) {
      setDontShow((prev) => {
        const next = new Set(prev);
        next.add(id);
        saveSet(DONT_SHOW_KEY, next);
        return next;
      });
    }
  }, [dontShowChecked]);

  const markAllSeen = useCallback(() => {
    setSeen((prev) => {
      const next = new Set(prev);
      for (const n of allNotifications) {
        next.add(n.id);
      }
      saveSet(SEEN_KEY, next);
      return next;
    });
  }, [allNotifications]);

  const setDontShowFor = useCallback((id: string, checked: boolean) => {
    setDontShowChecked((prev) => ({ ...prev, [id]: checked }));
  }, []);

  return {
    notifications: activeNotifications,
    badgeCount,
    dismiss,
    markAllSeen,
    setDontShowFor,
    dontShowChecked,
  };
}
