import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

interface AboutDialogProps {
  serverUrl: string | null;
  onClose: () => void;
}

export function AboutDialog({ serverUrl, onClose }: AboutDialogProps) {
  const [version, setVersion] = useState("…");

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
        <button type="button" className="btn-primary" onClick={onClose}>
          OK
        </button>
      </div>
    </div>
  );
}
