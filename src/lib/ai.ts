// Frontend wrapper around the Rust AI commands. Cataloguing runs on the Rust
// side (keys never touch the renderer, no CORS). Errors propagate so callers
// can surface them — there is no demo fallback.

import { invoke } from "@tauri-apps/api/core";
import type { ArtefactField, CatalogueField, EmbeddingProvider, Provider, Settings, ThinkingEffort } from "../app/types";
import { embeddingModelStale } from "../app/vocabSettings";
import { normalizeHeader } from "./spreadsheet";

interface RawCatalogueResult {
  fieldResults: Record<string, { value: string; similarity?: number }[]>;
}

/** The provider payload the Rust commands accept — mirrors
 *  `src_tauri::ai::types::Provider` (camelCase serde renames there). */
interface RustProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: string;
  /** `null` = off: Rust sends no thinking fields. */
  thinking: ThinkingEffort | null;
}

function toRustProvider(provider: Provider): RustProvider {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    apiFormat: provider.apiFormat ?? "openai",
    thinking: provider.thinking ?? null,
  };
}

/**
 * Sentinel rejection message from the Rust side when a `catalogue_artefact`
 * call is cancelled via {@link cancelCatalogue}. Must mirror
 * `CANCEL_ERROR` in `src-tauri/src/ai.rs`. Callers distinguish a cancel from a
 * genuine failure by comparing the rejection's message against this.
 */
export const CANCEL_ERROR = "__ac_cancelled__";

/** Shape returned by the Rust `test_connection` command. */
interface RawConnectionTest {
  ok: string;
  models: string[];
}

interface RustField {
  name: string;
  type: string;
  prompt: string;
  vocabSourceIds: string[];
  /** Distinct components the AI picks the top term for: 1 = single,
   *  2+ = one per component, 0 = unlimited. */
  maxComponents: number;
}

interface RustEmbeddingProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: string;
}

function toRustEmbeddingProvider(provider: EmbeddingProvider): RustEmbeddingProvider {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    apiFormat: provider.apiFormat ?? "openai",
  };
}

interface RustArtefactColumn {
  name: string;
  prompt: string;
}

interface RustArtefact {
  record: Record<string, string>;
  imagePath: string | null;
  /** The unified artefact-analysis prompt (persona + output-format preamble).
   *  The XML field enumeration and `<artefact_file>` record block are appended
   *  by Rust. */
  artefactAnalysisSystemPrompt: string;
  artefactColumns: RustArtefactColumn[];
}

/**
 * The record the AI sees: only configured Artefact File columns with
 * `includeForAI` on, matched against the sheet's headers with the parser's
 * normalization (normalizeHeader — case-insensitive, whitespace runs
 * collapsed). Unconfigured columns appear nowhere (not displayed, exported,
 * or sent to the AI); configured columns toggled off still appear in the
 * source record panel — this bound applies only to the AI payload. The Image
 * column never appears in `record` (the parser excludes it; its bytes travel
 * separately).
 */
export function recordForAI(record: Record<string, string>, artefactFields: ArtefactField[]): Record<string, string> {
  const include = new Set(artefactFields.filter((f) => f.includeForAI).map((f) => normalizeHeader(f.name)));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (include.has(normalizeHeader(k))) out[k] = v;
  }
  return out;
}

/** Per-column guidance lines for the prompt — only for columns the AI
 *  actually receives; guidance about an excluded column would be misleading. */
function aiIncludedColumns(settings: Settings): RustArtefactColumn[] {
  return (settings.artefactFields || [])
    .filter((c) => c.includeForAI)
    .map((c) => ({ name: c.name, prompt: c.prompt ?? "" }));
}

/** Ids of this field's vocab sources whose embedded index is ready for
 *  server-side retrieval (never-synced/stale/error sources resolve to
 *  nothing until the user syncs them in Settings). */
export function vocabSourceIdsForRetrieval(field: CatalogueField, settings: Settings): string[] {
  if (field.type !== "vocab") return [];
  return (field.vocabSources || []).filter((sid) => {
    const vs = settings.vocabSources.find((v) => v.id === sid);
    return !!vs && vs.embedding.status === "synced";
  });
}

