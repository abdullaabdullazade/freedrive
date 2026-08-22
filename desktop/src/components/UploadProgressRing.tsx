interface UploadProgressRingProps {
  /** 0–1 when known; undefined shows an indeterminate spinner ring. */
  progress?: number;
  className?: string;
}

/** Google Drive–style circular progress around an upload arrow. */
export function UploadProgressRing({ progress, className = "" }: UploadProgressRingProps) {
  const known = typeof progress === "number" && Number.isFinite(progress);
  const pct = known ? Math.max(0, Math.min(100, progress * 100)) : 0;
  const indeterminate = !known;

  return (
    <span
      className={`status-upload-ring${indeterminate ? " status-upload-ring-indeterminate" : ""}${
        className ? ` ${className}` : ""
      }`}
      aria-hidden
    >
      <svg className="status-upload-ring-svg" viewBox="0 0 36 36">
        <circle className="status-upload-ring-track" cx="18" cy="18" r="15.5" fill="none" />
        <circle
          className="status-upload-ring-fill"
          cx="18"
          cy="18"
          r="15.5"
          fill="none"
          pathLength={100}
          strokeDasharray={indeterminate ? "28 100" : `${pct} 100`}
        />
      </svg>
      <span className="status-uploading">↑</span>
    </span>
  );
}
