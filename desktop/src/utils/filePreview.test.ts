import { describe, expect, it } from "vitest";
import { previewKindFor } from "./filePreview";

describe("previewKindFor", () => {
  it("recognizes desktop-safe preview formats", () => {
    expect(previewKindFor("application/pdf", "report.bin")).toBe("pdf");
    expect(previewKindFor("application/octet-stream", "report.pdf")).toBe("pdf");
    expect(previewKindFor("image/png", "photo.png")).toBe("image");
    expect(previewKindFor("application/json", "data.bin")).toBe("text");
    expect(previewKindFor("video/mp4", "clip.mp4")).toBe("video");
  });

  it("does not render active SVG content", () => {
    expect(previewKindFor("image/svg+xml", "logo.svg")).toBe("unsupported");
  });
});
