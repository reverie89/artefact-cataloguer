// Pure vocabulary-source settings transforms. Every vocab mutation in
// actions.ts applies these through reducer-side functional updates
// (PATCH_SETTINGS), so each write composes onto the reducer's *current*
// settings instead of a render-time snapshot: rebuilding whole-settings
// objects after slow awaits (file staging, dialogs) used to clobber any write
// that committed in between — browsed files vanished from the card list.
// No React/Tauri imports: these run anywhere and unit-test as-is.

import type { StagedVocabFile } from "../lib/vocab";
import type { Settings, VocabEmbeddingStatus, VocabSource } from "./types";

/** Fresh "never embedded" record — the seed for new sources and the reset
 *  point for Flush embeddings. A factory so callers never share one instance. */
export function emptyEmbedding(): VocabEmbeddingStatus {
  return { status: "never", providerId: null, model: null, dimensions: null, lastSyncedAt: null, rowsEmbedded: null, lastError: null };
}

/** A synced index is stale once the content or column config beneath it has
 *  changed; every other status is left alone. */
export function markStaleIfSynced(e: VocabEmbeddingStatus): VocabEmbeddingStatus {
  return e.status === "synced" ? { ...e, status: "stale" } : e;
}

/** Immutably map one source by id; unrelated sources pass through untouched
 *  (and an unknown id is a no-op, never a dropped source). */
export function updateVocabSource(settings: Settings, id: string, fn: (v: VocabSource) => VocabSource): Settings {
  return { ...settings, vocabSources: settings.vocabSources.map((v) => (v.id === id ? fn(v) : v)) };
}

/** The empty source seeded by "Add vocabulary source" — into both the draft
 *  and persisted settings so later staged files have a real id to land under. */
export function newVocabSource(id: string): VocabSource {
  return { id, name: "", files: [], fields: [], ingestionField: null, labelField: null, badgeField: null, embedding: emptyEmbedding() };
}

/** Merge freshly staged files (+ their newly-detected columns) into a source,
 *  marking a synced index stale. Composes: two calls in a row keep both
 *  batches because it reads only the passed-in source. */
export function sourceWithAddedFiles(v: VocabSource, staged: StagedVocabFile[]): VocabSource {
  const files = [...v.files, ...staged.map((s) => ({ id: s.id, filename: s.filename, addedDate: s.addedDate, sizeBytes: s.sizeBytes, rowCountLast: s.rowCount }))];
  const existingNames = new Set(v.fields.map((f) => f.name));
  const newFieldNames = new Set(staged.flatMap((s) => s.detectedFields));
  const fields = [
    ...v.fields,
    ...[...newFieldNames].filter((n) => !existingNames.has(n)).map((name) => ({ name, includeForAI: true })),
  ];
  return { ...v, files, fields, embedding: markStaleIfSynced(v.embedding) };
}

/** Drop one staged file's record from a source, marking a synced index stale.
 *  Rust-side byte deletion happens before this; unknown filenames no-op. */
export function sourceWithRemovedFile(v: VocabSource, filename: string): VocabSource {
  return { ...v, files: v.files.filter((f) => f.filename !== filename), embedding: markStaleIfSynced(v.embedding) };
}

/** Remove a deleted source and prune every catalogue-field reference to it,
 *  so fields don't dangle ids pointing at a gone LanceDB table/file dir. */
export function withoutVocabSource(settings: Settings, id: string): Settings {
  return {
    ...settings,
    vocabSources: settings.vocabSources.filter((v) => v.id !== id),
    fields: settings.fields.map((f) => ({ ...f, vocabSources: f.vocabSources.filter((sid) => sid !== id) })),
  };
}

/** Reorder persisted sources to the given id sequence (drag result). Ids not
 *  present in settings are ignored, matching reorderVocab's draft-only guard. */
export function withReorderedVocabSources(settings: Settings, ids: string[]): Settings {
  const byId = new Map(settings.vocabSources.map((v) => [v.id, v] as const));
  const reordered = ids.map((id) => byId.get(id)).filter((v): v is VocabSource => !!v);
  return { ...settings, vocabSources: reordered };
}
