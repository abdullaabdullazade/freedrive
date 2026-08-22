export type PreviewKind = "pdf" | "image" | "video" | "audio" | "text" | "unsupported";

const textExtensions = new Set([
  "txt", "md", "json", "csv", "log", "xml", "yaml", "yml", "toml", "ini",
  "js", "jsx", "ts", "tsx", "css", "html", "htm", "go", "rs", "py", "sh",
]);

const mimeByExtension: Record<string, string> = {
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
  flac: "audio/flac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mkv: "video/x-matroska", avi: "video/x-msvideo",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", avif: "image/avif",
  pdf: "application/pdf",
};

export function effectiveMimeType(mimeType: string, name: string): string {
  const mime = mimeType.trim().toLowerCase();
  const extension = name.split(".").pop()?.toLowerCase() || "";
  if (!mime || mime === "application/octet-stream" || mime === "binary/octet-stream") {
    return mimeByExtension[extension] || "application/octet-stream";
  }
  return mime;
}

export function previewKindFor(mimeType: string, name: string): PreviewKind {
  const mime = effectiveMimeType(mimeType, name);
  const extension = name.split(".").pop()?.toLowerCase() || "";
  if (mime === "application/pdf" || extension === "pdf") return "pdf";
  // SVG can reference remote content; keep encrypted previews fully local.
  if (mime === "image/svg+xml" || extension === "svg") return "unsupported";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/") || mime.includes("json") || mime.includes("xml") || textExtensions.has(extension)) {
    return "text";
  }
  return "unsupported";
}

export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
