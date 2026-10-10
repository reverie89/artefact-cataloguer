import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useCallback, useLayoutEffect, useReducer, useRef } from "react";

import { composeExportTable, computeColumnWidths, csvSafeCell, parsePreFlightError, useActions, type AppActions } from "./actions";
import { _DEF } from "./defaults";
import { initialState, reducer, type Action, type AppState } from "./state";
import type { AiResults, ArtefactRow, FieldSelection, Settings, VocabEmbeddingStatus } from "./types";
import { CANCEL_ERROR, catalogueArtefact, cancelCatalogue } from "../lib/ai";

// The queue tests below drive useActions (the catalogue drainer) with the AI
// transport mocked at the lib/ai boundary; everything else stays the real
// module, including parsePreFlightError.
vi.mock("../lib/ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  catalogueArtefact: vi.fn(),
  cancelCatalogue: vi.fn(async () => {}),
}));

describe("csvSafeCell", () => {
  // OWASP CSV-formula-injection neutralization: a value whose first char is one
  // of the formula triggers gets a `'` prefix (Excel/LibreOffice/Sheets drop
  // the leading quote on display, treating the cell as text).
  const triggers = ["=", "+", "-", "@", "\t", "\r"];
  for (const trigger of triggers) {
    it(`prefixes a value starting with ${JSON.stringify(trigger)} with a single quote`, () => {
      const malicious = `${trigger}HYPERLINK("https://evil","click")`;
      const safe = csvSafeCell(malicious);
      expect(safe.startsWith("'")).toBe(true);
      // The payload is preserved verbatim after the quote (no content loss).
      expect(safe.slice(1)).toBe(malicious);
    });
  }

  it("prefixes the classic =cmd DDE payload", () => {
    expect(csvSafeCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
  });

  it("leaves normal values unchanged", () => {
    expect(csvSafeCell("bronze")).toBe("bronze");
    expect(csvSafeCell("Tang dynasty, 8th c. CE")).toBe("Tang dynasty, 8th c. CE");
    expect(csvSafeCell("a value with = inside")).toBe("a value with = inside");
    expect(csvSafeCell("plain text")).toBe("plain text");
  });

  it("does not prefix a value whose only special char is mid-string", () => {
    // Only a leading trigger is dangerous; mid-string `=`/`+`/`-`/`@` are inert.
    expect(csvSafeCell("price = 5")).toBe("price = 5");
    expect(csvSafeCell("a+b")).toBe("a+b");
    expect(csvSafeCell("a-b")).toBe("a-b");
    expect(csvSafeCell("name@example.com")).toBe("name@example.com");
  });

  it("handles empty and single-char strings", () => {
    expect(csvSafeCell("")).toBe("");
    expect(csvSafeCell("=")).toBe("'=");
    expect(csvSafeCell("a")).toBe("a");
  });
});

describe("computeColumnWidths", () => {
  it("widens a column to its longest cell, padded", () => {
    const widths = computeColumnWidths(["Place"], [["Borobudur"], ["Prambanan"]]);
    expect(widths).toEqual([11]); // "Prambanan" is 9 chars, +2 padding, min 10 not binding
  });

  it("clamps short columns to the minimum", () => {
    expect(computeColumnWidths(["A", "Place"], [["x", "Java"]])).toEqual([10, 10]);
  });

  it("caps long values at the max so text wraps instead of stretching", () => {
    const long = "x".repeat(300);
    expect(computeColumnWidths(["Physical Description"], [[long]])).toEqual([45]);
  });

  it("sizes from the header when values are shorter", () => {
    expect(computeColumnWidths(["Date/Period"], [["1900"]])).toEqual([13]); // 11-char header + 2 padding
  });

  it("handles empty tables", () => {
    expect(computeColumnWidths(["A", "B"], [])).toEqual([10, 10]);
  });
});

describe("composeExportTable", () => {
  // Build a minimal settings with one AF column (Material) and one catalogue
  // field (Place) so each test can flip flags and assert ordering without a
  // wall of fixture setup.
  function buildSettings(opts: { materialExport?: boolean; imageExport?: boolean } = {}): Settings {
    const s = _DEF();
    s.artefactFields = [
      { id: "af-m", name: "Material", description: "", prompt: "", includeForAI: true, includeInExport: opts.materialExport ?? true, useColumnLetter: false, column: "" },
      { id: "af-i", name: "Image", description: "", prompt: "", includeForAI: true, includeInExport: opts.imageExport ?? true, useColumnLetter: false, column: "" },
    ];
    s.fields = [{ id: "fp", name: "Place", type: "open", layout: "row", prompt: "", vocabSources: [], maxComponents: 1 }];
    return s;
  }
  const rows: ArtefactRow[] = [
    { uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "done", record: { Material: "bronze", Place: "ignored-in-record" } },
    { uid: "u2", fileId: "f1", sourceName: "a.xlsx", status: "done", record: { material: "Ceramic" } }, // different casing key
    { uid: "u3", fileId: "f1", sourceName: "a.xlsx", status: "queued", record: { Material: "gold" } }, // not done — excluded
  ];
  const aiResults: AiResults = {
    u1: { Place: [{ value: "Java" }] },
    u2: { Place: [{ value: "Bali" }] },
  };
  const fieldSelections: Record<string, FieldSelection> = {
    u1_fp: { source: "manual", value: "Jakarta", values: ["Jakarta"], listName: "", similarity: null },
  };

  it("returns null when zero AF columns are selected for export", () => {
    const table = composeExportTable(buildSettings({ materialExport: false, imageExport: false }), rows, aiResults, fieldSelections);
    expect(table).toBeNull();
  });

  it("emits AF columns before catalogue fields, in configured order", () => {
    const table = composeExportTable(buildSettings(), rows, aiResults, fieldSelections);
    expect(table).not.toBeNull();
    expect(table!.headers).toEqual(["Material", "Image", "Place"]);
  });

  it("reads AF values from the record with case-insensitive header lookup", () => {
    const table = composeExportTable(buildSettings(), rows, aiResults, fieldSelections)!;
    // Row u2's record key is lowercase "material"; it still resolves.
    expect(table.rows[0]).toEqual(["bronze", "", "Jakarta"]);
    expect(table.rows[1]).toEqual(["Ceramic", "", "Bali"]);
  });

  it("matches record keys with collapsed whitespace (wrapped multiline headers)", () => {
    const s = buildSettings();
    s.artefactFields = [...(s.artefactFields || []), { id: "af-n", name: "Curator's Note", description: "", prompt: "", includeForAI: true, includeInExport: true, useColumnLetter: false, column: "" }];
    const wrapped: ArtefactRow[] = [
      { uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "done", record: { "Curator's\nNote": "ivory inlay" } },
    ];
    const table = composeExportTable(s, wrapped, {}, {})!;
    // Record key is the sheet's wrapped header; the configured name is
    // single-line. normalizeHeader matching (the parser's) resolves it.
    // headers = [Material, Image, Curator's Note, Place].
    expect(table.rows[0]).toEqual(["", "", "ivory inlay", ""]);
  });

  it("excludes only the AF columns toggled off (opt-out)", () => {
    const table = composeExportTable(buildSettings({ materialExport: false }), rows, aiResults, fieldSelections)!;
    expect(table.headers).toEqual(["Image", "Place"]);
    expect(table.rows[0]).toEqual(["", "Jakarta"]);
  });

  it("skips rows that are not done", () => {
    const table = composeExportTable(buildSettings(), rows, aiResults, fieldSelections)!;
    expect(table.rows).toHaveLength(2); // u3 (queued) excluded
  });

  it("identifies the image column by name for byte-embedding downstream", () => {
    expect(composeExportTable(buildSettings(), rows, aiResults, fieldSelections)!.imageColName).toBe("Image");
    expect(composeExportTable(buildSettings({ imageExport: false }), rows, aiResults, fieldSelections)!.imageColName).toBeNull();
  });

  it("falls back to empty string when a record value or AI suggestion is missing", () => {
    const sparseRows: ArtefactRow[] = [{ uid: "ux", fileId: "f1", sourceName: "a.xlsx", status: "done", record: {} }];
    const table = composeExportTable(buildSettings(), sparseRows, {}, {})!;
    expect(table.rows[0]).toEqual(["", "", ""]);
  });
});

describe("parsePreFlightError", () => {
  // Base passes every check (active provider, no vocab fields) so each test
  // adds exactly one failing ingredient.
  function buildSettings(): Settings {
    const s = _DEF();
    s.providers = [{ id: "p1", name: "Prov", baseUrl: "https://a", apiKey: "k", model: "m" }];
    s.activeProvider = "p1";
    s.fields = [];
    return s;
  }
  const syncedEmbedding: VocabEmbeddingStatus = { status: "synced", providerId: "e1", model: "m", lastSyncedAt: "2026-10-09", rowsEmbedded: 3, lastError: null };
  const vocabField = { id: "f1", name: "Material", type: "vocab" as const, layout: "row" as const, prompt: "", vocabSources: ["s1"], maxComponents: 1 };
  const vocabSource = (embedding: VocabEmbeddingStatus) => ({
    id: "s1", name: "AAT", files: [], fields: [], ingestionField: null, labelField: null, badgeField: null, embedding,
  });

  it("requires an active provider at all", () => {
    const s = buildSettings();
    s.activeProvider = null;
    expect(parsePreFlightError(s)).toMatch(/active AI provider is required/);
  });

  it("requires the active provider to still exist in the list", () => {
    const s = buildSettings();
    s.providers = [];
    expect(parsePreFlightError(s)).toMatch(/active AI provider is required/);
  });

  it("rejects a vocab field whose source has no synced embedding", () => {
    const s = buildSettings();
    s.fields = [vocabField];
    s.vocabSources = [vocabSource({ status: "never", providerId: null, model: null, lastSyncedAt: null, rowsEmbedded: null, lastError: null })];
    const err = parsePreFlightError(s);
    expect(err).toMatch(/not yet embedded/);
    expect(err).toContain("Material");
    expect(err).toContain("AAT");
  });

  it("rejects vocab fields when no embedding provider is active", () => {
    const s = buildSettings();
    s.fields = [vocabField];
    s.vocabSources = [vocabSource(syncedEmbedding)];
    // embeddingProviders stays empty (no active embedding provider).
    const err = parsePreFlightError(s);
    expect(err).toMatch(/embedding provider/);
    expect(err).toContain("Material");
  });

  it("passes with no vocab fields and an active provider", () => {
    expect(parsePreFlightError(buildSettings())).toBeNull();
  });

  it("passes when vocab sources are synced and an embedding provider is active", () => {
    const s = buildSettings();
    s.fields = [vocabField];
    s.vocabSources = [vocabSource(syncedEmbedding)];
    s.embeddingProviders = [{ id: "e1", name: "Emb", baseUrl: "https://b", apiKey: "k", model: "m" }];
    s.activeEmbeddingProvider = "e1";
    expect(parsePreFlightError(s)).toBeNull();
  });
});

// ─── Queue sequencing (startQueue / stopQueue / retry) ─────────────────────
// The drainer, its stop path and Retry's auto-restart live in the useActions
// hook. These tests drive the hook through App's exact wiring — reducer state
// plus a ref mirrored at commit — with catalogueArtefact/cancelCatalogue
// mocked, so Retry-after-stop behaves here as it does in the real app.

// catalogueArtefact's per-row return shape: field name → suggestions.
const FIXTURE_AI: Record<string, { value: string; similarity?: number }[]> = { Place: [{ value: "Java" }] };

// Passes parsePreFlightError: active provider, no vocab fields.
function queueSettings(): Settings {
  const s = _DEF();
  s.providers = [{ id: "p1", name: "Prov", baseUrl: "https://a", apiKey: "k", model: "m" }];
  s.activeProvider = "p1";
  s.fields = [];
  return s;
}

function queueRow(uid: string, status: ArtefactRow["status"]): ArtefactRow {
  return { uid, fileId: "f1", sourceName: "a.xlsx", status, record: { Material: "bronze" } };
}

interface Harness {
  state: AppState;
  actions: AppActions;
  dispatched: { current: Action[] };
}

// Mirrors App.tsx's wiring: reducer state, a ref mirrored in a layout effect
// (so getState() sees committed state after one microtask), the drainer
// reading that ref as its live scan.
function useHarness(seed: { rows: ArtefactRow[]; settings: Settings }): Harness {
  const [state, dispatch] = useReducer(reducer, seed, (s) => ({ ...initialState, results: s.rows, settings: s.settings }));
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  const dispatched = useRef<Action[]>([]);
  const dispatchSpy = useCallback((a: Action) => {
    dispatched.current.push(a);
    dispatch(a);
  }, [dispatch]);
  const actions = useActions(
    state,
    dispatchSpy,
    { schedule: () => {}, flush: () => Promise.resolve() },
    async () => true,
    () => stateRef.current
  );
  return { state, actions, dispatched };
}

describe("queue sequencing (useActions)", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.mocked(catalogueArtefact).mockReset();
    vi.mocked(catalogueArtefact).mockResolvedValue(FIXTURE_AI);
    vi.mocked(cancelCatalogue).mockReset();
    vi.mocked(cancelCatalogue).mockResolvedValue(undefined);
  });

  const runningFlags = (h: Harness): boolean[] =>
    h.dispatched.current.filter((a) => a.type === "SET_QUEUE_RUNNING").map((a) => a.running);

  it("Retry on a stopped queue requeues the failed rows and restarts", async () => {
    const h = renderHook(() => useHarness({ rows: [queueRow("u1", "error"), queueRow("u2", "cancelled")], settings: queueSettings() }));
    act(() => {
      h.result.current.actions.retryFailed();
    });
    await waitFor(() => expect(h.result.current.state.results.map((r) => r.status)).toEqual(["done", "done"]), { timeout: 3000 });
    await waitFor(() => expect(h.result.current.state.queueRunning).toBe(false), { timeout: 3000 });
    expect(vi.mocked(catalogueArtefact)).toHaveBeenCalledTimes(2);
    expect(runningFlags(h.result.current)).toEqual([true, false]);
  });

  it("per-row Retry on a stopped queue restarts it", async () => {
    const h = renderHook(() => useHarness({ rows: [queueRow("u1", "cancelled")], settings: queueSettings() }));
    act(() => {
      h.result.current.actions.requeueRow("u1");
    });
    await waitFor(() => expect(h.result.current.state.results[0].status).toBe("done"), { timeout: 3000 });
    await waitFor(() => expect(h.result.current.state.queueRunning).toBe(false), { timeout: 3000 });
    expect(vi.mocked(catalogueArtefact)).toHaveBeenCalledTimes(1);
    expect(runningFlags(h.result.current)).toEqual([true, false]);
  });

  it("Retry while the queue is running starts no second drainer", async () => {
    let release!: () => void;
    vi.mocked(catalogueArtefact).mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(FIXTURE_AI); }));
    const h = renderHook(() => useHarness({ rows: [queueRow("u1", "queued"), queueRow("u2", "error")], settings: queueSettings() }));
    act(() => {
      void h.result.current.actions.startQueue();
    });
    await waitFor(() => expect(h.result.current.state.results[0].status).toBe("processing"));
    act(() => {
      h.result.current.actions.retryFailed();
    });
    release();
    await waitFor(() => expect(h.result.current.state.results.map((r) => r.status)).toEqual(["done", "done"]), { timeout: 3000 });
    await waitFor(() => expect(h.result.current.state.queueRunning).toBe(false), { timeout: 3000 });
    expect(vi.mocked(catalogueArtefact)).toHaveBeenCalledTimes(2);
    expect(runningFlags(h.result.current)).toEqual([true, false]);
  });

  it("Stop flips queueRunning false without the inter-row pause", async () => {
    let rejectRow!: (e: Error) => void;
    vi.mocked(catalogueArtefact).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRow = reject; }));
    const h = renderHook(() => useHarness({ rows: [queueRow("u1", "queued"), queueRow("u2", "queued")], settings: queueSettings() }));
    act(() => {
      void h.result.current.actions.startQueue();
    });
    await waitFor(() => expect(h.result.current.state.results[0].status).toBe("processing"));
    await act(async () => {
      await h.result.current.actions.stopQueue();
    });
    rejectRow(new Error(CANCEL_ERROR));
    // The flip must land before the 300 ms inter-row pause would elapse —
    // that tail delay is exactly what this guards against reintroducing.
    await waitFor(() => expect(h.result.current.state.queueRunning).toBe(false), { timeout: 250 });
    expect(h.result.current.state.results.map((r) => r.status)).toEqual(["cancelled", "queued"]);
  });
});