/** True when a vocab source's embedded index is ready for server-side
 *  retrieval: synced, and embedded with the currently-active embedding model
 *  (an index built in another model's vector space would return meaningless
 *  cosine scores — see {@link findUnsyncedVocabField}). `vocabSourceIdsForRetrieval`
 *  omits unready sources, which would otherwise silently fall through to
 *  Rust's `else` branch in `build_combined_prompt` — the field is prompted as
 *  *unconstrained free text*, not the vocab list, since an empty
 *  `vocabSourceIds` reads as "not a vocab field" there. Cataloguing must not
 *  run against a source in this state; see `findUnsyncedVocabField`. */
function isVocabSourceReady(vs: Settings["vocabSources"][number], activeModel: string | null): boolean {
  return vs.embedding.status === "synced" && !embeddingModelStale(vs.embedding, activeModel);
}

/** Why {@link findUnsyncedVocabField} rejected a source: never synced (or
 *  content-stale/errored), or synced with a different embedding model than is
 *  now active. */
export type UnsyncedVocabReason = "not-synced" | "model-changed";

/**
 * Find the first vocab field/source pair that would silently lose its
 * controlled-vocabulary constraint if cataloguing ran right now (see
 * {@link isVocabSourceReady}). Checked once before a Parse run — mirrors the
 * "active provider required" pre-flight check — so a forgotten Sync (or a
 * just-switched embedding model) fails loudly instead of producing free-text
 * answers or meaningless cosine matches for a field that looks like a
 * controlled-vocabulary pick list everywhere else in the UI.
 */
export function findUnsyncedVocabField(settings: Settings): {
  fieldName: string;
  sourceName: string;
  reason: UnsyncedVocabReason;
  /** The model the source was embedded with, and the now-active model — set
   *  on the "model-changed" reason so the error can say both. */
  embeddedModel: string | null;
  activeModel: string | null;
} | null {
  const activeModel = activeEmbeddingProvider(settings)?.model ?? null;
  for (const field of settings.fields) {
    if (field.type !== "vocab") continue;
    for (const sid of field.vocabSources || []) {
      const vs = settings.vocabSources.find((v) => v.id === sid);
      if (!vs || isVocabSourceReady(vs, activeModel)) continue;
      return {
        fieldName: field.name || "Untitled field",
        sourceName: vs.name || "Untitled source",
        reason: vs.embedding.status === "synced" ? "model-changed" : "not-synced",
        embeddedModel: vs.embedding.model,
        activeModel,
      };
    }
  }
  return null;
}

/**
 * Vocab fields are resolved purely by embedding search against the
 * artefact-analysis description — no LLM call, no vocab list in any prompt.
 * That requires an active embedding provider; without one, a vocab field
 * would silently yield empty results. Returns the first such field so a Parse
 * run can fail loudly with a pointer to fix it, mirroring
 * {@link findUnsyncedVocabField}.
 */
export function findVocabFieldWithoutEmbedding(settings: Settings): { fieldName: string } | null {
  const hasVocabField = settings.fields.some((f) => f.type === "vocab" && (f.vocabSources || []).length > 0);
  if (!hasVocabField) return null;
  if (activeEmbeddingProvider(settings)) return null;
  const first = settings.fields.find((f) => f.type === "vocab" && (f.vocabSources || []).length > 0);
  return { fieldName: first?.name || "Untitled field" };
}

/**
 * Derive the live HTTP endpoints a provider's calls actually hit. Single source
 * of truth shared by the call path (catalogueArtefact/testConnection) and the UI
 * so the displayed endpoint can never drift from what Rust posts to. Endpoint
 * paths depend on the provider's API family.
 */
export function providerEndpoints(provider: Pick<Provider, "baseUrl" | "apiFormat">): { completions: string; models: string } {
  const base = provider.baseUrl.replace(/\/$/, "");
  switch (provider.apiFormat ?? "openai") {
    case "anthropic":
      return { completions: `${base}/v1/messages`, models: `${base}/v1/models` };
    case "gemini":
      return { completions: `${base}/v1beta/interactions`, models: `${base}/v1beta/models` };
    default:
      return { completions: `${base}/chat/completions`, models: `${base}/models` };
  }
}

