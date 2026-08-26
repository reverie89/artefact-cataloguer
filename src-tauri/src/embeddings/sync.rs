//! Vocab-sync pipeline: hashes staged rows into stable row ids, diffs them
//! against the persisted table, embeds only new/changed rows in batches,
//! upserts/deletes them, and streams `ac-vocab-sync` progress events.

use arrow_array::types::Float32Type;
use arrow_array::{FixedSizeListArray, RecordBatch, RecordBatchIterator, StringArray};
use arrow_schema::{DataType, Schema};
use lancedb::Table as LanceDbTable;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use crate::vocab_files::{list_source_files, parse_source_file, VocabSourceField};

use super::provider::{embed_texts, EmbeddingProvider, EMBED_BATCH_SIZE};
use super::store::{connect_db, existing_hashes, sql_quote, table_name, table_schema};

const SYNC_EVENT: &str = "ac-vocab-sync";

struct DiffedRow {
    term_key: String,
    term: String,
    columns_json: String,
    embed_text: String,
    row_hash: String,
    source_file: String,
}

/// Result of one `sync_vocab_source` run.
#[derive(Serialize)]
pub struct SyncResult {
    #[serde(rename = "rowsEmbedded")]
    pub rows_embedded: usize,
    #[serde(rename = "rowsReused")]
    pub rows_reused: usize,
    #[serde(rename = "rowsDeleted")]
    pub rows_deleted: usize,
    pub dimensions: u32,
    #[serde(rename = "totalRows")]
    pub total_rows: usize,
    /// Each staged file's own raw row count from this parse, keyed by filename
    /// — display-only, mirrored into `VocabSourceFile.rowCountLast` by the caller.
    #[serde(rename = "fileRowCounts")]
    pub file_row_counts: HashMap<String, usize>,
    /// Each file's row count as actually synced into the table (after empty-
    /// term filtering and cross-file term_key dedup) — display-only, mirrored
    /// into `VocabSourceFile.rowCountSyncedLast` by the caller.
    #[serde(rename = "fileSyncedCounts")]
    pub file_synced_counts: HashMap<String, usize>,
}

#[derive(Serialize, Clone)]
struct SyncProgressEvent {
    #[serde(rename = "sourceId")]
    source_id: String,
    #[serde(rename = "rowsDone")]
    rows_done: usize,
    #[serde(rename = "rowsTotal")]
    rows_total: usize,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Per-file breakdown of the source-wide `rows_done`/`rows_total`, keyed by
    /// filename. `total` is how many rows of that file actually need a fresh
    /// embed this pass (post-reuse-diff — not the raw parse count); `done` is
    /// how many of those have been embedded so far. Absent on a source with one
    /// file (no extra information beyond the source-wide totals).
    #[serde(rename = "fileProgress", skip_serializing_if = "Option::is_none")]
    file_progress: Option<HashMap<String, FileProgress>>,
}

#[derive(Serialize, Clone)]
struct FileProgress {
    #[serde(rename = "rowsDone")]
    rows_done: usize,
    #[serde(rename = "rowsTotal")]
    rows_total: usize,
}

/// Result of `diff_rows`: the deduped rows to sync, plus two per-file display
/// tallies (both keyed by filename) — `found` is each file's own raw row
/// count from this parse (pre-dedup, pre-empty-term-filter); `synced` is how
/// many of those rows actually end up attributed to that file in the table
/// after empty-term filtering and cross-file term_key dedup (a term repeated
/// across files is only ever attributed to the last file that defined it).
/// The two can legitimately differ, hence tracking both.
struct DiffedRows {
    rows: Vec<DiffedRow>,
    found: HashMap<String, usize>,
    synced: HashMap<String, usize>,
}

