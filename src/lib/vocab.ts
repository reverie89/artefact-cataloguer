// Frontend wrapper around the Rust vocabulary-source commands (staging,
// header detection, sync/flush, download). Mirrors lib/ai.ts's thin
// invoke() pattern — the actual file I/O, streaming parse, diffing, and
// embedding-API calls all happen in Rust (src-tauri/src/vocab_files.rs,
// src-tauri/src/embeddings.rs), since a source's files can be 15MB+/millions
// of rows and must never be held wholesale in the renderer.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { EmbeddingProvider, VocabSourceField } from "../app/types";

/** Result of staging one file into a source: its persisted metadata plus
 *  every column detected from its header row (the user picks which one is
 *  used for ingestion in Settings — see `VocabSource.ingestionField`). */
export interface StagedVocabFile {
  id: string;
  filename: string;
  addedDate: string;
  sizeBytes: number;
  detectedFields: string[];
  rowCount: number;
}

/** Progress/outcome of one `sync_vocab_source` run, emitted on the
 *  "ac-vocab-sync" event once per completed batch — mirrors the
 *  VisionStageEvent bridge in App.tsx for the existing "ac-logs" stream. */
export interface VocabSyncEvent {
  sourceId: string;
  rowsDone: number;
  rowsTotal: number;
  status: "syncing" | "done" | "error";
  error?: string;
}

/** Final tally returned when `sync_vocab_source` resolves. */
export interface VocabSyncResult {
  rowsEmbedded: number;
  rowsReused: number;
  rowsDeleted: number;
  dimensions: number;
  totalRows: number;
  /** Each staged file's own raw row count from this parse, keyed by filename
   *  — mirrored into `VocabSourceFile.rowCountLast` by the caller. */
  fileRowCounts: Record<string, number>;
  /** Each file's row count as actually synced into the index (after empty-
   *  term filtering and cross-file term dedup) — mirrored into
   *  `VocabSourceFile.rowCountSyncedLast` by the caller. */
  fileSyncedCounts: Record<string, number>;
}

interface RustEmbeddingProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: string;
}

function toRustProvider(p: EmbeddingProvider): RustEmbeddingProvider {
  return { name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model, apiFormat: p.apiFormat ?? "openai" };
}

/** Stage one uploaded file into a vocabulary source: persist its bytes beside
 *  the binary and detect its header columns. No parsing/embedding yet — that
 *  happens on the next `syncVocabSource` call. */
export async function stageVocabFile(sourceId: string, filename: string, bytes: Uint8Array): Promise<StagedVocabFile> {
  return invoke<StagedVocabFile>("stage_vocab_file", { sourceId, filename, bytes: Array.from(bytes) });
}

/** Remove one staged file from a source (its persisted bytes are deleted). */
export async function removeVocabFile(sourceId: string, filename: string): Promise<void> {
  await invoke("remove_vocab_file", { sourceId, filename });
}

/** Remove a source's whole file directory and drop its LanceDB table. */
export async function deleteVocabSourceFiles(sourceId: string): Promise<void> {
  await invoke("delete_vocab_source", { sourceId });
}

/** Read a staged file's bytes back, for the Vocabulary Lists tab's Download button. */
export async function downloadVocabFile(sourceId: string, filename: string): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("download_vocab_file", { sourceId, filename });
  return new Uint8Array(bytes);
}

/**
 * Run (or resume) an incremental sync: stream-parse every staged file, hash
 * each row, embed only new/changed rows via `provider`, upsert into the
 * source's LanceDB table, and delete rows for removed content. `onProgress`
 * is called once per completed batch; the returned promise resolves with the
 * final tally. Cancellable via {@link cancelVocabSync} with the same
 * `sourceId`.
 */
export async function syncVocabSource(
  sourceId: string,
  provider: EmbeddingProvider,
  fields: VocabSourceField[],
  termField: string | null,
  onProgress?: (ev: VocabSyncEvent) => void
): Promise<VocabSyncResult> {
  let unlisten: UnlistenFn | undefined;
  try {
    if (onProgress) {
      unlisten = await listen<VocabSyncEvent>("ac-vocab-sync", (ev) => {
        if (ev.payload.sourceId === sourceId) onProgress(ev.payload);
      });
    }
    return await invoke<VocabSyncResult>("sync_vocab_source", {
      sourceId,
      provider: toRustProvider(provider),
      fields,
      termField,
    });
  } finally {
    if (unlisten) unlisten();
  }
}

/** Cancel an in-flight sync for `sourceId`. Already-upserted batches stay
 *  committed — the next sync resumes from where this one left off. */
export async function cancelVocabSync(sourceId: string): Promise<void> {
  await invoke("cancel_vocab_sync", { sourceId });
}

/** Drop just this source's LanceDB table (files + settings metadata are left
 *  to the caller to reset — see actions.ts flushVocabSource). */
export async function flushVocabSource(sourceId: string): Promise<void> {
  await invoke("flush_vocab_source", { sourceId });
}

/** Remove the whole vocab_db directory — every source's embedded index. */
export async function flushAllVocab(): Promise<void> {
  await invoke("flush_all_vocab");
}

/** One row of a source's synced table, for the manual vocab-picker dropdown:
 *  the term plus its other detected columns, so `vterms` (app/styles.ts) can
 *  resolve the source's configured label/badge columns. */
export interface VocabTermEntry {
  term: string;
  columns: Record<string, string>;
}

interface RustVocabTermRow {
  term: string;
  columnsJson: string;
}

/** Full listing of every term in one source's synced table, for the manual
 *  vocab-picker dropdown. Empty array when the source has never been synced. */
export async function listVocabTerms(sourceId: string): Promise<VocabTermEntry[]> {
  const rows = await invoke<RustVocabTermRow[]>("list_vocab_terms", { sourceId });
  return rows.map((r) => {
    let columns: Record<string, string> = {};
    try {
      columns = JSON.parse(r.columnsJson) as Record<string, string>;
    } catch {
      // Malformed columns_json shouldn't hide the term itself from the picker.
    }
    return { term: r.term, columns };
  });
}
