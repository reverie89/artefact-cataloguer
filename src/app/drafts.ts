// Shared helpers for the settings-tab draft lifecycle.
//
// The four settings tabs (Fields, Vocab, Providers, Artefact File) each keep an
// in-memory draft and compute a "dirty" flag to gate the Save/Discard buttons.
// The comparison logic was duplicated four times with the same reason to change;
// these helpers consolidate it. Every tab compares by id, not position: every
// tab's reorder action already persists straight to disk (see reorderFields/
// reorderVocab/reorderAF in actions.ts), so a pending reorder never exists to
// flag — and every tab's own per-row dirty badge is id-keyed too, so a
// positional comparison could flag the tab dirty with no row to show it on.

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

/** True when the two lists differ, keyed by `idKey` (a reorder is NOT dirty).
 *  A draft item with no saved counterpart (newly added) counts as dirty. */
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
      // Id-keyed, not positional: reorderFields persists immediately (mirrors
      // reorderVocab/reorderAF below), so a pending reorder never exists here —
      // comparing by position would flag the tab dirty whenever the draft and
      // settings arrays are momentarily out of step in order (e.g. across the
      // save round-trip) even though no row actually differs, and no per-row
      // badge would reflect it since CataloguingFieldsTab's own dirty check is id-keyed.
      return differById(d.fields, settings.fields, "id", ["name", "type", "layout", "prompt", "vocabSources"]);
    }
    case "vocab": {
      const d = state.vocabDraft;
      if (!d) return false;
      // Id-keyed, not positional — see the "fields" case above for why.
      // Files/fields/sync status have real Rust-side disk effects and persist
      // immediately (mirrors reorderVocab/removeVocabList) — only the Display
      // Name is draft-buffered, so that's all that's compared here.
      return differById(d.vocabSources, settings.vocabSources, "id", ["name"]);
    }
    case "modelProviders": {
      // Providers are id-keyed; the draft is dirty when any provider is new,
      // removed, content-edited, or the active selection flipped. Both the chat
      // and embedding provider lists live on this one tab, so either draft
      // being dirty makes the tab dirty.
      const d = state.providerDraft;
      const chatDirty = !!d && (differById(
        d.providers,
        settings.providers.map((p) => ({
          id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model,
          apiFormat: (p.apiFormat ?? "openai"), modelOptions: p.modelOptions ?? [],
          connStatus: p.connStatus ?? "untested",
        })),
        "id",
        ["name", "baseUrl", "apiKey", "model", "apiFormat", "modelOptions", "connStatus"],
      ) || d.activeProvider !== settings.activeProvider);
      const ed = state.embProviderDraft;
      const embDirty = !!ed && (differById(
        ed.providers,
        settings.embeddingProviders.map((p) => ({
          id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model,
          apiFormat: (p.apiFormat ?? "openai"),
          modelOptions: p.modelOptions ?? [], dimensions: p.dimensions ?? null,
          connStatus: p.connStatus ?? "untested",
        })),
        "id",
        ["name", "baseUrl", "apiKey", "model", "apiFormat", "modelOptions", "dimensions", "connStatus"],
      ) || ed.activeProvider !== settings.activeEmbeddingProvider);
      return chatDirty || embDirty;
    }
    case "artefactFile": {
      const d = state.artefactDraft;
      if (!d) return false;
      // Vision-analysis system instruction is draft-buffered like the catalogue
      // tab's Part-1 instruction.
      if ((d.visionSystemPromptInstruction ?? "") !== (settings.visionSystemPromptInstruction ?? "")) return true;
      // Id-keyed, not positional — see the "fields" case above for why.
      const savedFields = (settings.artefactFields || []).map((f) => ({ ...f, description: f.description ?? "", prompt: f.prompt ?? "" }));
      const draftFields = d.artefactFields.map((f) => ({ ...f, description: f.description ?? "", prompt: f.prompt ?? "" }));
      return differById(draftFields, savedFields, "id", ["name", "description", "prompt", "includeInExport"]);
    }
    case "about":
    default:
      return false;
  }
}

