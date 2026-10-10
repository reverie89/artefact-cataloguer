import { describe, expect, it } from "vitest";

import { initialState, providerDraftFromSettings, reducer } from "./state";
import type { CatalogueField, Settings } from "./types";

describe("reducer TOGGLE_FIELD_VALUE (multi-component fields)", () => {
  it("builds up a multi-select and joins values with ' | ' for display/export", () => {
    let s = reducer(initialState, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "clay", source: "vocab", listName: "Materials", similarity: null, multi: true });
    expect(s.fieldSelections.u1_material).toEqual({ source: "vocab", value: "clay", values: ["clay"], listName: "Materials", similarity: null });

    s = reducer(s, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "glaze", source: "vocab", listName: "Materials", similarity: null, multi: true });
    expect(s.fieldSelections.u1_material).toEqual({ source: "multi", value: "clay | glaze", values: ["clay", "glaze"], listName: "", similarity: null });
  });

  it("toggling an already-selected value removes it, falling back to a single selection", () => {
    let s = reducer(initialState, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "clay", source: "vocab", listName: "Materials", similarity: null, multi: true });
    s = reducer(s, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "glaze", source: "vocab", listName: "Materials", similarity: null, multi: true });

    s = reducer(s, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "clay", source: "vocab", listName: "Materials", similarity: null, multi: true });
    expect(s.fieldSelections.u1_material).toEqual({ source: "vocab", value: "glaze", values: ["glaze"], listName: "Materials", similarity: null });
  });

  it("removing the last remaining value clears the field selection entirely", () => {
    let s = reducer(initialState, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "clay", source: "vocab", listName: "Materials", similarity: null, multi: true });
    s = reducer(s, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "clay", source: "vocab", listName: "Materials", similarity: null, multi: true });

    expect(s.fieldSelections.u1_material).toBeUndefined();
  });
});

describe("reducer TOGGLE_FIELD_VALUE (single-pick fields)", () => {
  it("replaces the selection with the picked term and closes the dropdown", () => {
    const open: typeof initialState = { ...initialState, fieldDropdownOpen: { u1_material: true } };
    let s = reducer(open, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "clay", source: "vocab", listName: "Materials", similarity: null, multi: false });
    expect(s.fieldSelections.u1_material).toEqual({ source: "vocab", value: "clay", values: ["clay"], listName: "Materials", similarity: null });
    expect(s.fieldDropdownOpen).toEqual({});

    // A later pick replaces rather than accumulates; re-picking the same term
    // is an idempotent replace, not a deselect.
    s = reducer(s, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "iron", source: "ai", listName: "AI", similarity: 0.9, multi: false });
    expect(s.fieldSelections.u1_material).toEqual({ source: "ai", value: "iron", values: ["iron"], listName: "AI", similarity: 0.9 });
    s = reducer(s, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "iron", source: "ai", listName: "AI", similarity: 0.9, multi: false });
    expect(s.fieldSelections.u1_material?.values).toEqual(["iron"]);
  });
});

