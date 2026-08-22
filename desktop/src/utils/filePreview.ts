export type PreviewKind = "pdf" | "image" | "video" | "audio" | "text" | "unsupported";

const textExtensions = new Set([
  "txt", "md", "json", "csv", "log", "xml", "yaml", "yml", "toml", "ini",
  "js", "jsx", "ts", "tsx", "css", "html", "htm", "go", "rs", "py", "sh",
]);

export function previewKindFor(mimeType: string, name: string): PreviewKind {
  const mime = mimeType.toLowerCase();
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
