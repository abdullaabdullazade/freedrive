import { describe, expect, it } from "vitest";
import { binaryPreview, effectiveMimeType, previewKindFor, textPreview } from "./filePreview";

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

  it("opens code safely and falls back to a binary inspector", () => {
    expect(previewKindFor("image/svg+xml", "logo.svg")).toBe("text");
    expect(previewKindFor("application/octet-stream", "main.cpp")).toBe("text");
    expect(previewKindFor("application/octet-stream", "config.yml")).toBe("text");
    expect(previewKindFor("application/x-python-code", "worker.py")).toBe("text");
    expect(previewKindFor("application/octet-stream", "archive.unknown")).toBe("binary");
    expect(binaryPreview(new Uint8Array([0x41, 0, 0xff]))).toContain("41 00 ff");
    expect(textPreview(new TextEncoder().encode("hello"))).toBe("hello");
  });
});