describe("reducer", () => {
  it("updates the active settings tab", () => {
    const next = reducer(initialState, { type: "SET_TAB", tab: "modelProviders" });

    expect(next.settingsTab).toBe("modelProviders");
    expect(next).not.toBe(initialState);
  });

  it("appends imported file chips without touching results", () => {
    const populated = {
      ...initialState,
      results: [{ uid: "u1", fileId: "f0", sourceName: "old.xlsx", status: "done" as const, record: { "Object Name": "Cup" } }],
    };

    const next = reducer(populated, {
      type: "SET_FILES",
      files: [{ id: "f1", name: "a.xlsx", size: 10, sizeLabel: "10 B", status: "validating" as const, errors: [] }],
    });

    expect(next.files.map((f) => f.id)).toEqual(["f1"]);
    expect(next.results).toBe(populated.results);
  });

  it("stores a file's validation verdict with per-file errors", () => {
    const populated = {
      ...initialState,
      files: [{ id: "f1", name: "a.xlsx", size: 10, sizeLabel: "10 B", status: "validating" as const, errors: [] }],
    };

    const errs = [{ message: "Missing required column: Obj. Number" }];
    const next = reducer(populated, { type: "SET_FILE_STATUS", id: "f1", status: "invalid", errors: errs });
    expect(next.files[0]).toMatchObject({ status: "invalid", errors: errs });
  });

  it("appends imported rows via PARSE_FILES, keeping earlier rows and selections", () => {
    const populated = {
      ...initialState,
      results: [{ uid: "u1", fileId: "f0", sourceName: "old.xlsx", status: "done" as const, record: {} }],
      fieldSelections: { u1_m1: { source: "ai" as const, value: "clay", values: ["clay"], listName: "AI", similarity: 0.8 } },
    };

    const next = reducer(populated, {
      type: "PARSE_FILES",
      rows: [
        { uid: "u2", fileId: "f1", sourceName: "new.xlsx", status: "queued" as const, record: { "Object Name": "Bowl" } },
        { uid: "u3", fileId: "f1", sourceName: "new.xlsx", status: "queued" as const, record: {} },
      ],
    });

    expect(next.results.map((r) => r.uid)).toEqual(["u1", "u2", "u3"]);
    expect(next.fieldSelections.u1_m1).toBeDefined();
  });

  it("mirrors the queue drainer's liveness via SET_QUEUE_RUNNING", () => {
    let next = reducer(initialState, { type: "SET_QUEUE_RUNNING", running: true });
    expect(next.queueRunning).toBe(true);
    next = reducer(next, { type: "SET_QUEUE_RUNNING", running: false });
    expect(next.queueRunning).toBe(false);
  });

  it("appends a catalogue field to the draft via PATCH_FIELD_DRAFT", () => {
    const base = reducer(initialState, { type: "INIT", settings: initialState.settings, darkMode: true, zoom: 1 });
    const before = base.fieldDraft?.fields.length ?? base.settings.fields.length;
    const next = reducer(base, {
      type: "PATCH_FIELD_DRAFT",
      patch: (d) => ({ ...d, fields: [...d.fields, { id: "x", name: "Material", type: "open", layout: "row", prompt: "", vocabSources: [], maxComponents: 1 }] }),
    });
    expect(next.fieldDraft).not.toBeNull();
    expect(next.fieldDraft!.fields.length).toBe(before + 1);
    expect(next.fieldDraft!.fields[before].name).toBe("Material");
  });

  it("appends a column to the draft via PATCH_ARTEFACT_DRAFT", () => {
    const base = reducer(initialState, { type: "INIT", settings: initialState.settings, darkMode: true, zoom: 1 });
    const before = base.artefactDraft?.artefactFields.length ?? base.settings.artefactFields.length;
    const next = reducer(base, {
      type: "PATCH_ARTEFACT_DRAFT",
      patch: (d) => ({ ...d, artefactFields: [...d.artefactFields, { id: "y", name: "Obj. Number", description: "", prompt: "", includeForAI: true, includeInExport: true, useColumnLetter: false, column: "" }] }),
    });
    expect(next.artefactDraft).not.toBeNull();
    expect(next.artefactDraft!.artefactFields.length).toBe(before + 1);
    expect(next.artefactDraft!.artefactFields[before].name).toBe("Obj. Number");
  });

  it("seeds the artefact-analysis instruction into the artefact draft and lets it be patched", () => {
    const base = reducer(initialState, { type: "INIT", settings: initialState.settings, darkMode: true, zoom: 1 });
    // The draft is null until the first PATCH self-heals it from settings.
    expect(base.artefactDraft).toBeNull();
    const seeded = reducer(base, {
      type: "PATCH_ARTEFACT_DRAFT",
      patch: (d) => d, // no-op patch forces the self-heal
    });
    // Self-heal carries the artefact-analysis instruction from settings into the draft.
    expect(seeded.artefactDraft!.artefactAnalysisSystemPromptInstruction).toBe(initialState.settings.artefactAnalysisSystemPromptInstruction);
    const next = reducer(seeded, {
      type: "PATCH_ARTEFACT_DRAFT",
      patch: (d) => ({ ...d, artefactAnalysisSystemPromptInstruction: "edited artefact-analysis guidance" }),
    });
    expect(next.artefactDraft!.artefactAnalysisSystemPromptInstruction).toBe("edited artefact-analysis guidance");
  });

  it("seeds a provider's persisted connStatus into the draft (and defaults to untested)", () => {
    const settings: Settings = {
      ...initialState.settings,
      providers: [
        { id: "p1", name: "With status", baseUrl: "https://a", apiKey: "k", model: "m", connStatus: "ok" },
        { id: "p2", name: "No status", baseUrl: "https://b", apiKey: "k", model: "m" },
      ],
      activeProvider: "p1",
    };
    const draft = providerDraftFromSettings(settings);
    expect(draft.providers[0].connStatus).toBe("ok");
    // A provider saved before the field existed defaults to "untested" so the
    // Status column renders "Not tested" instead of crashing or showing stale ok.
    expect(draft.providers[1].connStatus).toBe("untested");
  });

  it("records a Test Connection outcome onto the draft entry via PATCH_PROVIDER_DRAFT", () => {
    const settings: Settings = {
      ...initialState.settings,
      providers: [{ id: "p1", name: "Prov", baseUrl: "https://a", apiKey: "k", model: "m" }],
      activeProvider: "p1",
    };
    const base = reducer(initialState, { type: "INIT", settings, darkMode: true, zoom: 1 });
    // Mirror what testConn does: write the outcome + modelOptions onto the entry.
    const next = reducer(base, {
      type: "PATCH_PROVIDER_DRAFT",
      patch: (d) => ({
        ...d,
        providers: d.providers.map((e) => (e.id === "p1" ? { ...e, modelOptions: ["m", "m2"], connStatus: "ok" } : e)),
      }),
    });
    expect(next.providerDraft!.providers[0].connStatus).toBe("ok");
    expect(next.providerDraft!.providers[0].modelOptions).toEqual(["m", "m2"]);
  });

  it("keeps SET_PROV_STATUS transient and separate from the persisted draft", () => {
    const settings: Settings = {
      ...initialState.settings,
      providers: [{ id: "p1", name: "Prov", baseUrl: "https://a", apiKey: "k", model: "m", connStatus: "ok" }],
      activeProvider: "p1",
    };
    const base = reducer(initialState, { type: "INIT", settings, darkMode: true, zoom: 1 });
    // A live "testing" state lands in the transient map, not the draft entry.
    const next = reducer(base, { type: "SET_PROV_STATUS", id: "p1", test: "testing" });
    expect(next.provStatus["p1"]).toEqual({ test: "testing" });
    // The draft entry's persisted connStatus is untouched by the transient flag.
    expect(next.settings.providers[0].connStatus).toBe("ok");
  });

  it("clears a row's transient status on CLEAR_PROV_STATUS", () => {
    const testing = reducer(initialState, { type: "SET_PROV_STATUS", id: "p1", test: "testing" });
    expect(testing.provStatus["p1"]).toEqual({ test: "testing" });
    const cleared = reducer(testing, { type: "CLEAR_PROV_STATUS", id: "p1" });
    expect(cleared.provStatus["p1"]).toBeUndefined();
  });

  it("attributes images per-row by uid, not id (empty/dup id no longer collides)", () => {
    // Two rows whose Accession No (id) is empty — the exact case that made
    // every row show the last image. They differ only by their uid.
    const populated: typeof initialState = {
      ...initialState,
      results: [
        { uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "done" as const, record: { "Object Name": "Cup" } },
        { uid: "u2", fileId: "f1", sourceName: "a.xlsx", status: "done" as const, record: { "Object Name": "Bowl" } },
      ],
    };

    let next = reducer(populated, { type: "SET_ROW_IMAGE", uid: "u1", imagePath: "/img/cup.png" });
    next = reducer(next, { type: "SET_ROW_IMAGE", uid: "u2", imagePath: "/img/bowl.png" });

    expect(next.results[0].imagePath).toBe("/img/cup.png");
    expect(next.results[1].imagePath).toBe("/img/bowl.png");
  });
});

