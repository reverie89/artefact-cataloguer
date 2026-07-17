import { describe, expect, it } from "vitest";

import { findUnsyncedVocabField, findVocabFieldWithoutEmbedding } from "./ai";
import { _DEF } from "../app/defaults";
import type { CatalogueField, Settings, VocabEmbeddingStatus, VocabSource } from "../app/types";

function baseSettings(fields: CatalogueField[], vocabSources: VocabSource[]): Settings {
  return { ..._DEF(), fields, vocabSources };
}

function embedding(status: VocabEmbeddingStatus["status"]): VocabEmbeddingStatus {
  return { status, providerId: null, model: null, dimensions: null, lastSyncedAt: null, rowsEmbedded: null, lastError: null };
}

function vocabField(id: string, name: string, vocabSources: string[]): CatalogueField {
  return { id, name, type: "vocab", layout: "row", prompt: "", vocabSources };
}

function source(id: string, name: string, opts: Partial<VocabSource>): VocabSource {
  return {
    id, name, files: [], fields: [],
    ingestionField: null, labelField: null, badgeField: null,
    embedding: embedding("never"), ...opts,
  };
}

describe("findUnsyncedVocabField", () => {
  it("flags a field whose source has never been synced", () => {
    const s = baseSettings(
      [vocabField("f1", "Material", ["v1"])],
      [source("v1", "Material Thesaurus", { embedding: embedding("never") })]
    );
    expect(findUnsyncedVocabField(s)).toEqual({ fieldName: "Material", sourceName: "Material Thesaurus" });
  });

  it("flags a stale source (files/fields changed since the last sync)", () => {
    const s = baseSettings(
      [vocabField("f1", "Material", ["v1"])],
      [source("v1", "Material Thesaurus", { embedding: embedding("stale") })]
    );
    expect(findUnsyncedVocabField(s)).not.toBeNull();
  });

  it("flags a source whose last sync errored", () => {
    const s = baseSettings(
      [vocabField("f1", "Material", ["v1"])],
      [source("v1", "Material Thesaurus", { embedding: embedding("error") })]
    );
    expect(findUnsyncedVocabField(s)).not.toBeNull();
  });

  it("does not flag a fully synced source", () => {
    const s = baseSettings(
      [vocabField("f1", "Material", ["v1"])],
      [source("v1", "Material Thesaurus", { embedding: embedding("synced") })]
    );
    expect(findUnsyncedVocabField(s)).toBeNull();
  });

  it("ignores open-ended fields entirely", () => {
    const s = baseSettings(
      [{ id: "f1", name: "Description", type: "open", layout: "row", prompt: "", vocabSources: ["v1"] }],
      [source("v1", "Material Thesaurus", { embedding: embedding("never") })]
    );
    expect(findUnsyncedVocabField(s)).toBeNull();
  });

  it("finds the first unsynced source across multiple fields", () => {
    const s = baseSettings(
      [vocabField("f1", "Style", ["v1"]), vocabField("f2", "Technique", ["v2"])],
      [
        source("v1", "Style Thesaurus", { embedding: embedding("synced") }),
        source("v2", "Technique Thesaurus", { embedding: embedding("never") }),
      ]
    );
    expect(findUnsyncedVocabField(s)).toEqual({ fieldName: "Technique", sourceName: "Technique Thesaurus" });
  });
});

describe("findVocabFieldWithoutEmbedding", () => {
  it("flags a vocab field when no embedding provider is active", () => {
    const s = baseSettings(
      [vocabField("f1", "Material", ["v1"])],
      [source("v1", "Material Thesaurus", { embedding: embedding("synced") })]
    );
    expect(findVocabFieldWithoutEmbedding(s)).toEqual({ fieldName: "Material" });
  });

  it("is null when an embedding provider is active", () => {
    const s = baseSettings(
      [vocabField("f1", "Material", ["v1"])],
      [source("v1", "Material Thesaurus", { embedding: embedding("synced") })]
    );
    s.embeddingProviders = [{ id: "ep1", name: "Emb", baseUrl: "", apiKey: "", model: "" }];
    s.activeEmbeddingProvider = "ep1";
    expect(findVocabFieldWithoutEmbedding(s)).toBeNull();
  });

  it("is null when there are no vocab fields at all", () => {
    const s = baseSettings([], []);
    expect(findVocabFieldWithoutEmbedding(s)).toBeNull();
  });

  it("ignores a vocab field with no attached sources", () => {
    // A vocab field with no sources has nothing to search — it doesn't need an
    // embedding provider any more than an open field does.
    const s = baseSettings([vocabField("f1", "Material", [])], []);
    expect(findVocabFieldWithoutEmbedding(s)).toBeNull();
  });
});
