import { useEffect, useState } from "react";
import { api, onSyncActivity, onSyncStatusChanged } from "../api/tauri";
import { Logo } from "../components/Logo";
import { Stepper } from "../components/Stepper";
import type { SelectedFolder, SystemFolder, SyncStatus } from "../types";

interface OnboardingWizardProps {
  onComplete: () => void;
}

const STEPS = [
  { number: 1, label: "Sync with FreeDrive", sublabel: "Optional" },
  { number: 2, label: "Review selected folders" },
  { number: 3, label: "See Drive files in File Explorer" },
  { number: 4, label: "Offline files" },
];

const ONBOARDING_COMPLETE_TIMEOUT_MS = 5000;

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState(1);
  const [systemFolders, setSystemFolders] = useState<SystemFolder[]>([]);
  const [selected, setSelected] = useState<SelectedFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [lastActivity, setLastActivity] = useState("");

  useEffect(() => {
    api.getSystemFolders().then(setSystemFolders).catch(console.error);
  }, []);

  useEffect(() => {
    if (step < 3) return;
    const unsubs: (() => void)[] = [];
    onSyncStatusChanged(setSyncStatus).then((u) => unsubs.push(u));
    onSyncActivity((item) => {
      if (item.name) {
        setLastActivity(`${item.name} — ${item.detail || item.status || "syncing"}`);
      }
    }).then((u) => unsubs.push(u));
    return () => unsubs.forEach((u) => u());
  }, [step]);

  const toggleFolder = (folder: SystemFolder) => {
    setSelected((prev) => {
      const exists = prev.find((f) => f.path === folder.path);
      if (exists) {
        return prev.filter((f) => f.path !== folder.path);
      }
      return [...prev, { path: folder.path, label: folder.label }];
    });
  };

  const isChecked = (path: string) => selected.some((f) => f.path === path);

  const addCustomFolder = async () => {
    const path = await api.pickFolder();
    if (!path) return;
    if (selected.some((f) => f.path === path)) return;
    const label = path.split(/[/\\]/).pop() || "Folder";
    setSelected((prev) => [...prev, { path, label }]);
  };

  const finishWizard = async () => {
    setError("");
    setLoading(true);
    try {
      await Promise.race([
        api.completeOnboarding(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, ONBOARDING_COMPLETE_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
      onComplete();
    }
  };

  const handleNext = async () => {
    setError("");
    if (step === 1) {
      if (selected.length === 0) {
        setError("Select at least one folder or click Skip.");
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      setLoading(true);
      try {
        await api.saveSyncConfig(selected);
        setStep(3);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
      return;
    }
    if (step >= 4) {
      await finishWizard();
      return;
    }
    setStep((s) => s + 1);
  };

  const handleSkip = async () => {
    if (step === 1) {
      await finishWizard();
      return;
    }
    if (step < 4) {
      setStep((s) => s + 1);
      return;
    }
    await finishWizard();
  };

  const totalSize = "0 bytes";

  return (
    <div className="wizard-layout">
      <div className="wizard-sidebar">
        <Logo />
        <Stepper steps={STEPS} current={step} />
      </div>
      <div className="wizard-main">
        <div className="wizard-content">
          {error && <div className="error-banner">{error}</div>}

          {step === 1 && (
            <>
              <h2 className="wizard-title">Welcome to FreeDrive!</h2>
              <p className="wizard-subtitle">
                Choose folders to sync from your computer to FreeDrive:
              </p>
              <div className="folder-list">
                {systemFolders.map((folder) => (
                  <label key={folder.path} className="folder-item">
                    <input
                      type="checkbox"
                      checked={isChecked(folder.path)}
                      onChange={() => toggleFolder(folder)}
                    />
                    <div className="folder-info">
                      <div className="folder-name-row">
                        <span className="folder-name">📁 {folder.label}</span>
                        {folder.suggested && (
                          <span className="badge-suggested">Suggested folder</span>
                        )}
                      </div>
                      <div className="folder-path">{folder.path}</div>
                    </div>
                  </label>
                ))}
              </div>
              <button
                type="button"
                className="btn-text"
                style={{ marginTop: 16 }}
                onClick={addCustomFolder}
              >
                Add folder
              </button>
            </>
          )}

          {step === 2 && (
            <>
              <h2 className="wizard-title">This folder will sync to Drive</h2>
              <p className="wizard-subtitle">
                The selected folders will start to sync once setup is complete
              </p>
              <div className="folder-list">
                {selected.map((folder) => (
                  <div key={folder.path} className="folder-item">
                    <div className="folder-info">
                      <div className="folder-name">📁 {folder.label}</div>
                      <div className="folder-path">{folder.path}</div>
                    </div>
                  </div>
                ))}
              </div>
              <p style={{ marginTop: 16, color: "var(--fd-text-secondary)" }}>
                {selected.length} folder{selected.length !== 1 ? "s" : ""} selected, {totalSize}
              </p>
            </>
          )}

          {step === 3 && (
            <>
              <h2 className="wizard-title">
                Your Drive files are just a click away in File Explorer
              </h2>
              <p className="wizard-subtitle">
                Your files will show up in File Explorer without taking up hard drive space
              </p>
              <ul style={{ marginTop: 16, paddingLeft: 20, color: "var(--fd-text-secondary)" }}>
                <li>{selected.length} folder{selected.length !== 1 ? "s" : ""} syncing in the background</li>
              </ul>
              {syncStatus && syncStatus.status === "syncing" && (
                <p className="setup-sync-hint">
                  Syncing: {syncStatus.message}
                  {lastActivity ? ` — ${lastActivity}` : ""}
                </p>
              )}
              <button
                type="button"
                className="btn-text"
                style={{ marginTop: 16 }}
                onClick={async () => {
                  setError("");
                  try {
                    await api.openDriveFolder();
                  } catch (err) {
                    setError(String(err));
                  }
                }}
              >
                → Open File Explorer to see Drive files
              </button>
            </>
          )}

          {step === 4 && (
            <>
              <h2 className="wizard-title">My Drive uses Stream by default</h2>
              <p className="wizard-subtitle">
                Files stay in the cloud until you open them — they do not fill your disk
              </p>
              <p style={{ marginTop: 24, color: "var(--fd-text-secondary)", lineHeight: 1.6 }}>
                Opening a file downloads it temporarily; closing it uploads any edits and frees
                local space again. Prefer Preferences → FreeDrive → <strong>Mirror files</strong>{" "}
                only if you want a full offline copy of My Drive.
              </p>
            </>
          )}
        </div>
        <div className="wizard-footer">
          {step > 1 && (
            <button type="button" className="btn-text" onClick={() => setStep((s) => s - 1)} disabled={loading}>
              Back
            </button>
          )}
          {step === 1 && (
            <button type="button" className="btn-text" onClick={handleSkip}>
              Skip
            </button>
          )}
          <button
            type="button"
            className="btn-primary"
            onClick={handleNext}
            disabled={loading || (step === 1 && selected.length === 0)}
          >
            {loading
              ? step >= 4
                ? "Opening FreeDrive…"
                : "Saving…"
              : step >= 4
                ? "Open FreeDrive"
                : "Next"}
          </button>
        </div>

        {loading && (
          <div className="setup-overlay">
            <div className="setup-overlay-card">
              <div className="setup-spinner" />
              <p>{step >= 4 ? "Opening FreeDrive…" : "Saving sync settings…"}</p>
              <p className="setup-overlay-sub">
                {step >= 4
                  ? "File upload continues in the background."
                  : "File upload continues in the background. You can continue setup."}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