describe("reducer requeueing", () => {
  const base: typeof initialState = {
    ...initialState,
    results: [
      { uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "done" as const, record: {} },
      { uid: "u2", fileId: "f1", sourceName: "a.xlsx", status: "error" as const, record: {} },
      { uid: "u3", fileId: "f1", sourceName: "a.xlsx", status: "cancelled" as const, record: {} },
      { uid: "u4", fileId: "f1", sourceName: "a.xlsx", status: "queued" as const, record: {} },
      { uid: "u5", fileId: "f1", sourceName: "a.xlsx", status: "processing" as const, record: {} },
    ],
  };
  const statuses = (s: typeof base) => s.results.map((r) => r.status);

  it("REQUEUE_ROWS flips terminal rows to queued in one pass", () => {
    // Done rows only ever arrive here from an explicit single-row requeue
    // (re-run); Retry-failed never collects them. Already-queued rows stay
    // queued; an in-flight row is untouched (its owner owns that status).
    const next = reducer(base, { type: "REQUEUE_ROWS", uids: ["u1", "u2", "u3", "u4", "nope"] });
    expect(statuses(next)).toEqual(["queued", "queued", "queued", "queued", "processing"]);
  });
});

describe("reducer row removal", () => {
  it("REMOVE_ROWS drops the rows and every per-row map entry (bare uid and ${uid}_ keys)", () => {
    const populated: typeof initialState = {
      ...initialState,
      results: [
        { uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "done" as const, record: {} },
        { uid: "u2", fileId: "f2", sourceName: "b.xlsx", status: "queued" as const, record: {} },
      ],
      aiResults: { u1: { material: [{ value: "clay", similarity: 0.8 }] }, u2: { material: [{ value: "stone" }] } },
      expandedRows: { u1: true, u2: true },
      fieldSelections: {
        u1_m1: { source: "ai", value: "clay", values: ["clay"], listName: "AI", similarity: 0.8 },
        u2_m1: { source: "ai", value: "stone", values: ["stone"], listName: "AI", similarity: 0.7 },
      },
      fieldDropdownOpen: { u1_m1: true, u2_m1: true },
      fieldDropdownSearch: { u1_m1: "cl", u2_m1: "st" },
    };

    const next = reducer(populated, { type: "REMOVE_ROWS", uids: ["u1"] });

    expect(next.results.map((r) => r.uid)).toEqual(["u2"]);
    expect(next.aiResults.u1).toBeUndefined();
    expect(next.aiResults.u2).toBeDefined();
    expect(next.expandedRows.u1).toBeUndefined();
    expect(next.fieldSelections.u1_m1).toBeUndefined();
    expect(next.fieldSelections.u2_m1).toBeDefined();
    expect(next.fieldDropdownOpen.u1_m1).toBeUndefined();
    expect(next.fieldDropdownSearch.u1_m1).toBeUndefined();
  });

  it("REMOVE_ROWS no-ops (same state) when no uid matches", () => {
    const populated: typeof initialState = {
      ...initialState,
      results: [{ uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "done" as const, record: {} }],
    };
    const next = reducer(populated, { type: "REMOVE_ROWS", uids: ["nope"] });
    expect(next).toBe(populated);
  });

  it("SET_ROW_STATUS ignores a row that was deleted mid-run", () => {
    const populated: typeof initialState = {
      ...initialState,
      results: [{ uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "processing" as const, record: {} }],
    };
    const next = reducer(populated, { type: "SET_ROW_STATUS", uid: "gone", status: "done", ai: { material: [{ value: "clay" }] } });
    expect(next).toBe(populated);
  });

  it("SET_ROW_STATUS seeds every returned suggestion — multi-component picks land as one multi selection", () => {
    const material: CatalogueField = { id: "m1", name: "Material", type: "vocab", layout: "row", prompt: "", vocabSources: [], maxComponents: 3 };
    const settings: Settings = { ...initialState.settings, fields: [material] };
    const populated: typeof initialState = {
      ...initialState,
      settings,
      results: [{ uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "processing" as const, record: {} }],
    };
    const next = reducer(populated, {
      type: "SET_ROW_STATUS",
      uid: "u1",
      status: "done",
      ai: { Material: [{ value: "iron chain", similarity: 0.9 }, { value: "mirror", similarity: 0.8 }] },
    });
    expect(next.fieldSelections.u1_m1).toEqual({
      source: "multi",
      value: "iron chain | mirror",
      values: ["iron chain", "mirror"],
      listName: "",
      similarity: null,
    });
  });

  it("SET_ROW_STATUS seeds the single top pick as before when one suggestion returns", () => {
    const material: CatalogueField = { id: "m1", name: "Material", type: "vocab", layout: "row", prompt: "", vocabSources: [], maxComponents: 1 };
    const settings: Settings = { ...initialState.settings, fields: [material] };
    const populated: typeof initialState = {
      ...initialState,
      settings,
      results: [{ uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "processing" as const, record: {} }],
    };
    const next = reducer(populated, {
      type: "SET_ROW_STATUS",
      uid: "u1",
      status: "done",
      ai: { Material: [{ value: "clay", similarity: 0.8 }] },
    });
    expect(next.fieldSelections.u1_m1).toEqual({ source: "ai", value: "clay", values: ["clay"], listName: "AI", similarity: 0.8 });
  });

  it("SET_ROW_STATUS records only the picked suggestion on a 1-component field — alternates are dropdown choices", () => {
    const material: CatalogueField = { id: "m1", name: "Material", type: "vocab", layout: "row", prompt: "", vocabSources: [], maxComponents: 1 };
    const settings: Settings = { ...initialState.settings, fields: [material] };
    const populated: typeof initialState = {
      ...initialState,
      settings,
      results: [{ uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "processing" as const, record: {} }],
    };
    const next = reducer(populated, {
      type: "SET_ROW_STATUS",
      uid: "u1",
      status: "done",
      ai: {
        Material: [
          { value: "wood (plant material)", similarity: 0.61, picked: true },
          { value: "rattan", similarity: 0.56, picked: false },
          { value: "hardwood", similarity: 0.52, picked: false },
        ],
      },
    });
    expect(next.fieldSelections.u1_m1).toEqual({ source: "ai", value: "wood (plant material)", values: ["wood (plant material)"], listName: "AI", similarity: 0.61 });
    // The alternates stay available as swap choices in the dropdown.
    expect(next.aiResults.u1.Material).toHaveLength(3);
  });

  it("SET_ROW_STATUS records only picked suggestions on a multi-component field — alternates never join the selection", () => {
    const material: CatalogueField = { id: "m1", name: "Material", type: "vocab", layout: "row", prompt: "", vocabSources: [], maxComponents: 3 };
    const settings: Settings = { ...initialState.settings, fields: [material] };
    const populated: typeof initialState = {
      ...initialState,
      settings,
      results: [{ uid: "u1", fileId: "f1", sourceName: "a.xlsx", status: "processing" as const, record: {} }],
    };
    const next = reducer(populated, {
      type: "SET_ROW_STATUS",
      uid: "u1",
      status: "done",
      ai: {
        Material: [
          { value: "wood (plant material)", similarity: 0.61, picked: true },
          { value: "rattan", similarity: 0.56, picked: true },
          { value: "oak (wood)", similarity: 0.51, picked: false },
        ],
      },
    });
    expect(next.fieldSelections.u1_m1).toEqual({
      source: "multi",
      value: "wood (plant material) | rattan",
      values: ["wood (plant material)", "rattan"],
      listName: "",
      similarity: null,
    });
  });
});

