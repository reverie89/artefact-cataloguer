import { describe, expect, it } from "vitest";

import {
  downgradeKeylessConnOk,
  embeddingModelOptions,
  findUnsyncedVocabField,
  findVocabFieldWithoutEmbedding,
  providerEndpoints,
  recordForAI,
  selectedModelLacksImageInput,
} from "./ai";
import { _DEF } from "../app/defaults";
import type { ArtefactField, CatalogueField, EmbeddingProvider, Provider, Settings, VocabEmbeddingStatus, VocabSource } from "../app/types";

function baseSettings(fields: CatalogueField[], vocabSources: VocabSource[], overrides: Partial<Settings> = {}): Settings {
  return { ..._DEF(), fields, vocabSources, ...overrides };
}

function embedding(status: VocabEmbeddingStatus["status"], model: string | null = null): VocabEmbeddingStatus {
  return { status, providerId: null, model, lastSyncedAt: null, rowsEmbedded: null, lastError: null };
}

function vocabField(id: string, name: string, vocabSources: string[]): CatalogueField {
  return { id, name, type: "vocab", layout: "row", prompt: "", vocabSources, maxComponents: 1 };
}

function embeddingProvider(id: string, model: string): EmbeddingProvider {
  return { id, name: id, baseUrl: "https://example.test/v1/embeddings", apiKey: "k", model };
}

function source(id: string, name: string, opts: Partial<VocabSource>): VocabSource {
  return {
    id, name, files: [], fields: [],
    ingestionField: null, labelField: null, badgeField: null,
    embedding: embedding("never"), ...opts,
  };
}

describe("recordForAI", () => {
  const fields: ArtefactField[] = [
    { id: "a", name: "Material", description: "", prompt: "", includeForAI: true, includeInExport: true, useColumnLetter: false, column: "" },
    { id: "b", name: "Internal Notes", description: "", prompt: "", includeForAI: false, includeInExport: true, useColumnLetter: false, column: "" },
    { id: "c", name: "Curator's notes", description: "", prompt: "", includeForAI: true, includeInExport: false, useColumnLetter: false, column: "" },
  ];

  it("keeps only configured columns with Include for AI on", () => {
    const record = { Material: "bronze", "Internal Notes": "private", "Curator's notes": "fine piece", Unconfigured: "dropped" };
    expect(recordForAI(record, fields)).toEqual({ Material: "bronze", "Curator's notes": "fine piece" });
  });

  it("matches headers case-insensitively, preserving the record's key casing", () => {
    expect(recordForAI({ MATERIAL: "bronze" }, fields)).toEqual({ MATERIAL: "bronze" });
  });

  it("returns an empty record when no column is configured", () => {
    expect(recordForAI({ Material: "bronze" }, [])).toEqual({});
  });
});

