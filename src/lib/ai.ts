// Frontend wrapper around the Rust AI commands. Cataloguing runs on the Rust
// side (keys never touch the renderer, no CORS). Errors propagate so callers
// can surface them — there is no demo fallback.

import { invoke } from "@tauri-apps/api/core";
import { _DEF_SYSTEM_PROMPT_CONTRACT } from "../app/defaults";
import { resolveVocabSources } from "../app/styles";
import type { CatalogueField, Provider, Settings } from "../app/types";

interface RawCatalogueResult {
  fieldResults: Record<string, { value: string; confidence: number }[]>;
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
  allowed: string[];
}

interface RustArtefact {
  record: Record<string, string>;
  imagePath: string | null;
  systemPrompt: string;
  systemPromptContract: string;
}

/** Flatten a vocab field's allowed terms from its vocabSources lists. */
function allowedTerms(field: CatalogueField, settings: Settings): string[] {
  if (field.type !== "vocab") return [];
  return resolveVocabSources(field, settings.vocabularyLists).flatMap(({ terms }) => terms);
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
 * Catalogue one artefact via the active provider with a single prompt. The
 * image (when present) is inlined into the same call by the Rust side. Returns
 * per-field ranked suggestions. Throws on transport/HTTP errors so callers can
 * surface them — there is no demo fallback.
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
): Promise<Record<string, { value: string; confidence: number }[]>> {
  const rustProvider: RustProvider = {
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    apiFormat: provider.apiFormat ?? "openai",
  };
  const sharedInstruction = settings.systemPromptInstruction?.trim();
  // Part 2 of the system instructions: use the user's override if any, else the
  // built-in default. Resolved here so the default lives in one place.
  const effectiveContract = settings.systemPromptContractOverride?.trim() || _DEF_SYSTEM_PROMPT_CONTRACT;
  const rustFields: RustField[] = fields.map((f) => ({
    name: f.name,
    type: f.type,
    prompt: f.prompt,
    allowed: allowedTerms(f, settings),
  }));
  const rustArtefact: RustArtefact = {
    record,
    imagePath: imagePath || null,
    systemPrompt: sharedInstruction || "",
    systemPromptContract: effectiveContract,
  };
  const res = await invoke<RawCatalogueResult>("catalogue_artefact", {
    provider: rustProvider,
    fields: rustFields,
    artefact: rustArtefact,
    jobId: cancelKey,
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
 * Assemble the exact combined prompt `catalogueArtefact` would send for one
 * artefact, without making any network call. Used by the Settings "Prompt
 * Preview" tab. Resolves the effective contract (override or default) the same
 * way the real call does, so the preview never drifts. The row record is
 * runtime-only data Settings doesn't have, so it's passed empty — Rust renders
 * it as an `Artefact File information: {}` placeholder.
 */
export async function buildPromptsPreview(fields: CatalogueField[], settings: Settings): Promise<string> {
  const sharedInstruction = settings.systemPromptInstruction?.trim();
  const effectiveContract = settings.systemPromptContractOverride?.trim() || _DEF_SYSTEM_PROMPT_CONTRACT;
  const rustFields: RustField[] = fields.map((f) => ({
    name: f.name,
    type: f.type,
    prompt: f.prompt,
    allowed: allowedTerms(f, settings),
  }));
  const rustArtefact: RustArtefact = {
    record: {},
    imagePath: null,
    systemPrompt: sharedInstruction || "",
    systemPromptContract: effectiveContract,
  };
  return invoke<string>("build_prompts_preview", { fields: rustFields, artefact: rustArtefact });
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

/** True when a usable provider is configured and active. */
export function hasProvider(settings: Settings): settings is Settings & { activeProvider: string } {
  return !!activeProvider(settings);
}

/** Look up the active provider object. */
export function activeProvider(settings: Settings): Provider | undefined {
  if (!settings.activeProvider) return undefined;
  return settings.providers.find((p) => p.id === settings.activeProvider);
}