describe("reducer search column scope", () => {
  it("TOGGLE_SEARCH_COL_AF removes the last AF column (no 'keep at least one' guard)", () => {
    // Regression: previously the reducer silently no-op'd when the user
    // unselected the last column, forcing them to use Clear to empty the
    // scope. The per-item toggle must be symmetric with the Clear/All button.
    const base: typeof initialState = { ...initialState, searchColsAf: ["a1"] };
    const next = reducer(base, { type: "TOGGLE_SEARCH_COL_AF", id: "a1" });
    expect(next.searchColsAf).toEqual([]);
  });

  it("TOGGLE_SEARCH_COL_AF adds a missing id and removes a non-last present id", () => {
    let s: typeof initialState = { ...initialState, searchColsAf: ["a1"] };
    s = reducer(s, { type: "TOGGLE_SEARCH_COL_AF", id: "a2" });
    expect(s.searchColsAf).toEqual(["a1", "a2"]);
    s = reducer(s, { type: "TOGGLE_SEARCH_COL_AF", id: "a1" });
    expect(s.searchColsAf).toEqual(["a2"]);
  });

  it("TOGGLE_SEARCH_COL_CAT mirrors the AF behaviour for the catalogue scope", () => {
    let s: typeof initialState = { ...initialState, searchColsCat: ["c1"] };
    s = reducer(s, { type: "TOGGLE_SEARCH_COL_CAT", id: "c1" });
    expect(s.searchColsCat).toEqual([]);
    s = reducer(s, { type: "TOGGLE_SEARCH_COL_CAT", id: "c2" });
    expect(s.searchColsCat).toEqual(["c2"]);
  });

  it("SET_SEARCH_COLS_AF / SET_SEARCH_COLS_CAT accept an empty array", () => {
    let s: typeof initialState = { ...initialState, searchColsAf: ["a1"], searchColsCat: ["c1"] };
    s = reducer(s, { type: "SET_SEARCH_COLS_AF", ids: [] });
    s = reducer(s, { type: "SET_SEARCH_COLS_CAT", ids: [] });
    expect(s.searchColsAf).toEqual([]);
    expect(s.searchColsCat).toEqual([]);
  });
});

