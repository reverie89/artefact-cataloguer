import { describe, expect, it } from "vitest";

import type { StagedVocabFile } from "../lib/vocab";
import type { Settings, VocabSource } from "./types";
import {
  embeddingModelStale,
  emptyEmbedding,
  markStaleIfSynced,
  newVocabSource,
  sourceWithAddedFiles,
  sourceWithRemovedFile,
  syncInputsChanged,
  updateVocabSource,
  withoutVocabSource,
  withReorderedVocabSources,
} from "./vocabSettings";

function source(partial: Partial<VocabSource> = {}): VocabSource {
  return { id: "s", name: "", files: [], fields: [], ingestionField: null, labelField: null, badgeField: null, embedding: emptyEmbedding(), ...partial };
}

function settings(vocabSources: VocabSource[]): Settings {
  return {
    artefactAnalysisSystemPromptInstruction: "",
    vocabNetCount: 20,
    vocabShortlistCount: 3,
    validationEnabled: false,
    fields: [],
    vocabSources,
    providers: [],
    activeProvider: null,
    embeddingProviders: [],
    activeEmbeddingProvider: null,
    artefactFields: [],
  };
}

function staged(id: string, detectedFields: string[]): StagedVocabFile {
  return { id, filename: `${id}.xlsx`, addedDate: "2026-08-27", sizeBytes: 1024, detectedFields, rowCount: 7 };
}

describe("markStaleIfSynced", () => {
  it("flips only a synced index to stale, keeping its metadata", () => {
    const e = { ...emptyEmbedding(), status: "synced" as const, model: "bge-m3", rowsEmbedded: 42 };
    expect(markStaleIfSynced(e)).toEqual({ ...e, status: "stale" });
  });

  it("leaves every other status untouched", () => {
    for (const status of ["never", "stale", "syncing", "error"] as const) {
      const e = { ...emptyEmbedding(), status };
      expect(markStaleIfSynced(e)).toBe(e);
    }
  });
});

describe("embeddingModelStale", () => {
  it("is true when a synced index was embedded with another model", () => {
    const e = { ...emptyEmbedding(), status: "synced" as const, model: "old-model" };
    expect(embeddingModelStale(e, "new-model")).toBe(true);
  });

  it("is false when the model matches, is unknown, or none is active", () => {
    const e = { ...emptyEmbedding(), status: "synced" as const, model: "m" };
    expect(embeddingModelStale(e, "m")).toBe(false);
    expect(embeddingModelStale({ ...e, model: null }, "m")).toBe(false);
    expect(embeddingModelStale(e, null)).toBe(false);
  });

  it("is false for any non-synced status", () => {
    for (const status of ["never", "stale", "syncing", "error"] as const) {
      const e = { ...emptyEmbedding(), status, model: "old-model" };
      expect(embeddingModelStale(e, "new-model")).toBe(false);
    }
  });
});

describe("emptyEmbedding / newVocabSource", () => {
  it("returns fresh instances so callers never share mutations", () => {
    expect(emptyEmbedding()).not.toBe(emptyEmbedding());
    expect(newVocabSource("a").embedding).not.toBe(newVocabSource("b").embedding);
    expect(newVocabSource("x")).toEqual({ id: "x", name: "", files: [], fields: [], ingestionField: null, labelField: null, badgeField: null, embedding: emptyEmbedding() });
  });
});

describe("sourceWithAddedFiles", () => {
  it("appends files and merges newly-detected columns without duplicating known ones", () => {
    const v = source({
      fields: [{ name: "term", includeForAI: true }, { name: "notes", includeForAI: false }],
      embedding: { ...emptyEmbedding(), status: "synced", model: "m" },
    });
    const out = sourceWithAddedFiles(v, [staged("f1", ["term", "gloss"])]);
    expect(out.files.map((f) => f.filename)).toEqual(["f1.xlsx"]);
    expect(out.files[0]).toMatchObject({ sizeBytes: 1024, rowCountLast: 7, addedDate: "2026-08-27" });
    // "term" already existed (keep its config); "gloss" is new (default included).
    expect(out.fields).toEqual([
      { name: "term", includeForAI: true },
      { name: "notes", includeForAI: false },
      { name: "gloss", includeForAI: true },
    ]);
    expect(out.embedding.status).toBe("stale");
    expect(out.embedding.model).toBe("m");
  });

  it("leaves a never-synced source's embedding status alone", () => {
    const out = sourceWithAddedFiles(source(), [staged("f1", [])]);
    expect(out.embedding.status).toBe("never");
  });

  it("composes across overlapping adds — the stale-snapshot bug regression guard", () => {
    // Two adds landing back-to-back through functional updates must keep both
    // batches; rebuilding whole-settings snapshots used to erase the first.
    let s = settings([source({ id: "a" }), source({ id: "b" })]);
    s = updateVocabSource(s, "a", (v) => sourceWithAddedFiles(v, [staged("a1", ["colA"])]));
    s = updateVocabSource(s, "b", (v) => sourceWithAddedFiles(v, [staged("b1", ["colB"])]));
    expect(s.vocabSources.find((v) => v.id === "a")!.files.map((f) => f.filename)).toEqual(["a1.xlsx"]);
    expect(s.vocabSources.find((v) => v.id === "b")!.files.map((f) => f.filename)).toEqual(["b1.xlsx"]);
    expect(s.vocabSources.flatMap((v) => v.files)).toHaveLength(2);
  });
});