/// Stream-parse every staged file, hash each row (content + the current
/// fields-config, so toggling an Include-for-AI flag correctly forces a
/// re-embed even though the source bytes didn't change), and dedupe by
/// term_key across files (last file wins).
///
/// `term_field` doesn't need folding into `fields_config_hash`: changing it
/// changes which column supplies `term` *and* which column is excluded from
/// `columns`/`columns_json` (see `vocab_files::parse_source_file`), so every
/// affected row's `row_hash` already differs — the existing diff naturally
/// treats the old term_keys as deleted and the new ones as fresh.
fn diff_rows(
    source_id: &str,
    fields: &[VocabSourceField],
    term_field: Option<&str>,
) -> Result<DiffedRows, String> {
    let files = list_source_files(source_id)?;
    let fields_config_hash = {
        let mut sorted: Vec<(&str, bool)> = fields
            .iter()
            .map(|f| (f.name.as_str(), f.include_for_ai))
            .collect();
        sorted.sort();
        let repr = sorted
            .iter()
            .map(|(n, i)| format!("{n}={i}"))
            .collect::<Vec<_>>()
            .join("\u{1}");
        blake3::hash(repr.as_bytes()).to_hex().to_string()
    };
    let include: HashSet<&str> = fields
        .iter()
        .filter(|f| f.include_for_ai)
        .map(|f| f.name.as_str())
        .collect();

    let mut by_key: HashMap<String, DiffedRow> = HashMap::new();
    let mut found: HashMap<String, usize> = HashMap::new();
    for (filename, path) in files {
        let rows = parse_source_file(&path, &filename, term_field)?;
        found.insert(filename.clone(), rows.len());
        for row in rows {
            let term_key = row.term.trim().to_lowercase();
            if term_key.is_empty() {
                continue;
            }
            let columns_map: serde_json::Map<String, Value> = row
                .columns
                .iter()
                .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                .collect();
            let columns_json = serde_json::to_string(&columns_map).unwrap_or_default();
            let embed_text = std::iter::once(row.term.clone())
                .chain(
                    row.columns
                        .iter()
                        .filter(|(k, _)| include.contains(k.as_str()))
                        .map(|(_, v)| v.clone()),
                )
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(". ");
            let raw_repr = format!("{}\u{1}{}", row.term, columns_json);
            let row_hash = blake3::hash(format!("{raw_repr}\u{1}{fields_config_hash}").as_bytes())
                .to_hex()
                .to_string();
            by_key.insert(
                term_key.clone(),
                DiffedRow {
                    term_key,
                    term: row.term,
                    columns_json,
                    embed_text,
                    row_hash,
                    source_file: row.source_file,
                },
            );
        }
    }
    // Zero-fill every staged file so one whose rows were all filtered out (or
    // lost a cross-file term_key dedup) reports an explicit 0 rather than
    // being absent from the map — the caller can't otherwise tell "0 synced"
    // from "no sync result for this file at all".
    let mut synced: HashMap<String, usize> = found.keys().map(|f| (f.clone(), 0)).collect();
    for row in by_key.values() {
        *synced.entry(row.source_file.clone()).or_insert(0) += 1;
    }
    Ok(DiffedRows {
        rows: by_key.into_values().collect(),
        found,
        synced,
    })
}

