import { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, formatBytes } from "../api/tauri";
import type { DriveFilePreview } from "../types";
import { decodeBase64, previewKindFor } from "../utils/filePreview";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

interface FileViewerProps {
  fileId: string;
  fallbackName: string;
  onClose: () => void;
}

function PdfCanvas({ bytes }: { bytes: Uint8Array<ArrayBuffer> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.25);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const task = pdfjs.getDocument({ data: bytes.slice() });
    task.promise.then((loaded) => {
      if (active) setDocument(loaded);
      else void loaded.destroy();
    }).catch((err) => active && setError(String(err)));
    return () => {
      active = false;
      void task.destroy();
    };
  }, [bytes]);

  useEffect(() => {
    if (!document || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;
    document.getPage(page).then((pdfPage) => {
      if (cancelled || !canvasRef.current) return;
      const viewport = pdfPage.getViewport({ scale });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      renderTask = pdfPage.render({ canvas, canvasContext: context, viewport });
      return renderTask.promise;
    }).catch((err) => {
      if (!cancelled && String(err).indexOf("RenderingCancelledException") < 0) setError(String(err));
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, page, scale]);

  if (error) return <div className="file-viewer-message">Could not render PDF: {error}</div>;
  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <div className="pdf-toolbar-group">
          <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button>
          <span>Page {page} of {document?.numPages || "…"}</span>
          <button type="button" disabled={!document || page >= document.numPages} onClick={() => setPage((value) => value + 1)}>Next</button>
        </div>
        <div className="pdf-toolbar-group">
          <button type="button" aria-label="Zoom out" onClick={() => setScale((value) => Math.max(0.5, value - 0.25))}>−</button>
          <span>{Math.round(scale * 100)}%</span>
          <button type="button" aria-label="Zoom in" onClick={() => setScale((value) => Math.min(3, value + 0.25))}>+</button>
        </div>
      </div>
      <div className="pdf-canvas-wrap"><canvas ref={canvasRef} /></div>
    </div>
  );
}

export function FileViewer({ fileId, fallbackName, onClose }: FileViewerProps) {
  const [preview, setPreview] = useState<DriveFilePreview | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const initialFullscreen = useRef(false);

  useEffect(() => {
    getCurrentWindow().isFullscreen().then((value) => {
      initialFullscreen.current = value;
      setFullscreen(value);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let active = true;
    api.previewDriveFile(fileId)
      .then((value) => active && setPreview(value))
      .catch((err) => active && setError(String(err)));
    return () => { active = false; };
  }, [fileId]);

  const closeViewer = async () => {
    if (fullscreen !== initialFullscreen.current) {
      await getCurrentWindow().setFullscreen(initialFullscreen.current).catch(() => {});
    }
    onClose();
  };

  const toggleFullscreen = async () => {
    const next = !fullscreen;
    setFullscreen(next);
    await getCurrentWindow().setFullscreen(next).catch(() => {});
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void closeViewer();
      if (event.key === "F11") {
        event.preventDefault();
        void toggleFullscreen();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullscreen, onClose]);

  const bytes = useMemo(() => preview ? decodeBase64(preview.data_base64) : null, [preview]);
  const kind = preview ? previewKindFor(preview.mime_type, preview.name) : "unsupported";
  const objectUrl = useMemo(() => {
    if (!preview || !bytes || !["image", "video", "audio"].includes(kind)) return "";
    return URL.createObjectURL(new Blob([bytes], { type: preview.mime_type }));
  }, [bytes, kind, preview]);
  useEffect(() => () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, [objectUrl]);

  const saveCopy = async () => {
    setSaving(true);
    setError("");
    try { await api.downloadDriveFile(fileId, preview?.name || fallbackName); }
    catch (err) { setError(String(err)); }
    finally { setSaving(false); }
  };

  return (
    <div className={`file-viewer-overlay${fullscreen ? " file-viewer-overlay-fullscreen" : ""}`} role="presentation" onClick={() => void closeViewer()}>
      <section className="file-viewer" role="dialog" aria-modal="true" aria-label={`Preview ${preview?.name || fallbackName}`} onClick={(event) => event.stopPropagation()}>
        <header className="file-viewer-header">
          <div className="file-viewer-title"><strong title={preview?.name || fallbackName}>{preview?.name || fallbackName}</strong>{preview && <span>{preview.mime_type || "File"} · {formatBytes(preview.size)}</span>}</div>
          <div className="file-viewer-actions">
            <button type="button" className="btn-secondary" onClick={saveCopy} disabled={saving}>{saving ? "Saving…" : "Save copy"}</button>
            <button type="button" className="btn-secondary file-viewer-fullscreen" onClick={() => void toggleFullscreen()} aria-pressed={fullscreen}>{fullscreen ? "Exit full screen" : "Full screen"}</button>
            <button type="button" className="drive-dialog-close" onClick={() => void closeViewer()} aria-label="Close">×</button>
          </div>
        </header>
        <div className="file-viewer-body">
          {error ? <div className="error-banner">{error}</div> : !preview || !bytes ? <div className="file-viewer-message">Decrypting and loading preview…</div> : kind === "pdf" ? <PdfCanvas bytes={bytes} /> : kind === "image" ? <img className="file-viewer-image" src={objectUrl} alt={preview.name} /> : kind === "video" ? <video className="file-viewer-media" src={objectUrl} controls /> : kind === "audio" ? <audio className="file-viewer-audio" src={objectUrl} controls /> : kind === "text" ? <pre className="file-viewer-text">{new TextDecoder().decode(bytes)}</pre> : <div className="file-viewer-message">A built-in preview is not available for this file type. You can save a decrypted copy and open it with an installed app.</div>}
        </div>
      </section>
    </div>
  );
}
