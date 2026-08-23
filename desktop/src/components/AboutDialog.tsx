import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

interface AboutDialogProps {
  serverUrl: string | null;
  onClose: () => void;
}

export function AboutDialog({ serverUrl, onClose }: AboutDialogProps) {
  const [version, setVersion] = useState("…");
  const [updateState, setUpdateState] = useState("");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion("0.1.0"));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const checkForUpdates = async () => {
    setChecking(true);
    setUpdateState("Checking for updates…");
    try {
      const update = await check({ timeout: 30_000 });
      if (!update) {
        setUpdateState("FreeDrive is up to date.");
        return;
      }
      setUpdateState(`Downloading signed update ${update.version}…`);
      await update.downloadAndInstall();
      setUpdateState("Update installed. Restarting…");
      await relaunch();
    } catch (err) {
      const message = String(err);
      setUpdateState(
        message.includes("endpoint") || message.includes("configuration") || message.includes("plugin updater")
          ? "Updates are enabled in signed release builds."
          : `Update check failed: ${message}`,
      );
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="about-dialog-overlay" onClick={onClose} role="presentation">
      <div
        className="about-dialog"
        role="dialog"
        aria-labelledby="about-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="about-dialog-title">About FreeDrive</h2>
        <dl className="about-dialog-meta">
          <div>
            <dt>Application</dt>
            <dd>FreeDrive Desktop</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{version}</dd>
          </div>
          <div>
            <dt>Server</dt>
            <dd className="about-dialog-server">{serverUrl || "—"}</dd>
          </div>
        </dl>
        <div className="about-dialog-update">
          <button type="button" className="btn-secondary" disabled={checking} onClick={checkForUpdates}>
            {checking ? "Checking…" : "Check for updates"}
          </button>
          {updateState && <p role="status">{updateState}</p>}
        </div>
        <button type="button" className="btn-primary" onClick={onClose}>
          OK
        </button>
      </div>
    </div>
  );
}