describe("sourceWithRemovedFile", () => {
  it("removes only the named file and keeps siblings", () => {
    const v = source({ files: [{ id: "f1", filename: "one.csv", addedDate: "", sizeBytes: 1 }] });
    const withTwo = sourceWithAddedFiles(v, [staged("f2", [])]);
    const out = sourceWithRemovedFile(withTwo, "f2.xlsx");
    expect(out.files.map((f) => f.filename)).toEqual(["one.csv"]);
    // Content left the source, but a never-synced index stays "never".
    expect(out.embedding.status).toBe("never");
  });

  it("marks only a synced index stale when nothing matches the filename", () => {
    const v = source({ files: [{ id: "f1", filename: "one.csv", addedDate: "", sizeBytes: 1 }] });
    // Matches the legacy actions.ts behaviour: staleness derives from the
    // source's pre-call status, independent of whether a file was dropped.
    const synced = { ...v, embedding: { ...emptyEmbedding(), status: "synced" as const, model: "m" } };
    expect(sourceWithRemovedFile(synced, "missing.csv").embedding.status).toBe("stale");
    expect(sourceWithRemovedFile(v, "missing.csv")).toEqual(v);
  });
});

describe("syncInputsChanged", () => {
  const base = source({
    files: [{ id: "f1", filename: "one.csv", addedDate: "", sizeBytes: 1 }],
    fields: [{ name: "term", includeForAI: true }, { name: "notes", includeForAI: false }],
    ingestionField: "term",
  });

  it("is false when the sync-relevant inputs are unchanged", () => {
    // Display-only config (name, label/badge fields) never affects embeddings.
    const touched = { ...base, name: "Renamed", labelField: "term", badgeField: "notes" };
    expect(syncInputsChanged(base, touched)).toBe(false);
  });

  it("is true when a file was added or removed mid-sync", () => {
    expect(syncInputsChanged(base, sourceWithAddedFiles(base, [staged("f2", [])]))).toBe(true);
    expect(syncInputsChanged(base, sourceWithRemovedFile(base, "one.csv"))).toBe(true);
  });

  it("is true when the ingestion column or an includeForAI flag flipped", () => {
    expect(syncInputsChanged(base, { ...base, ingestionField: "notes" })).toBe(true);
    const toggled = { ...base, fields: base.fields.map((f) => (f.name === "term" ? { ...f, includeForAI: false } : f)) };
    expect(syncInputsChanged(base, toggled)).toBe(true);
  });
});

describe("sync completion vs concurrent edits", () => {
  it("a file added to source B mid-sync survives A's completion write", () => {
    // The sync-completion race regression guard: completion is a functional
    // update touching only the synced source, so a concurrent add to another
    // source composes instead of being erased by a stale whole-settings
    // snapshot (files used to vanish from the card once the sync finished).
    let s = settings([source({ id: "a" }), source({ id: "b" })]);
    s = updateVocabSource(s, "b", (v) => sourceWithAddedFiles(v, [staged("b1", ["colB"])]));
    s = updateVocabSource(s, "a", (v) => ({
      ...v,
      embedding: { ...emptyEmbedding(), status: "synced", model: "m", rowsEmbedded: 5 },
    }));
    expect(s.vocabSources.find((v) => v.id === "b")!.files.map((f) => f.filename)).toEqual(["b1.xlsx"]);
    expect(s.vocabSources.find((v) => v.id === "a")!.embedding.status).toBe("synced");
  });

  it("a mid-sync add to the syncing source flags the finished embed as drifted", () => {
    const atStart = source({
      files: [{ id: "f1", filename: "one.csv", addedDate: "", sizeBytes: 1 }],
      embedding: { ...emptyEmbedding(), status: "synced" as const, model: "m" },
    });
    const midSync = sourceWithAddedFiles(atStart, [staged("f2", [])]);
    // The sync pass never saw f2 — completion must land stale, not synced.
    expect(syncInputsChanged(atStart, midSync)).toBe(true);
  });
});

describe("updateVocabSource", () => {
  it("touches only the targeted source and passes unrelated ones through by reference", () => {
    const b = source({ id: "b", name: "kept" });
    const s = updateVocabSource(settings([source({ id: "a", name: "old" }), b]), "a", (v) => ({ ...v, name: "new" }));
    expect(s.vocabSources.map((v) => v.name)).toEqual(["new", "kept"]);
    expect(s.vocabSources[1]).toBe(b);
  });

  it("is a no-op for an unknown id", () => {
    const s = settings([source({ id: "a" })]);
    expect(updateVocabSource(s, "ghost", (v) => ({ ...v, name: "boo" }))).toEqual(s);
  });
});

describe("withoutVocabSource", () => {
  it("drops the source and prunes dangling field references", () => {
    const s = settings([source({ id: "a" }), source({ id: "b" })]);
    s.fields = [
      { id: "f1", name: "Material", type: "vocab", layout: "row", prompt: "", vocabSources: ["a", "b"], maxComponents: 1 },
      { id: "f2", name: "Era", type: "open", layout: "row", prompt: "", vocabSources: [], maxComponents: 1 },
    ];
    const out = withoutVocabSource(s, "a");
    expect(out.vocabSources.map((v) => v.id)).toEqual(["b"]);
    expect(out.fields[0].vocabSources).toEqual(["b"]);
    expect(out.fields[1].vocabSources).toEqual([]);
  });
});

describe("withReorderedVocabSources", () => {
  it("reorders persisted sources to the given sequence", () => {
    const s = settings([source({ id: "a" }), source({ id: "b" }), source({ id: "c" })]);
    expect(withReorderedVocabSources(s, ["c", "a", "b"]).vocabSources.map((v) => v.id)).toEqual(["c", "a", "b"]);
  });

  it("ignores ids that don't persist", () => {
    const s = settings([source({ id: "a" }), source({ id: "b" })]);
    expect(withReorderedVocabSources(s, ["b", "draft-only"]).vocabSources.map((v) => v.id)).toEqual(["b"]);
  });
});
