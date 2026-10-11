import { beforeEach, describe, expect, it, vi } from "vitest";

// saveState reaches the Rust bridge through invoke; mock the module so saver
// tests can inspect the persisted bundles without a Tauri runtime.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { invoke } from "@tauri-apps/api/core";
import { makeDebouncedSaver, migrateLegacyVisionPromptKey, parsePixelWidth } from "./store";
import type { Settings } from "../app/types";

/** Minimal bundle for the saver's getState() signature, tagged so tests can
 *  assert which settings generation reached the write. */
function bundleOf(tag: string) {
  return {
    settings: { tag } as unknown as Settings,
    darkMode: false,
    zoom: 1,
    sourceLabelW: 100,
    imagePaneW: 100,
  };
}

/** The `save_state` bundle from the most recent invoke call. */
function lastSavedBundle(): { ac_settings: { tag?: string }; ac_darkMode: string } {
  const calls = vi.mocked(invoke).mock.calls;
  const [, args] = calls[calls.length - 1] as [string, { bundle: { ac_settings: { tag?: string }; ac_darkMode: string } }];
  return args.bundle;
}

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

describe("makeDebouncedSaver", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  // Regression: patchNow dispatches and flushes in the same tick, before React
  // commits — a flush that read state at call time persisted the pre-patch
  // bundle while the UI reported success, and edits reverted on restart.
  it("flush() persists the state as of the write, not the snapshot at flush() time", async () => {
    let bundle = bundleOf("before");
    const saver = makeDebouncedSaver(() => bundle);
    const pending = saver.flush();
    bundle = bundleOf("after"); // the dispatch commits between call and write
    await pending;
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("save_state", expect.anything());
    expect(lastSavedBundle().ac_settings.tag).toBe("after");
  });

  it("schedule() coalesces rapid edits into one write after the debounce", async () => {
    vi.useFakeTimers();
    try {
      let bundle = bundleOf("v1");
      const saver = makeDebouncedSaver(() => bundle, 300);
      saver.schedule();
      bundle = bundleOf("v2");
      saver.schedule();
      await vi.advanceTimersByTimeAsync(299);
      expect(vi.mocked(invoke)).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
      expect(lastSavedBundle().ac_settings.tag).toBe("v2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush() rejects when the write fails, so card save status can show the error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full"));
    const saver = makeDebouncedSaver(() => bundleOf("x"));
    await expect(saver.flush()).rejects.toThrow("disk full");
  });
});
