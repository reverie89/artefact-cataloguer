import { describe, expect, it } from "vitest";

import { _DEF, _DEF_AF, _DEF_FIELDS, _DEF_VOCAB } from "./defaults";

/**
 * Guards for the synced seed data. `defaults.ts` is the single source of truth
 * for fresh installs / resets, so these tests pin the shape that was ported
 * from the live in-app settings: artefact columns, cataloguing fields, and the
 * structural vocab-source config (API keys and vocab file bytes are excluded —
 * they don't belong in the repo).
 */
describe("synced seed data", () => {
  it("seeds 9 artefact columns, each with an empty prompt and export on", () => {
    expect(_DEF_AF).toHaveLength(9);
    for (const col of _DEF_AF) {
      expect(col.prompt).toBe("");
      expect(col.includeInExport).toBe(true);
      expect(typeof col.name).toBe("string");
      expect(col.name.length).toBeGreaterThan(0);
    }
    // The image column is present and recognised by the parser's role resolver.
    expect(_DEF_AF.some((c) => /images?/i.test(c.name))).toBe(true);
  });

  it("seeds 8 cataloguing fields whose vocab refs resolve to seeded sources", () => {
    expect(_DEF_FIELDS).toHaveLength(8);
    const sourceIds = new Set(_DEF_VOCAB.map((v) => v.id));
    for (const f of _DEF_FIELDS) {
      expect(f.layout).toBe("row");
      for (const sid of f.vocabSources) {
        // Every vocab reference in the seeded fields points at a seeded source.
        expect(sourceIds.has(sid), `field "${f.name}" references unknown vocab source "${sid}"`).toBe(true);
      }
      // Vocab fields must have at least one source; open fields must have none.
      if (f.type === "vocab") {
        expect(f.vocabSources.length).toBeGreaterThan(0);
      } else {
        expect(f.type).toBe("open");
        expect(f.vocabSources).toEqual([]);
      }
    }
  });

  it("seeds 7 vocab sources with structural config only (no files, never-synced)", () => {
    expect(_DEF_VOCAB).toHaveLength(7);
    for (const v of _DEF_VOCAB) {
      expect(v.files).toEqual([]);
      expect(v.embedding.status).toBe("never");
      // Shared column layout ported from the live config.
      expect(v.ingestionField).toBe("Term");
      expect(v.labelField).toBe("Term");
      expect(v.badgeField).toBe("Thesaurus");
      expect(v.fields.map((f) => f.name)).toEqual(["Field Name", "Term", "Thesaurus"]);
    }
  });

  it("_DEF() deep-clones the seed (mutations don't leak across instances)", () => {
    const a = _DEF();
    const b = _DEF();
    a.artefactFields[0].name = "mutated";
    a.fields[0].prompt = "mutated";
    a.vocabSources[0].name = "mutated";
    expect(b.artefactFields[0].name).not.toBe("mutated");
    expect(b.fields[0].prompt).not.toBe("mutated");
    expect(b.vocabSources[0].name).not.toBe("mutated");
  });

  it("_DEF() seeds the unified system prompt and keeps providers empty", () => {
    const d = _DEF();
    // The unified prompt carries the museum persona + output-format preamble;
    // it is the single system prompt now (Call 2 is gone).
    expect(d.visionSystemPromptInstruction.length).toBeGreaterThan(0);
    expect(d.visionSystemPromptInstruction).toContain("<artefact_file>");
    expect(d.vocabNetCount).toBe(20);
    expect(d.vocabShortlistCount).toBe(3);
    expect(d.validationEnabled).toBe(false);
    expect(d.providers).toEqual([]);
    expect(d.embeddingProviders).toEqual([]);
    expect(d.activeProvider).toBeNull();
  });
});
