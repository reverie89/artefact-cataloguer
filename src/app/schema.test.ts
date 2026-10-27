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

describe("ProviderSchema apiFormat", () => {
  const provider = { id: "p1", name: "", baseUrl: "", apiKey: "", model: "" };

  it("accepts the custom family and older files without the field", () => {
    const parsed = PersistedSettingsSchema.parse({ providers: [{ ...provider, apiFormat: "custom" }] });
    expect(parsed.providers?.[0]?.apiFormat).toBe("custom");
    expect(PersistedSettingsSchema.parse({ providers: [provider] }).providers?.[0]?.apiFormat).toBeUndefined();
  });

  it("accepts the custom auth header and message template", () => {
    const parsed = PersistedSettingsSchema.parse({
      providers: [{ ...provider, apiFormat: "custom", authHeader: "x-api-key", bodyTemplate: '{"input": "{{input}}"}' }],
    });
    expect(parsed.providers?.[0]?.authHeader).toBe("x-api-key");
    expect(parsed.providers?.[0]?.bodyTemplate).toBe('{"input": "{{input}}"}');
    // Absent on providers that predate the fields.
    expect(PersistedSettingsSchema.parse({ providers: [provider] }).providers?.[0]?.authHeader).toBeUndefined();
  });

  it("rejects unknown families", () => {
    expect(() => PersistedSettingsSchema.parse({ providers: [{ ...provider, apiFormat: "grpc" }] })).toThrow();
  });
});
