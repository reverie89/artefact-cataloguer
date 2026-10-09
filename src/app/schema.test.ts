import { describe, expect, it } from "vitest";

import { PersistedSettingsSchema } from "./schema";

const legacyField = { id: "f1", name: "Material", type: "vocab", layout: "row", prompt: "", vocabSources: [] };

describe("CatalogueFieldSchema back-compat (via PersistedSettingsSchema)", () => {
  it("loads fields written before maxComponents as single (1)", () => {
    const parsed = PersistedSettingsSchema.parse({ fields: [legacyField] });
    expect(parsed.fields?.[0]?.maxComponents).toBe(1);
  });

  it("rejects negative or fractional component counts", () => {
    expect(() => PersistedSettingsSchema.parse({ fields: [{ ...legacyField, maxComponents: -1 }] })).toThrow();
    expect(() => PersistedSettingsSchema.parse({ fields: [{ ...legacyField, maxComponents: 1.5 }] })).toThrow();
  });
});
