import { describe, expect, it } from "vitest";
import { effectiveMimeType, previewKindFor } from "./filePreview";

describe("previewKindFor", () => {
  it("recognizes desktop-safe preview formats", () => {
    expect(previewKindFor("application/pdf", "report.bin")).toBe("pdf");
    expect(previewKindFor("application/octet-stream", "report.pdf")).toBe("pdf");
    expect(previewKindFor("image/png", "photo.png")).toBe("image");
    expect(previewKindFor("application/json", "data.bin")).toBe("text");
    expect(previewKindFor("video/mp4", "clip.mp4")).toBe("video");
    expect(previewKindFor("application/octet-stream", "song.mp3")).toBe("audio");
    expect(previewKindFor("", "recording.m4a")).toBe("audio");
    expect(previewKindFor("binary/octet-stream", "movie.webm")).toBe("video");
  });

  it("supplies playable media MIME types when the server sends a generic type", () => {
    expect(effectiveMimeType("application/octet-stream", "song.mp3")).toBe("audio/mpeg");
    expect(effectiveMimeType("", "movie.mp4")).toBe("video/mp4");
    expect(effectiveMimeType("audio/flac", "song.bin")).toBe("audio/flac");
  });

  it("does not render active SVG content", () => {
    expect(previewKindFor("image/svg+xml", "logo.svg")).toBe("unsupported");
  });
});
