import { describe, expect, it } from "vitest";

import { migrateLegacyVisionPromptKey, parsePixelWidth } from "./store";

describe("migrateLegacyVisionPromptKey", () => {
  it("renames the legacy prompt key, carrying the custom value across", () => {
    const out = migrateLegacyVisionPromptKey({
      visionSystemPromptInstruction: "custom persona",
      vocabNetCount: 20,
    }) as Record<string, unknown>;
    expect(out.artefactAnalysisSystemPromptInstruction).toBe("custom persona");
    expect(out.visionSystemPromptInstruction).toBeUndefined();
    expect(out.vocabNetCount).toBe(20);
  });

  it("is a no-op on current-format settings, fresh installs, and non-objects", () => {
    const current = { artefactAnalysisSystemPromptInstruction: "kept" };
    expect(migrateLegacyVisionPromptKey(current)).toBe(current);
    expect(migrateLegacyVisionPromptKey({})).toEqual({});
    expect(migrateLegacyVisionPromptKey(null)).toBeNull();
    expect(migrateLegacyVisionPromptKey("x")).toBe("x");
  });

  it("strips the legacy key when the current key is already present", () => {
    const out = migrateLegacyVisionPromptKey({
      artefactAnalysisSystemPromptInstruction: "current",
      visionSystemPromptInstruction: "stale",
    }) as Record<string, unknown>;
    expect(out.artefactAnalysisSystemPromptInstruction).toBe("current");
    expect(out.visionSystemPromptInstruction).toBeUndefined();
  });
});

describe("parsePixelWidth", () => {
  const min = 90;
  const max = 400;

  it("parses a valid value, clamped to the range", () => {
    expect(parsePixelWidth("260", 130, min, max)).toBe(260);
    expect(parsePixelWidth("5000", 130, min, max)).toBe(max);
    expect(parsePixelWidth("1", 130, min, max)).toBe(min);
  });

  it("falls back on garbage and missing values", () => {
    expect(parsePixelWidth(undefined, 130, min, max)).toBe(130);
    expect(parsePixelWidth("", 130, min, max)).toBe(130);
    expect(parsePixelWidth("wide", 130, min, max)).toBe(130);
  });
});
