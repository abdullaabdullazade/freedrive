import { useCallback, useEffect, useState } from "react";
import { api } from "../api/tauri";
import type { SyncConflict } from "../types";
import { NavIcon } from "./NavIcons";

export function ConflictResolver() {
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [busyPath, setBusyPath] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    api.getSyncConflicts().then(setConflicts).catch((err) => setError(String(err)));
  }, []);

  useEffect(refresh, [refresh]);

  const resolve = async (
    conflict: SyncConflict,
    resolution: "keep_local" | "use_cloud" | "keep_both",
  ) => {
    const label = resolution === "keep_local" ? "discard the cloud conflict copy" :
      resolution === "use_cloud" ? "replace the original with the cloud version (the local version will be backed up)" :
      "keep both files with clear names";
    if (!window.confirm(`Resolve “${conflict.name}” and ${label}?`)) return;
    setBusyPath(conflict.path);
    setError("");
    try {
      await api.resolveSyncConflict(conflict.path, resolution);
      refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyPath("");
    }
  };

  if (conflicts.length === 0 && !error) return null;

  return (
    <section className="conflict-resolver">
      <button type="button" className="conflict-resolver-toggle" onClick={() => setExpanded((value) => !value)}>
        <span><NavIcon name="error" /> {conflicts.length} unresolved sync conflict{conflicts.length === 1 ? "" : "s"}</span>
        <span>{expanded ? "Hide" : "Review"}</span>
      </button>
      {error && <div className="error-banner">{error}</div>}
      {expanded && conflicts.map((conflict) => (
        <div className="conflict-resolver-row" key={conflict.path}>
          <div><strong>{conflict.name}</strong><span title={conflict.path}>{conflict.path}</span></div>
          <div>
            <button type="button" disabled={busyPath === conflict.path} onClick={() => resolve(conflict, "keep_local")}>Keep local</button>
            <button type="button" disabled={busyPath === conflict.path} onClick={() => resolve(conflict, "use_cloud")}>Use cloud</button>
            <button type="button" disabled={busyPath === conflict.path} onClick={() => resolve(conflict, "keep_both")}>Keep both</button>
          </div>
        </div>
      ))}
    </section>
  );
}