/**
 * Catalogue one artefact via the active provider. The image (when present) is
 * inlined into artefact analysis by the Rust side; the three-step XML pipeline
 * (artefact analysis vision+extraction → embedding → validation) runs entirely
 * in Rust. Returns per-field suggestions: open-ended fields carry no
 * similarity; controlled-vocab fields carry cosine `similarity`. Throws on
 * transport/HTTP errors so callers can surface them — there is no demo
 * fallback. `record` is filtered to the Artefact File columns with Include
 * for AI on before invoke (see {@link recordForAI}).
 *
 * `cancelKey` identifies this call in Rust's cancel registry (see
 * {@link cancelCatalogue}); cancelling it makes the Rust side drop the in-flight
 * reqwest future and reject this promise with {@link CANCEL_ERROR}.
 */
export async function catalogueArtefact(
  provider: Provider,
  fields: CatalogueField[],
  record: Record<string, string>,
  imagePath: string | undefined,
  settings: Settings,
  cancelKey: string
): Promise<Record<string, { value: string; similarity?: number }[]>> {
  const rustFields: RustField[] = fields.map((f) => ({
    name: f.name,
    type: f.type,
    prompt: f.prompt,
    // Vocab fields are resolved by per-field embedding search + validation on
    // the Rust side. findUnsyncedVocabField + findVocabFieldWithoutEmbedding
    // guarantee a vocab field's sources are synced AND an embedding provider
    // is active by call time.
    vocabSourceIds: vocabSourceIdsForRetrieval(f, settings),
    maxComponents: f.maxComponents,
  }));
  const rustArtefact: RustArtefact = {
    record: recordForAI(record, settings.artefactFields || []),
    imagePath: imagePath || null,
    // The unified artefact-analysis prompt: persona + output-format preamble.
    // Rust appends the XML field enumeration and the <artefact_file> record
    // block.
    artefactAnalysisSystemPrompt: settings.artefactAnalysisSystemPromptInstruction?.trim() || "",
    artefactColumns: aiIncludedColumns(settings),
  };
  const embProvider = activeEmbeddingProvider(settings);
  const res = await invoke<RawCatalogueResult>("catalogue_artefact", {
    provider: toRustProvider(provider),
    fields: rustFields,
    artefact: rustArtefact,
    jobId: cancelKey,
    embeddingProvider: embProvider ? toRustEmbeddingProvider(embProvider) : null,
    netCount: settings.vocabNetCount,
    shortlistCount: settings.vocabShortlistCount,
    validationEnabled: settings.validationEnabled,
  });
  return res.fieldResults || {};
}

/**
 * Cancel an in-flight {@link catalogueArtefact} call by its `cancelKey`.
 * Idempotent: cancelling a job that already finished (or was never started) is
 * a no-op. The cancelled call rejects with {@link CANCEL_ERROR}; callers must
 * treat that sentinel as a cancellation, not a failure.
 */
export async function cancelCatalogue(cancelKey: string): Promise<void> {
  await invoke("cancel_catalogue", { jobId: cancelKey });
}

/**
 * Assemble the exact unified artefact-analysis prompt `catalogueArtefact` would
 * send as its first user turn, without making any network call. Used by the
 * Artefact File tab's prompt preview. The row's source values are produced at
 * parse time, so the record is shown as a placeholder; the image attaches as a
 * separate content block in real runs.
 *
 * Includes ALL fields (open + vocab): both emit XML blocks in the unified
 * prompt's enumeration, so the preview reflects exactly what artefact analysis
 * sends.
 */
export async function buildPromptPreview(settings: Settings): Promise<string> {
  const rustArtefact: RustArtefact = {
    record: {},
    imagePath: null,
    artefactAnalysisSystemPrompt: settings.artefactAnalysisSystemPromptInstruction?.trim() || "",
    artefactColumns: [],
  };
  const columns: RustArtefactColumn[] = aiIncludedColumns(settings);
  const fields: RustField[] = (settings.fields || []).map((f) => ({
    name: f.name,
    type: f.type,
    prompt: f.prompt,
    vocabSourceIds: [],
    maxComponents: f.maxComponents,
  }));
  return invoke<string>("build_artefact_analysis_prompt_preview", { columns, fields, artefact: rustArtefact });
}

