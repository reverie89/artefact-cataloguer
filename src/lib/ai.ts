// Frontend wrapper around the Rust AI commands. Cataloguing runs on the Rust
// side (keys never touch the renderer, no CORS). Errors propagate so callers
// can surface them — there is no demo fallback.

import { invoke } from "@tauri-apps/api/core";
import type { CatalogueField, EmbeddingProvider, Provider, Settings } from "../app/types";

interface RawCatalogueResult {
  fieldResults: Record<string, { value: string; similarity?: number }[]>;
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

interface RustProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: string;
}

interface RustField {
  name: string;
  type: string;
  prompt: string;
  vocabSourceIds: string[];
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
  /** The unified vision-analysis prompt (persona + output-format preamble).
   *  The XML field enumeration and `<artefact_file>` record block are appended
   *  by Rust. */
  visionSystemPrompt: string;
  artefactColumns: RustArtefactColumn[];
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
 *  retrieval. `never`/`stale`/`error` are not: `vocabSourceIdsForRetrieval`
 *  omits them, which would otherwise silently fall through to Rust's `else`
 *  branch in `build_combined_prompt` — the field is prompted as
 *  *unconstrained free text*, not the vocab list, since an empty
 *  `vocabSourceIds` reads as "not a vocab field" there. Cataloguing must not
 *  run against a source in this state; see `findUnsyncedVocabField`. */
function isVocabSourceReady(vs: Settings["vocabSources"][number]): boolean {
  return vs.embedding.status === "synced";
}

/**
 * Find the first vocab field/source pair that would silently lose its
 * controlled-vocabulary constraint if cataloguing ran right now (see
 * {@link isVocabSourceReady}). Checked once before a Parse run — mirrors the
 * "active provider required" pre-flight check — so a forgotten Sync fails
 * loudly instead of producing free-text answers for a field that looks like
 * a controlled-vocabulary pick list everywhere else in the UI.
 */
export function findUnsyncedVocabField(settings: Settings): { fieldName: string; sourceName: string } | null {
  for (const field of settings.fields) {
    if (field.type !== "vocab") continue;
    for (const sid of field.vocabSources || []) {
      const vs = settings.vocabSources.find((v) => v.id === sid);
      if (vs && !isVocabSourceReady(vs)) {
        return { fieldName: field.name || "Untitled field", sourceName: vs.name || "Untitled source" };
      }
    }
  }
  return null;
}

/**
 * Vocab fields are resolved purely by embedding search against the
 * vision-analysis description — no LLM call, no vocab list in any prompt.
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
 * inlined into vision analysis by the Rust side; the three-step XML pipeline
 * (vision analysis vision+extraction → embedding → validation) runs entirely
 * in Rust. Returns per-field suggestions: open-ended fields carry no
 * similarity; controlled-vocab fields carry cosine `similarity`. Throws on
 * transport/HTTP errors so callers can surface them — there is no demo
 * fallback.
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
  const rustProvider: RustProvider = {
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    apiFormat: provider.apiFormat ?? "openai",
  };
  const rustFields: RustField[] = fields.map((f) => ({
    name: f.name,
    type: f.type,
    prompt: f.prompt,
    // Vocab fields are resolved by per-field embedding search + validation on
    // the Rust side. findUnsyncedVocabField + findVocabFieldWithoutEmbedding
    // guarantee a vocab field's sources are synced AND an embedding provider
    // is active by call time.
    vocabSourceIds: vocabSourceIdsForRetrieval(f, settings),
  }));
  const rustArtefact: RustArtefact = {
    record,
    imagePath: imagePath || null,
    // The unified vision-analysis prompt: persona + output-format preamble.
    // Rust appends the XML field enumeration and the <artefact_file> record
    // block.
    visionSystemPrompt: settings.visionSystemPromptInstruction?.trim() || "",
    artefactColumns: (settings.artefactFields || []).map((c) => ({ name: c.name, prompt: c.prompt ?? "" })),
  };
  const embProvider = activeEmbeddingProvider(settings);
  const res = await invoke<RawCatalogueResult>("catalogue_artefact", {
    provider: rustProvider,
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
 * Assemble the exact unified vision-analysis prompt `catalogueArtefact` would
 * send as its first user turn, without making any network call. Used by the
 * Artefact File tab's prompt preview. The row's source values are produced at
 * parse time, so the record is shown as a placeholder; the image attaches as a
 * separate content block in real runs.
 *
 * Includes ALL fields (open + vocab): both emit XML blocks in the unified
 * prompt's enumeration, so the preview reflects exactly what vision analysis
 * sends.
 */
export async function buildPromptPreview(settings: Settings): Promise<string> {
  const rustArtefact: RustArtefact = {
    record: {},
    imagePath: null,
    visionSystemPrompt: settings.visionSystemPromptInstruction?.trim() || "",
    artefactColumns: [],
  };
  const columns: RustArtefactColumn[] = (settings.artefactFields || []).map((c) => ({ name: c.name, prompt: c.prompt ?? "" }));
  const fields: RustField[] = (settings.fields || []).map((f) => ({
    name: f.name,
    type: f.type,
    prompt: f.prompt,
    vocabSourceIds: [],
  }));
  return invoke<string>("build_vision_prompt_preview", { columns, fields, artefact: rustArtefact });
}

/** Ping the provider (GET /models) to validate URL + key and fetch the model list. */
export async function testConnection(provider: Provider): Promise<RawConnectionTest> {
  const res = await invoke<RawConnectionTest>("test_connection", {
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

/** Shape returned by the Rust `test_embedding_connection` command — mirrors
 *  RawConnectionTest, plus the vector width learned from a real embed call. */
interface RawEmbeddingConnectionTest {
  ok: string;
  models: string[];
  dimensions: number;
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
 *  key, fetch the model list, and learn the vector width. Mirrors
 *  testConnection for the chat provider list. */
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
