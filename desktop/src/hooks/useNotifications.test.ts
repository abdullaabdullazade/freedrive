import { describe, expect, it } from "vitest";
import { buildNotifications } from "./useNotifications";
import type { SyncStatus } from "../types";

const healthy: SyncStatus = {
  status: "up_to_date",
  message: "Up to date",
  last_synced_at: null,
  paused: false,
};

describe("buildNotifications", () => {
  it("surfaces conflict copies", () => {
    const notifications = buildNotifications(
      healthy,
      [{
        id: 7,
        name: "plan.pdf",
        detail: "Remote version saved as a conflict copy",
        file_size: 12,
        status: "conflict",
        created_at: new Date().toISOString(),
      }],
      null,
    );
    expect(notifications[0]).toMatchObject({
      id: "sync_conflict_7",
      kind: "sync_conflict",
    });
  });

  it("warns only after storage reaches eighty percent", () => {
    expect(buildNotifications(healthy, [], { used_bytes: 79, total_bytes: 100 })).toHaveLength(0);
    expect(buildNotifications(healthy, [], { used_bytes: 80, total_bytes: 100 })[0].kind)
      .toBe("storage_warning");
  });
});