describe("reducer PATCH_SETTINGS search-column reconcile", () => {
  const field = (id: string, name: string) => ({ id, name, type: "open" as const, layout: "row" as const, prompt: "", vocabSources: [], maxComponents: 1 });

  it("auto-adds a newly-appended catalogue field to the search scope (searchable by default)", () => {
    // Per-card saves append columns through PATCH_SETTINGS — the scope must
    // pick them up the same way the load path does.
    const base = reducer(initialState, { type: "PATCH_SETTINGS", patch: (s) => ({ ...s, fields: [field("c1", "Material")] }) });
    expect(base.searchColsCat).toEqual(["c1"]);
    const added = reducer(base, { type: "PATCH_SETTINGS", patch: (s) => ({ ...s, fields: [...s.fields, field("c2", "Era")] }) });
    expect(added.searchColsCat).toEqual(["c1", "c2"]);
  });

  it("prunes a deleted catalogue field's id from the search scope", () => {
    const base = reducer(initialState, { type: "PATCH_SETTINGS", patch: (s) => ({ ...s, fields: [field("c1", "Material"), field("c2", "Era")] }) });
    const removed = reducer(base, { type: "PATCH_SETTINGS", patch: (s) => ({ ...s, fields: s.fields.filter((f) => f.id !== "c1") }) });
    expect(removed.searchColsCat).toEqual(["c2"]);
  });

  it("seeds every loaded column as searchable on INIT", () => {
    const next = reducer(initialState, {
      type: "INIT",
      settings: { ...initialState.settings, fields: [field("c1", "Material")], artefactFields: [{ id: "a1", name: "Obj. Number", description: "", prompt: "", includeForAI: true, includeInExport: true, useColumnLetter: false, column: "" }] },
      darkMode: true,
      zoom: 1,
    });
    expect(next.searchColsCat).toEqual(["c1"]);
    expect(next.searchColsAf).toEqual(["a1"]);
  });
});