/// Run (or resume) an incremental sync: diff staged files against the table,
/// embed only new/changed rows, upsert them, and delete rows whose content is
/// gone. Emits `ac-vocab-sync` progress once per batch. Cancellable via
/// `cancel_vocab_sync` — already-upserted batches stay committed, so a
/// cancelled sync safely resumes from the diff next time.
pub(crate) async fn run_sync(
    app: &AppHandle,
    source_id: &str,
    provider: &EmbeddingProvider,
    fields: &[VocabSourceField],
    term_field: Option<&str>,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<SyncResult, String> {
    let name = table_name(source_id);
    let diffed = diff_rows(source_id, fields, term_field)?;
    let fresh = diffed.rows;
    let db = connect_db().await?;
    let existing = existing_hashes(&db, &name).await?;

    let fresh_keys: HashSet<&str> = fresh.iter().map(|r| r.term_key.as_str()).collect();
    let deleted: Vec<&str> = existing
        .keys()
        .filter(|k| !fresh_keys.contains(k.as_str()))
        .map(|k| k.as_str())
        .collect();

    let mut to_embed = Vec::new();
    let mut reused = 0usize;
    for row in &fresh {
        match existing.get(&row.term_key) {
            Some(h) if *h == row.row_hash => reused += 1,
            _ => to_embed.push(row),
        }
    }

    let total = to_embed.len();
    // Per-file breakdown of `to_embed`: how many rows of each staged file need
    // a fresh embed this pass (post-reuse-diff — not the raw parse count).
    // Zero-fill from `diffed.found` so a file with nothing to embed still
    // appears as 0/0 rather than dropping out of the per-file view mid-sync.
    let to_embed_by_file: HashMap<String, usize> = {
        let mut m: HashMap<String, usize> = diffed.found.keys().map(|f| (f.clone(), 0)).collect();
        for row in &to_embed {
            *m.entry(row.source_file.clone()).or_insert(0) += 1;
        }
        m
    };
    let mut done_by_file: HashMap<String, usize> =
        to_embed_by_file.keys().map(|f| (f.clone(), 0)).collect();
    let emit = |done: usize,
                status: &'static str,
                error: Option<String>,
                done_by_file: &HashMap<String, usize>| {
        let file_progress = Some(
            to_embed_by_file
                .iter()
                .map(|(f, &t)| {
                    (
                        f.clone(),
                        FileProgress {
                            rows_done: *done_by_file.get(f).unwrap_or(&0),
                            rows_total: t,
                        },
                    )
                })
                .collect(),
        );
        let _ = app.emit(
            SYNC_EVENT,
            SyncProgressEvent {
                source_id: source_id.to_string(),
                rows_done: done,
                rows_total: total,
                status,
                error,
                file_progress,
            },
        );
    };
    emit(0, "syncing", None, &done_by_file);

    let mut table: Option<LanceDbTable> = None;
    let mut dimensions: u32 = 0;
    let mut embedded = 0usize;

    for chunk in to_embed.chunks(EMBED_BATCH_SIZE) {
        if cancel_flag.load(Ordering::SeqCst) {
            emit(
                embedded,
                "error",
                Some("cancelled".to_string()),
                &done_by_file,
            );
            return Err("__ac_vocab_sync_cancelled__".to_string());
        }
        let texts: Vec<String> = chunk.iter().map(|r| r.embed_text.clone()).collect();
        let vectors = match embed_texts(provider, &texts).await {
            Ok(v) => v,
            Err(e) => {
                emit(embedded, "error", Some(e.clone()), &done_by_file);
                return Err(e);
            }
        };
        if dimensions == 0 {
            dimensions = vectors.first().map(|v| v.len()).unwrap_or(0) as u32;
            if dimensions == 0 {
                let e = "embedding call returned no vector".to_string();
                emit(embedded, "error", Some(e.clone()), &done_by_file);
                return Err(e);
            }
        }
        let schema = table_schema(dimensions as i32);
        let now = chrono_now();
        let batch = build_record_batch(&schema, chunk, &vectors, &now)?;
        let iter = RecordBatchIterator::new(vec![Ok(batch)].into_iter(), schema.clone());

        table = Some(match table.take() {
            Some(t) => {
                let mut mi = t.merge_insert(&["term_key"]);
                mi.when_matched_update_all(None)
                    .when_not_matched_insert_all();
                mi.execute(Box::new(iter))
                    .await
                    .map_err(|e| e.to_string())?;
                t
            }
            None => {
                if db
                    .table_names()
                    .execute()
                    .await
                    .map_err(|e| e.to_string())?
                    .contains(&name)
                {
                    let t = db
                        .open_table(&name)
                        .execute()
                        .await
                        .map_err(|e| e.to_string())?;
                    let mut mi = t.merge_insert(&["term_key"]);
                    mi.when_matched_update_all(None)
                        .when_not_matched_insert_all();
                    mi.execute(Box::new(iter))
                        .await
                        .map_err(|e| e.to_string())?;
                    t
                } else {
                    db.create_table(&name, iter)
                        .execute()
                        .await
                        .map_err(|e| e.to_string())?
                }
            }
        });

        embedded += chunk.len();
        for r in chunk {
            *done_by_file.entry(r.source_file.clone()).or_insert(0) += 1;
        }
        emit(embedded, "syncing", None, &done_by_file);
    }

    // Delete rows whose content is gone, and prune per removed rows even if
    // nothing needed (re-)embedding this pass.
    let mut deleted_count = 0usize;
    if !deleted.is_empty() {
        let t = match table {
            Some(t) => Some(t),
            None => {
                if db
                    .table_names()
                    .execute()
                    .await
                    .map_err(|e| e.to_string())?
                    .contains(&name)
                {
                    Some(
                        db.open_table(&name)
                            .execute()
                            .await
                            .map_err(|e| e.to_string())?,
                    )
                } else {
                    None
                }
            }
        };
        if let Some(t) = t {
            let filter = format!(
                "term_key IN ({})",
                deleted
                    .iter()
                    .map(|k| sql_quote(k))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            t.delete(&filter).await.map_err(|e| e.to_string())?;
            deleted_count = deleted.len();
            table = Some(t);
        }
    }
    let _ = table;

    // Dimensions weren't learned this pass if every row was reused — read them
    // back from the table's schema so the caller can still record them.
    if dimensions == 0
        && db
            .table_names()
            .execute()
            .await
            .map_err(|e| e.to_string())?
            .contains(&name)
    {
        let t = db
            .open_table(&name)
            .execute()
            .await
            .map_err(|e| e.to_string())?;
        if let Ok(schema) = t.schema().await {
            if let Ok(f) = schema.field_with_name("vector") {
                if let DataType::FixedSizeList(_, w) = f.data_type() {
                    dimensions = *w as u32;
                }
            }
        }
    }

    emit(embedded, "done", None, &done_by_file);
    Ok(SyncResult {
        rows_embedded: embedded,
        rows_reused: reused,
        rows_deleted: deleted_count,
        dimensions,
        total_rows: fresh.len(),
        file_row_counts: diffed.found,
        file_synced_counts: diffed.synced,
    })
}

fn build_record_batch(
    schema: &Arc<Schema>,
    rows: &[&DiffedRow],
    vectors: &[Vec<f32>],
    now: &str,
) -> Result<RecordBatch, String> {
    let dim = match schema
        .field_with_name("vector")
        .map(|f| f.data_type().clone())
    {
        Ok(DataType::FixedSizeList(_, w)) => w,
        _ => return Err("bad vector schema".to_string()),
    };
    let term_key = StringArray::from(rows.iter().map(|r| r.term_key.clone()).collect::<Vec<_>>());
    let term = StringArray::from(rows.iter().map(|r| r.term.clone()).collect::<Vec<_>>());
    let columns_json = StringArray::from(
        rows.iter()
            .map(|r| r.columns_json.clone())
            .collect::<Vec<_>>(),
    );
    let embed_text = StringArray::from(
        rows.iter()
            .map(|r| r.embed_text.clone())
            .collect::<Vec<_>>(),
    );
    let row_hash = StringArray::from(rows.iter().map(|r| r.row_hash.clone()).collect::<Vec<_>>());
    let source_file = StringArray::from(
        rows.iter()
            .map(|r| r.source_file.clone())
            .collect::<Vec<_>>(),
    );
    let updated_at = StringArray::from(vec![now.to_string(); rows.len()]);
    let vector = FixedSizeListArray::from_iter_primitive::<Float32Type, _, _>(
        vectors.iter().map(|v| Some(v.iter().map(|f| Some(*f)))),
        dim,
    );
    RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(term_key),
            Arc::new(term),
            Arc::new(columns_json),
            Arc::new(embed_text),
            Arc::new(row_hash),
            Arc::new(vector),
            Arc::new(source_file),
            Arc::new(updated_at),
        ],
    )
    .map_err(|e| e.to_string())
}

fn chrono_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}