describe("findUnsyncedVocabField", () => {
  it("flags a field whose source has never been synced", () => {
    const s = baseSettings(
      [vocabField("f1", "Material", ["v1"])],
      [source("v1", "Material Thesaurus", { embedding: embedding("never") })]
    );
    expect(findUnsyncedVocabField(s)).toEqual({
      fieldName: "Material",
      sourceName: "Material Thesaurus",
      reason: "not-synced",
      embeddedModel: null,
      activeModel: null,
    });
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

  it("flags a synced source embedded with a different model than the active provider", () => {
    const s = baseSettings(
      [vocabField("f1", "Material", ["v1"])],
      [source("v1", "Material Thesaurus", { embedding: embedding("synced", "old-model") })],
      { embeddingProviders: [embeddingProvider("p1", "new-model")], activeEmbeddingProvider: "p1" }
    );
    expect(findUnsyncedVocabField(s)).toEqual({
      fieldName: "Material",
      sourceName: "Material Thesaurus",
      reason: "model-changed",
      embeddedModel: "old-model",
      activeModel: "new-model",
    });
  });

  it("accepts a synced source embedded with the active provider's model", () => {
    const s = baseSettings(
      [vocabField("f1", "Material", ["v1"])],
      [source("v1", "Material Thesaurus", { embedding: embedding("synced", "same-model") })],
      { embeddingProviders: [embeddingProvider("p1", "same-model")], activeEmbeddingProvider: "p1" }
    );
    expect(findUnsyncedVocabField(s)).toBeNull();
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
      [{ id: "f1", name: "Description", type: "open", layout: "row", prompt: "", vocabSources: ["v1"], maxComponents: 1 }],
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
    expect(findUnsyncedVocabField(s)).toEqual({
      fieldName: "Technique",
      sourceName: "Technique Thesaurus",
      reason: "not-synced",
      embeddedModel: null,
      activeModel: null,
    });
  });
});

describe("embeddingModelOptions", () => {
  it("passes the full list through when image-input metadata is unknown", () => {
    expect(embeddingModelOptions(["a", "b"], null)).toEqual(["a", "b"]);
  });

  it("filters to the image-capable intersection when metadata is known", () => {
    expect(embeddingModelOptions(["a", "b", "c"], ["b", "c", "unlisted"])).toEqual(["b", "c"]);
  });

  it("returns an empty list when no advertised model accepts image input", () => {
    // No fallback: every full-list option would hard-fail the row anyway.
    expect(embeddingModelOptions(["a", "b"], [])).toEqual([]);
  });
});

describe("selectedModelLacksImageInput", () => {
  it("is false without a selection or without metadata", () => {
    expect(selectedModelLacksImageInput("", ["a"])).toBe(false);
    expect(selectedModelLacksImageInput("a", null)).toBe(false);
  });

  it("is true only when the selected model is absent from the image-capable list", () => {
    expect(selectedModelLacksImageInput("a", ["b"])).toBe(true);
    // Known-empty metadata ("nothing accepts image input"): any pick lacks it.
    expect(selectedModelLacksImageInput("a", [])).toBe(true);
    expect(selectedModelLacksImageInput("a", ["a", "b"])).toBe(false);
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

describe("downgradeKeylessConnOk", () => {
  // A settings.json moved from another install arrives with connStatus "ok"
  // whose API key didn't come along (keys live in the OS keychain). The Test
  // Connection button itself refuses a keyless provider, so those claims are
  // dead on arrival — degrade to "err" at startup.
  function chatProvider(opts: Partial<Provider>): Provider {
    return { id: "p", name: "", baseUrl: "https://example.test/v1", apiKey: "k", model: "m", ...opts };
  }

  it("degrades a keyless provider's persisted ok to err", () => {
    const out = downgradeKeylessConnOk([chatProvider({ apiKey: "", connStatus: "ok" })]);
    expect(out).toEqual([chatProvider({ apiKey: "", connStatus: "err" })]);
  });

  it("downgrades only the offending entries in a mixed list", () => {
    const keyed = chatProvider({ id: "a", connStatus: "ok" });
    const keyless = chatProvider({ id: "b", apiKey: "", connStatus: "ok" });
    const out = downgradeKeylessConnOk([keyed, keyless]);
    expect(out[0]).toBe(keyed);
    expect(out[1].connStatus).toBe("err");
  });

  it("returns the same array reference when nothing needs downgrading", () => {
    const providers = [
      chatProvider({ connStatus: "ok" }),
      chatProvider({ id: "b", apiKey: "", connStatus: "err" }),
      chatProvider({ id: "c" }), // connStatus undefined
    ];
    expect(downgradeKeylessConnOk(providers)).toBe(providers);
  });

  it("works on embedding providers through the same structural shape", () => {
    const emb = { id: "e", name: "", baseUrl: "https://example.test/v1", apiKey: "", model: "m", imageInputModels: null, connStatus: "ok" } as const;
    const out = downgradeKeylessConnOk([emb]);
    expect(out[0].connStatus).toBe("err");
  });
});

describe("providerEndpoints", () => {
  it("uses chat/completions by default and per-family versioned paths otherwise", () => {
    expect(providerEndpoints({ baseUrl: "https://api.test/v1", apiFormat: undefined }).completions).toBe("https://api.test/v1/chat/completions");
    expect(providerEndpoints({ baseUrl: "https://api.test", apiFormat: "anthropic" }).completions).toBe("https://api.test/v1/messages");
    expect(providerEndpoints({ baseUrl: "https://api.test", apiFormat: "gemini" }).completions).toBe("https://api.test/v1beta/interactions");
  });

  it("posts to the custom family's base URL verbatim", () => {
    expect(
      providerEndpoints({ baseUrl: "https://api-public.ai.tech.gov.sg/platform/gpt-6-luna/", apiFormat: "custom" }).completions,
    ).toBe("https://api-public.ai.tech.gov.sg/platform/gpt-6-luna");
  });
});