/** Ping the provider (GET /models) to validate URL + key and fetch the model list. */
export async function testConnection(provider: Provider): Promise<RawConnectionTest> {
  const res = await invoke<RawConnectionTest>("test_connection", {
    provider: toRustProvider(provider),
  });
  return res;
}

/** Shape returned by the Rust `test_embedding_connection` command — mirrors
 *  RawConnectionTest, plus the advertised image-input subset (`null` when the
 *  catalog carries no input-modality metadata, so capability is unknown rather
 *  than absent). */
interface RawEmbeddingConnectionTest {
  ok: string;
  models: string[];
  image_input: string[] | null;
}

/**
 * Model ids the picker may offer: when the catalog advertised input
 * modalities, only image-capable ids are usable (the pipeline embeds the
 * artefact image unconditionally, so a text-only model hard-fails every row)
 * — the strict intersection, **including empty**, so a provider with no
 * image-capable model shows an explained empty picker rather than options
 * that would all fail. Without metadata (`null`) nothing is known and the
 * full list passes through.
 */
export function embeddingModelOptions(modelOptions: string[], imageInputModels: string[] | null): string[] {
  if (!imageInputModels) return modelOptions;
  const image = new Set(imageInputModels);
  return modelOptions.filter((m) => image.has(m));
}

/** True when a model is selected but the catalog's metadata says it can't
 *  accept image input — the per-model warning state. Only fires when
 *  metadata is known; metadata-less catalogs can't warn here (the runtime
 *  image-embed error is that case's guard). */
export function selectedModelLacksImageInput(model: string, imageInputModels: string[] | null): boolean {
  return !!model && !!imageInputModels && !imageInputModels.includes(model);
}

/** Derive the live embeddings endpoint an embedding provider's calls hit —
 *  mirrors providerEndpoints for the chat provider list. */
export function embeddingProviderEndpoints(provider: Pick<EmbeddingProvider, "baseUrl" | "apiFormat">): { embeddings: string; models: string } {
  const base = provider.baseUrl.replace(/\/$/, "");
  switch (provider.apiFormat ?? "openai") {
    case "gemini":
      return { embeddings: `${base}/v1beta/models`, models: `${base}/v1beta/models` };
    default:
      return { embeddings: base, models: `${base}/models` };
  }
}

/** Ping the embedding provider with a real 1-item embed call to validate URL +
 *  key and fetch the model list. Mirrors testConnection for the chat provider
 *  list. */
export async function testEmbeddingConnection(provider: EmbeddingProvider): Promise<RawEmbeddingConnectionTest> {
  const res = await invoke<RawEmbeddingConnectionTest>("test_embedding_connection", {
    provider: {
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      apiFormat: provider.apiFormat ?? "openai",
    },
  });
  return res;
}

/** Look up the active embedding provider object, if any. */
export function activeEmbeddingProvider(settings: Settings): EmbeddingProvider | undefined {
  if (!settings.activeEmbeddingProvider) return undefined;
  return settings.embeddingProviders.find((p) => p.id === settings.activeEmbeddingProvider);
}

/** True when a usable provider is configured and active. */
export function hasProvider(settings: Settings): settings is Settings & { activeProvider: string } {
  return !!activeProvider(settings);
}

/** Look up the active provider object. */
export function activeProvider(settings: Settings): Provider | undefined {
  if (!settings.activeProvider) return undefined;
  return settings.providers.find((p) => p.id === settings.activeProvider);
}

/**
 * A settings.json moved to another install arrives with `connStatus: "ok"`
 * claims whose API keys didn't come along — keys live in the OS keychain,
 * which doesn't migrate, and rehydration on a miss silently yields an empty
 * key. The Test Connection button itself refuses to verify a keyless
 * provider, so such a claim is dead on arrival: degrade it to "err" once at
 * startup instead of letting the badge keep saying success. Returns the same
 * array reference when nothing needs downgrading, so callers can skip
 * no-op persistence. `err`/`untested` always pass through unchanged.
 */
export function downgradeKeylessConnOk<P extends { apiKey: string; connStatus?: "ok" | "err" | "untested" }>(providers: P[]): P[] {
  if (!providers.some((p) => p.connStatus === "ok" && !p.apiKey)) return providers;
  return providers.map((p) =>
    p.connStatus === "ok" && !p.apiKey ? { ...p, connStatus: "err" as const } : p,
  );
}
