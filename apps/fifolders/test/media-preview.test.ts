import { describe, expect, it } from "vitest";
import { guessMime, materialIcon, previewKind } from "../src/model.js";
import { canPreviewName } from "../src/links.js";

describe("audio/video preview", () => {
  for (const ext of ["opus", "mp3", "ogg", "wav", "m4a", "flac"]) {
    it(`${ext} previews as audio`, () => {
      const mime = guessMime(`song.${ext}`, "");
      expect(previewKind(mime, new Uint8Array(1024 * 1024))).toBe("audio");
      expect(materialIcon({ type: "file", name: `song.${ext}`, mime: "" } as any)).toBe("audio_file");
      expect(canPreviewName(`song.${ext}`, "bafy")).toBe(true);
    });
  }
  for (const ext of ["mp4", "webm"]) it(`${ext} previews as video`, () => expect(previewKind(guessMime(`clip.${ext}`), new Uint8Array(1))).toBe("video"));
});
