// Shared helpers for the settings-tab draft lifecycle.
//
// The four settings tabs (Fields, Vocab, Providers, Artefact File) each keep an
// in-memory draft and compute a "dirty" flag to gate the Save/Discard buttons.
// The comparison logic was duplicated four times with the same reason to change;
// these helpers consolidate it. Two strategies are needed because some tabs are
// order-significant (a reorder counts as dirty) and some compare by id.

import type { AppState } from "./state";
import type { SettingsTab } from "./types";

/** True when two values differ, treating equal-length arrays of primitives as
 *  equal when their elements match positionally (so `vocabSources`/`modelOptions`
 *  compare by content, not by reference). */
function valueDiffers(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return true;
    return a.some((x, i) => x !== b[i]);
  }
  return a !== b;
}

/** True when two items differ on any of the given keys. `keys` defaults to
 *  every own key of `a`. */
export function fieldsDiffer<T>(a: T, b: T, keys?: readonly (keyof T)[]): boolean {
  const ks = keys ?? (Object.keys(a as unknown as Record<string, unknown>) as (keyof T)[]);
  const ar = a as unknown as Record<keyof T, unknown>;
  const br = b as unknown as Record<keyof T, unknown>;
  return ks.some((k) => valueDiffers(ar[k], br[k]));
}

/** True when the two lists differ, comparing positionally (a reorder is dirty).
 *  Used by order-significant drafts (Fields, Artefact File). */
export function differByOrder<T>(draft: readonly T[], saved: readonly T[], keys?: readonly (keyof T)[]): boolean {
  if (draft.length !== saved.length) return true;
  for (let i = 0; i < draft.length; i++) {
    const b = saved[i];
    if (!b) return true;
    if (fieldsDiffer(draft[i], b, keys)) return true;
  }
  return false;
}

/** True when the two lists differ, keyed by `idKey` (a reorder is NOT dirty).
 *  Used by id-keyed drafts (Providers, Vocab). A draft item with no saved
 *  counterpart (newly added) counts as dirty. */
export function differById<T>(draft: readonly T[], saved: readonly T[], idKey: keyof T, keys?: readonly (keyof T)[]): boolean {
  if (draft.length !== saved.length) return true;
  const byId = new Map(saved.map((item) => [item[idKey], item] as const));
  for (const a of draft) {
    const b = byId.get(a[idKey]);
    if (!b) return true;
    if (fieldsDiffer(a, b, keys)) return true;
  }
  return false;
}

/** True when the given settings tab has pending (unsaved) draft changes. Used
 *  to guard navigation: switching tabs or leaving Settings while a tab is dirty
 *  prompts the user to discard or stay.
 *
 *  Structural changes (reorder, delete) now persist immediately, so the draft
 *  is only dirty when it has new unsaved rows or uncommitted per-card content
 *  edits. Per-card Save/Discard sync the draft back to clean, so a non-null
 *  draft isn't enough on its own — we diff against persisted settings. */
export function isTabDirty(state: AppState, tab: SettingsTab): boolean {
  const { settings } = state;
  switch (tab) {
    case "fields": {
      const d = state.fieldDraft;
      if (!d) return false;
      if (d.systemPromptInstruction !== settings.systemPromptInstruction) return true;
      if ((d.systemPromptContractOverride ?? "") !== (settings.systemPromptContractOverride ?? "")) return true;
      return differByOrder(d.fields, settings.fields, ["id", "name", "type", "layout", "prompt", "vocabSources"]);
    }
    case "vocab": {
      const d = state.vocabDraft;
      if (!d) return false;
      // Order is now significant (reorder is a structural change), so compare
      // positionally like FieldsTab does rather than by id alone.
      return differByOrder(d.vocabularyLists, settings.vocabularyLists, ["id", "name", "filename", "terms", "uploadDate"]);
    }
    case "ai": {
      // Providers are id-keyed; the draft is dirty when any provider is new,
      // removed, content-edited, or the active selection flipped.
      const d = state.providerDraft;
      if (!d) return false;
      return differById(
        d.providers,
        settings.providers.map((p) => ({
          id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model,
          apiFormat: (p.apiFormat ?? "openai"), modelOptions: p.modelOptions ?? [],
          connStatus: p.connStatus ?? "untested",
        })),
        "id",
        ["name", "baseUrl", "apiKey", "model", "apiFormat", "modelOptions", "connStatus"],
      ) || d.activeProvider !== settings.activeProvider;
    }
    case "artefactFile": {
      const d = state.artefactDraft;
      if (!d) return false;
      const savedFields = (settings.artefactFields || []).map((f) => ({ ...f, description: f.description ?? "", includeForAI: f.includeForAI ?? true }));
      const draftFields = d.artefactFields.map((f) => ({ ...f, description: f.description ?? "", includeForAI: f.includeForAI ?? true }));
      return differByOrder(draftFields, savedFields, ["id", "name", "required", "description", "includeForAI"]);
    }
    case "about":
    default:
      return false;
  }
}

