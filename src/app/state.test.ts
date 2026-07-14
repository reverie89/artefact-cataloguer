import { describe, expect, it } from "vitest";

import { initialState, providerDraftFromSettings, reducer } from "./state";
import type { Settings } from "./types";

describe("reducer TOGGLE_FIELD_VALUE", () => {
  it("builds up a multi-select and joins values with ' | ' for display/export", () => {
    let s = reducer(initialState, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "clay", source: "vocab", listName: "Materials", confidence: null });
    expect(s.fieldSelections.u1_material).toEqual({ source: "vocab", value: "clay", values: ["clay"], listName: "Materials", confidence: null });

    s = reducer(s, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "glaze", source: "vocab", listName: "Materials", confidence: null });
    expect(s.fieldSelections.u1_material).toEqual({ source: "multi", value: "clay | glaze", values: ["clay", "glaze"], listName: "", confidence: null });
  });

  it("toggling an already-selected value removes it, falling back to a single selection", () => {
    let s = reducer(initialState, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "clay", source: "vocab", listName: "Materials", confidence: null });
    s = reducer(s, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "glaze", source: "vocab", listName: "Materials", confidence: null });

    s = reducer(s, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "clay", source: "vocab", listName: "Materials", confidence: null });
    expect(s.fieldSelections.u1_material).toEqual({ source: "vocab", value: "glaze", values: ["glaze"], listName: "Materials", confidence: null });
  });

  it("removing the last remaining value clears the field selection entirely", () => {
    let s = reducer(initialState, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "clay", source: "vocab", listName: "Materials", confidence: null });
    s = reducer(s, { type: "TOGGLE_FIELD_VALUE", key: "u1_material", value: "clay", source: "vocab", listName: "Materials", confidence: null });

    expect(s.fieldSelections.u1_material).toBeUndefined();
  });
});

describe("reducer", () => {
  it("updates the active settings tab", () => {
    const next = reducer(initialState, { type: "SET_TAB", tab: "ai" });

    expect(next.settingsTab).toBe("ai");
    expect(next).not.toBe(initialState);
  });

  it("clears parse-specific state when files change", () => {
    const populated = {
      ...initialState,
      parseStatus: "completed" as const,
      results: [{ uid: "u1", id: "A1", title: "Cup", category: "Ceramics", status: "done" as const, record: {} }],
      aiResults: { u1: { material: [{ value: "clay", confidence: 0.8 }] } },
      expandedRows: { u1: true },
    };

    const next = reducer(populated, { type: "SET_FILES", files: [] });

    expect(next.parseStatus).toBe("idle");
    expect(next.results).toEqual([]);
    expect(next.aiResults).toEqual({});
    expect(next.expandedRows).toEqual({});
  });

  it("clears the whole upload + parse lifecycle on RESET_UPLOAD", () => {
    const populated: typeof initialState = {
      ...initialState,
      files: [{ id: "f1", name: "a.xlsx", size: 10, sizeLabel: "10 B", status: "valid", errors: [] }],
      parseStatus: "completed",
      results: [{ uid: "u1", id: "A1", title: "Cup", category: "Ceramics", status: "done" as const, record: {} }],
      aiResults: { u1: { material: [{ value: "clay", confidence: 0.8 }] } },
      expandedRows: { u1: true },
      fieldSelections: { u1_material: { source: "ai", value: "clay", values: ["clay"], listName: "AI", confidence: 0.8 } },
      fieldDropdownOpen: { u1_material: true },
      fieldDropdownSearch: { u1_material: "cl" },
      resultsFilter: "done",
      resultsSearch: "cup",
      validationErrors: [{ message: "Missing column: Obj. Number" }],
      parseError: "AI provider missing",
    };

    const next = reducer(populated, { type: "RESET_UPLOAD" });

    expect(next.files).toEqual([]);
    expect(next.uploadDragOver).toBe(false);
    expect(next.parseStatus).toBe("idle");
    expect(next.results).toEqual([]);
    expect(next.aiResults).toEqual({});
    expect(next.expandedRows).toEqual({});
    expect(next.fieldSelections).toEqual({});
    expect(next.fieldDropdownOpen).toEqual({});
    expect(next.fieldDropdownSearch).toEqual({});
    expect(next.resultsFilter).toBe("all");
    expect(next.resultsSearch).toBe("");
    expect(next.validationErrors).toEqual([]);
    expect(next.parseError).toBeNull();
    // Settings and unrelated UI state are left untouched.
    expect(next.settings).toBe(populated.settings);
  });

  it("transitions the run lifecycle via SET_PARSE_STATUS", () => {
    // idle → running → paused → running → completed mirrors a normal run plus a
    // pause/resume. parseStatus is the only field touched; everything else
    // (results, parseError, settings) is left as-is.
    let next = reducer(initialState, { type: "SET_PARSE_STATUS", status: "running" });
    expect(next.parseStatus).toBe("running");
    next = reducer(next, { type: "SET_PARSE_STATUS", status: "paused" });
    expect(next.parseStatus).toBe("paused");
    next = reducer(next, { type: "SET_PARSE_STATUS", status: "cancelled" });
    expect(next.parseStatus).toBe("cancelled");
    next = reducer(next, { type: "SET_PARSE_STATUS", status: "completed" });
    expect(next.parseStatus).toBe("completed");
  });

  it("appends a catalogue field to the draft via PATCH_FIELD_DRAFT", () => {
    const base = reducer(initialState, { type: "INIT", settings: initialState.settings, darkMode: true, zoom: 1 });
    const before = base.fieldDraft?.fields.length ?? base.settings.fields.length;
    const next = reducer(base, {
      type: "PATCH_FIELD_DRAFT",
      patch: (d) => ({ ...d, fields: [...d.fields, { id: "x", name: "Material", type: "open", layout: "row", prompt: "", vocabSources: [] }] }),
    });
    expect(next.fieldDraft).not.toBeNull();
    expect(next.fieldDraft!.fields.length).toBe(before + 1);
    expect(next.fieldDraft!.fields[before].name).toBe("Material");
  });

  it("appends a required column to the draft via PATCH_ARTEFACT_DRAFT", () => {
    const base = reducer(initialState, { type: "INIT", settings: initialState.settings, darkMode: true, zoom: 1 });
    const before = base.artefactDraft?.artefactFields.length ?? base.settings.artefactFields.length;
    const next = reducer(base, {
      type: "PATCH_ARTEFACT_DRAFT",
      patch: (d) => ({ ...d, artefactFields: [...d.artefactFields, { id: "y", name: "Obj. Number", required: false, description: "" }] }),
    });
    expect(next.artefactDraft).not.toBeNull();
    expect(next.artefactDraft!.artefactFields.length).toBe(before + 1);
    expect(next.artefactDraft!.artefactFields[before].required).toBe(false);
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
      parseStatus: "completed",
      results: [
        { uid: "u1", id: "", title: "Cup", category: "Ceramics", status: "done" as const, record: {} },
        { uid: "u2", id: "", title: "Bowl", category: "Ceramics", status: "done" as const, record: {} },
      ],
    };

    let next = reducer(populated, { type: "SET_ROW_IMAGE", uid: "u1", imagePath: "/img/cup.png" });
    next = reducer(next, { type: "SET_ROW_IMAGE", uid: "u2", imagePath: "/img/bowl.png" });

    expect(next.results[0].imagePath).toBe("/img/cup.png");
    expect(next.results[1].imagePath).toBe("/img/bowl.png");
  });
});
