// Runtime validation schemas for untrusted settings JSON.
//
// Two entry points are untrusted: a user-selected import file
// (`importSettings`) and the persisted `settings.json` (`loadState`, which may
// be hand-edited or come from an older schema). Both are validated here before
// they are trusted as `Settings`, instead of being `JSON.parse`d and cast.

import { z } from "zod";

const fieldType = z.enum(["open", "vocab"]);
const apiFormat = z.enum(["openai", "anthropic", "gemini"]);
const embeddingApiFormat = z.enum(["openai", "gemini"]);

const CatalogueFieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: fieldType,
  layout: z.string(),
  prompt: z.string(),
  vocabSources: z.array(z.string()),
});

const VocabSourceFileSchema = z.object({
  id: z.string(),
  filename: z.string(),
  addedDate: z.string(),
  sizeBytes: z.number(),
  rowCountLast: z.number().optional(),
  rowCountSyncedLast: z.number().optional(),
});

const VocabSourceFieldSchema = z.object({
  name: z.string(),
  includeForAI: z.boolean(),
});

const VocabEmbeddingStatusSchema = z.object({
  status: z.enum(["never", "stale", "syncing", "synced", "error"]),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  dimensions: z.number().nullable(),
  lastSyncedAt: z.string().nullable(),
  rowsEmbedded: z.number().nullable(),
  lastError: z.string().nullable(),
});

const VocabSourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  files: z.array(VocabSourceFileSchema),
  fields: z.array(VocabSourceFieldSchema),
  // Nullable + defaulted (rather than merely `.nullable()`) so settings
  // persisted before these roles existed — which won't have the keys at all
  // — load with the safe "use positional/no role" default instead of failing
  // validation. See VocabSource's doc comment in app/types.ts.
  ingestionField: z.string().nullable().default(null),
  labelField: z.string().nullable().default(null),
  badgeField: z.string().nullable().default(null),
  embedding: VocabEmbeddingStatusSchema,
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

const EmbeddingProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string(),
  modelOptions: z.array(z.string()).optional(),
  apiFormat: embeddingApiFormat.optional(),
  supportsImageInput: z.boolean().optional(),
  dimensions: z.number().optional(),
  connStatus: z.enum(["ok", "err", "untested"]).optional(),
});

const ArtefactFieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  // `.default("")` so settings.json written before this field existed load
  // cleanly — an absent key reads as "no per-column vision guidance".
  prompt: z.string().default(""),
});

/**
 * Full `Settings` shape. Used to validate a user-selected import file, where a
 * malformed payload should surface a precise error rather than a runtime crash.
 */
export const SettingsSchema = z.object({
  visionSystemPromptInstruction: z.string(),
  vocabNetCount: z.number(),
  vocabShortlistCount: z.number(),
  call3Enabled: z.boolean(),
  fields: z.array(CatalogueFieldSchema),
  vocabSources: z.array(VocabSourceSchema),
  providers: z.array(ProviderSchema),
  activeProvider: z.string().nullable(),
  embeddingProviders: z.array(EmbeddingProviderSchema),
  activeEmbeddingProvider: z.string().nullable(),
  artefactFields: z.array(ArtefactFieldSchema),
});

/**
 * Tolerant variant for `loadState`: every field is optional so an older or
 * hand-edited `settings.json` parses, then `withDefaultSettings` fills gaps.
 * This validates element *shapes* (each provider/field is well-formed) without
 * rejecting a file merely for missing top-level keys.
 *
 * Note: the legacy `vocabularyLists` key (pre-VocabSource settings files) is
 * migrated to `vocabSources` by a raw-JSON pre-pass in lib/store.ts, *before*
 * this schema ever sees the object — so this schema only ever validates the
 * current `vocabSources` shape, not the old one.
 *
 * The pre-XML-pipeline keys `systemPromptInstruction` and
 * `systemPromptContractOverride` (the old Call-2 prompt + JSON contract) are
 * accepted here for back-compat but dropped by `withDefaultSettings` — the JSON
 * contract is fundamentally replaced by the fixed XML contract in Rust.
 */
export const PersistedSettingsSchema = SettingsSchema.partial({
  visionSystemPromptInstruction: true,
  vocabNetCount: true,
  vocabShortlistCount: true,
  call3Enabled: true,
  activeProvider: true,
  activeEmbeddingProvider: true,
})
  .extend({
    // Arrays are optional so an absent key produces `undefined` (not `[]`).
    // `withDefaultSettings` seeds them from `_DEF()` when undefined, preserving
    // an explicit `[]` the user may have intentionally saved.
    fields: z.array(CatalogueFieldSchema).optional(),
    vocabSources: z.array(VocabSourceSchema).optional(),
    providers: z.array(ProviderSchema).optional(),
    embeddingProviders: z.array(EmbeddingProviderSchema).optional(),
    artefactFields: z.array(ArtefactFieldSchema).optional(),
    // Deprecated pre-XML-pipeline keys: accepted so old files load, then
    // dropped. They are not part of Settings and never reach the reducer.
    systemPromptInstruction: z.string().optional(),
    systemPromptContractOverride: z.string().optional(),
  })
  .passthrough();
