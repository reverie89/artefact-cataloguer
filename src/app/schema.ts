// Runtime validation schemas for untrusted settings JSON.
//
// Two entry points are untrusted: a user-selected import file
// (`importSettings`) and the persisted `settings.json` (`loadState`, which may
// be hand-edited or come from an older schema). Both are validated here before
// they are trusted as `Settings`, instead of being `JSON.parse`d and cast.

import { z } from "zod";

const fieldType = z.enum(["open", "vocab"]);
const apiFormat = z.enum(["openai", "anthropic", "gemini"]);

const CatalogueFieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: fieldType,
  layout: z.string(),
  prompt: z.string(),
  vocabSources: z.array(z.string()),
});

const VocabListSchema = z.object({
  id: z.string(),
  filename: z.string(),
  name: z.string(),
  terms: z.number(),
  termData: z.array(z.string()),
  uploadDate: z.string(),
});

const ProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string(),
  modelOptions: z.array(z.string()).optional(),
  apiFormat: apiFormat.optional(),
  connStatus: z.enum(["ok", "err", "untested"]).optional(),
});

const ArtefactFieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  required: z.boolean(),
  description: z.string(),
  includeForAI: z.boolean().optional(),
});

/**
 * Full `Settings` shape. Used to validate a user-selected import file, where a
 * malformed payload should surface a precise error rather than a runtime crash.
 */
export const SettingsSchema = z.object({
  systemPromptInstruction: z.string(),
  systemPromptContractOverride: z.string(),
  fields: z.array(CatalogueFieldSchema),
  vocabularyLists: z.array(VocabListSchema),
  providers: z.array(ProviderSchema),
  activeProvider: z.string().nullable(),
  artefactFields: z.array(ArtefactFieldSchema),
});

/**
 * Tolerant variant for `loadState`: every field is optional so an older or
 * hand-edited `settings.json` parses, then `withDefaultSettings` fills gaps.
 * This validates element *shapes* (each provider/field is well-formed) without
 * rejecting a file merely for missing top-level keys.
 */
export const PersistedSettingsSchema = SettingsSchema.partial({
  systemPromptInstruction: true,
  systemPromptContractOverride: true,
  activeProvider: true,
}).extend({
  // Arrays are optional so an absent key produces `undefined` (not `[]`).
  // `withDefaultSettings` seeds them from `_DEF()` when undefined, preserving
  // an explicit `[]` the user may have intentionally saved.
  fields: z.array(CatalogueFieldSchema).optional(),
  vocabularyLists: z.array(VocabListSchema).optional(),
  providers: z.array(ProviderSchema).optional(),
  artefactFields: z.array(ArtefactFieldSchema).optional(),
});
