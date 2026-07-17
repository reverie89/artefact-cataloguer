//! Vocabulary-source embeddings: one local LanceDB table per source
//! (`<exe_dir>/vocab_db/vocab_<sourceId>`), an incremental sync that diffs
//! staged files against the table by row hash (only new/changed rows are
//! sent to the embedding API), and the nearest-neighbour search used at
//! parse time to build a candidate shortlist instead of the old full-list
//! prompt (wired into `ai.rs` in a later pass).
//!
//! LanceDB is embedded (no server) and stores each table as Lance files on
//! disk — a natural fit beside the existing `exe_dir()`-relative persistence
//! used by `settings.rs`/`images.rs`.

use arrow_array::types::Float32Type;
use arrow_array::{Array, FixedSizeListArray, RecordBatch, RecordBatchIterator, StringArray};
use arrow_schema::{DataType, Field, Schema};
use futures::TryStreamExt;
use lancedb::query::{ExecutableQuery, QueryBase};
use lancedb::{connect, Connection, DistanceType, Table as LanceDbTable};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use base64::Engine;

use crate::ai::{http_client, strip_models_prefix, trim_trailing_slash, ImageData};
use crate::settings::exe_dir;
use crate::vocab_files::{list_source_files, parse_source_file, VocabSourceField};

const VOCAB_DB_DIR: &str = "vocab_db";
const EMBED_BATCH_SIZE: usize = 64;
const SYNC_EVENT: &str = "ac-vocab-sync";

pub fn vocab_db_dir() -> PathBuf {
    exe_dir().join(VOCAB_DB_DIR)
}

fn table_name(source_id: &str) -> String {
    format!("vocab_{source_id}")
}

/// Coarse, poll-able cancellation flags for in-flight syncs, keyed by source
/// id. Unlike `ai::CancelRegistry` (a one-shot channel that aborts a single
/// in-flight HTTP call), a sync spans many sequential batches/writes, so a
/// flag checked between batches — leaving the current batch's write to finish
/// cleanly — is the safer shape: it guarantees a cancelled sync never leaves
/// the table mid-write, and the next sync simply resumes from the diff.
pub type SyncCancelRegistry = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

pub fn default_sync_registry() -> SyncCancelRegistry {
    Arc::new(Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn cancel_vocab_sync(
    registry: State<'_, SyncCancelRegistry>,
    source_id: String,
) -> Result<(), String> {
    if let Some(flag) = registry
        .lock()
        .map_err(|e| format!("cancel registry poisoned: {e}"))?
        .get(&source_id)
    {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

// --- embedding provider + HTTP calls ----------------------------------------

/// Which API family an embedding provider speaks. Anthropic has no
/// embeddings API, so this is a subset of `ai::ApiFormat`.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum EmbeddingApiFormat {
    #[serde(rename = "openai")]
    #[default]
    OpenAi,
    #[serde(rename = "gemini")]
    Gemini,
}

/// One embedding provider, mirroring the frontend `EmbeddingProvider` type.
#[derive(Deserialize, Clone)]
pub struct EmbeddingProvider {
    #[allow(dead_code)]
    pub name: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    pub model: String,
    #[serde(rename = "apiFormat", default)]
    pub api_format: EmbeddingApiFormat,
    /// User-declared capability, checked before attempting the M5 image-
    /// embedding call (see `ai::retrieve_shortlists`). A hint, not a
    /// guarantee — a rejected image call still falls back to text-only.
    #[serde(rename = "supportsImageInput", default)]
    pub supports_image_input: bool,
}

#[derive(Serialize)]
pub struct EmbeddingConnectionTest {
    pub ok: String,
    pub models: Vec<String>,
    pub dimensions: u32,
}

/// Embed a batch of texts against the given provider's `/embeddings`
/// (OpenAI-shaped) or `batchEmbedContents` (Gemini-shaped) endpoint. Returns
/// one vector per input text, in the same order.
pub(crate) async fn embed_texts(
    provider: &EmbeddingProvider,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let base = trim_trailing_slash(&provider.base_url);
    let client = http_client(Duration::from_secs(60))?;
    match provider.api_format {
        EmbeddingApiFormat::OpenAi => {
            let url = base.clone();
            let body = serde_json::json!({ "model": provider.model, "input": texts });
            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", provider.api_key))
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("embed request failed: {e}"))?;
            let status = resp.status();
            let text = resp
                .text()
                .await
                .map_err(|e| format!("embed response read failed: {e}"))?;
            if !status.is_success() {
                return Err(format!("HTTP {}: {}", status.as_u16(), text));
            }
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| format!("embed response parse failed: {e}"))?;
            let data = v
                .get("data")
                .and_then(Value::as_array)
                .ok_or("embed response missing data")?;
            let mut out = vec![Vec::new(); texts.len()];
            for item in data {
                let idx = item.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let emb = item
                    .get("embedding")
                    .and_then(Value::as_array)
                    .ok_or("embed item missing embedding")?;
                if idx < out.len() {
                    out[idx] = emb
                        .iter()
                        .filter_map(Value::as_f64)
                        .map(|f| f as f32)
                        .collect();
                }
            }
            Ok(out)
        }
        EmbeddingApiFormat::Gemini => {
            let url = format!("{base}/v1beta/models/{}:batchEmbedContents", provider.model);
            let requests: Vec<Value> = texts
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "model": format!("models/{}", provider.model),
                        "content": { "parts": [{ "text": t }] }
                    })
                })
                .collect();
            let body = serde_json::json!({ "requests": requests });
            let resp = client
                .post(&url)
                .header("x-goog-api-key", &provider.api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("embed request failed: {e}"))?;
            let status = resp.status();
            let text = resp
                .text()
                .await
                .map_err(|e| format!("embed response read failed: {e}"))?;
            if !status.is_success() {
                return Err(format!("HTTP {}: {}", status.as_u16(), text));
            }
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| format!("embed response parse failed: {e}"))?;
            let embeddings = v
                .get("embeddings")
                .and_then(Value::as_array)
                .ok_or("embed response missing embeddings")?;
            Ok(embeddings
                .iter()
                .map(|e| {
                    e.get("values")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_f64)
                                .map(|f| f as f32)
                                .collect()
                        })
                        .unwrap_or_default()
                })
                .collect())
        }
    }
}

/// Embed one image (M5). Only meaningful when `provider.supports_image_input`
/// is true (a genuinely multimodal embedding model) — the caller is
/// responsible for that check; this function just makes the call and lets a
/// text-only model's rejection surface as a normal `Err`, so the caller can
/// fall back to text-only retrieval for that row.
///
/// Reuses the same base64 image encoding used for chat completions
/// (`ai::build_completion_body`), but targets the embeddings endpoint: an
/// `image_url` content part for OpenAI-shaped providers, an `inline_data`
/// part for Gemini-shaped ones — the same content-block shapes those APIs use
/// for chat images, since most OpenAI-compatible multimodal-embedding servers
/// (self-hosted CLIP-style servers, etc.) accept the identical shape on
/// `/embeddings`.
pub(crate) async fn embed_image(
    provider: &EmbeddingProvider,
    image: &ImageData,
) -> Result<Vec<f32>, String> {
    let base = trim_trailing_slash(&provider.base_url);
    let client = http_client(Duration::from_secs(60))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&image.bytes);
    match provider.api_format {
        EmbeddingApiFormat::OpenAi => {
            let url = base.clone();
            let data_url = format!("data:{};base64,{}", image.mime, b64);
            let body = serde_json::json!({
                "model": provider.model,
                "input": [{ "type": "image_url", "image_url": { "url": data_url } }]
            });
            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", provider.api_key))
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("image embed request failed: {e}"))?;
            let status = resp.status();
            let text = resp
                .text()
                .await
                .map_err(|e| format!("image embed response read failed: {e}"))?;
            if !status.is_success() {
                return Err(format!("HTTP {}: {}", status.as_u16(), text));
            }
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| format!("image embed response parse failed: {e}"))?;
            let emb = v
                .get("data")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|item| item.get("embedding"))
                .and_then(Value::as_array)
                .ok_or("image embed response missing embedding")?;
            Ok(emb
                .iter()
                .filter_map(Value::as_f64)
                .map(|f| f as f32)
                .collect())
        }
        EmbeddingApiFormat::Gemini => {
            let url = format!("{base}/v1beta/models/{}:batchEmbedContents", provider.model);
            let body = serde_json::json!({
                "requests": [{
                    "model": format!("models/{}", provider.model),
                    "content": { "parts": [{ "inline_data": { "mime_type": image.mime, "data": b64 } }] }
                }]
            });
            let resp = client
                .post(&url)
                .header("x-goog-api-key", &provider.api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("image embed request failed: {e}"))?;
            let status = resp.status();
            let text = resp
                .text()
                .await
                .map_err(|e| format!("image embed response read failed: {e}"))?;
            if !status.is_success() {
                return Err(format!("HTTP {}: {}", status.as_u16(), text));
            }
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| format!("image embed response parse failed: {e}"))?;
            let emb = v
                .get("embeddings")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|item| item.get("values"))
                .and_then(Value::as_array)
                .ok_or("image embed response missing values")?;
            Ok(emb
                .iter()
                .filter_map(Value::as_f64)
                .map(|f| f as f32)
                .collect())
        }
    }
}

/// Ping the embedding provider: list advertised models (best-effort — some
/// gateways don't expose this) and, once a model has been picked, perform one
/// real embed call, which is both the genuine connectivity check and how the
/// vector width is learned. Two-phase so the UI can bootstrap the model
/// dropdown from a first call with no model selected: called with an empty
/// `model`, this only lists models (mirrors `ai::test_connection`); called
/// again once the user has picked one, it also validates that model via a
/// real embed call.
#[tauri::command]
pub async fn test_embedding_connection(
    provider: EmbeddingProvider,
) -> Result<EmbeddingConnectionTest, String> {
    let base = trim_trailing_slash(&provider.base_url);
    let client = http_client(Duration::from_secs(20))?;
    let models_url = match provider.api_format {
        EmbeddingApiFormat::OpenAi => format!("{base}/models"),
        EmbeddingApiFormat::Gemini => format!("{base}/v1beta/models"),
    };
    let mut req = client.get(&models_url);
    req = match provider.api_format {
        EmbeddingApiFormat::OpenAi => {
            req.header("Authorization", format!("Bearer {}", provider.api_key))
        }
        EmbeddingApiFormat::Gemini => req.header("x-goog-api-key", provider.api_key.clone()),
    };
    let mut models = Vec::new();
    let mut list_error: Option<String> = None;
    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            match resp.text().await {
                Ok(text) => {
                    if status.is_success() {
                        if let Ok(v) = serde_json::from_str::<Value>(&text) {
                            models = match provider.api_format {
                                EmbeddingApiFormat::Gemini => v
                                    .get("models")
                                    .and_then(Value::as_array)
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|m| {
                                                m.get("name")
                                                    .and_then(Value::as_str)
                                                    .map(strip_models_prefix)
                                            })
                                            .collect()
                                    })
                                    .unwrap_or_default(),
                                EmbeddingApiFormat::OpenAi => v
                                    .get("data")
                                    .and_then(Value::as_array)
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|m| {
                                                m.get("id")
                                                    .and_then(Value::as_str)
                                                    .map(String::from)
                                            })
                                            .collect()
                                    })
                                    .unwrap_or_default(),
                            };
                            models.sort();
                        }
                    } else {
                        list_error = Some(format!("HTTP {}: {}", status.as_u16(), text));
                    }
                }
                Err(e) => list_error = Some(format!("response body read failed: {e}")),
            }
        }
        Err(e) => list_error = Some(format!("request failed: {e}")),
    }
    if provider.model.trim().is_empty() {
        // No model yet, so this listing call is the only connectivity/auth
        // signal available — unlike the "model selected" path below, a
        // failure here can't be masked by a real embed call, so surface it.
        if let Some(err) = list_error {
            return Err(err);
        }
        return Ok(EmbeddingConnectionTest {
            ok: "Connected — model list loaded".to_string(),
            models,
            dimensions: 0,
        });
    }
    let vectors = embed_texts(&provider, &["connection test".to_string()]).await?;
    let dimensions = vectors.first().map(|v| v.len()).unwrap_or(0);
    if dimensions == 0 {
        return Err("embedding call returned no vector".to_string());
    }
    Ok(EmbeddingConnectionTest {
        ok: "Connection successful".to_string(),
        models,
        dimensions: dimensions as u32,
    })
}

// --- LanceDB table plumbing --------------------------------------------------

async fn connect_db() -> Result<Connection, String> {
    let dir = vocab_db_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let uri = dir.to_str().ok_or("non-utf8 vocab_db path")?;
    connect(uri).execute().await.map_err(|e| e.to_string())
}

fn table_schema(dim: i32) -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("term_key", DataType::Utf8, false),
        Field::new("term", DataType::Utf8, false),
        Field::new("columns_json", DataType::Utf8, false),
        Field::new("embed_text", DataType::Utf8, false),
        Field::new("row_hash", DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), dim),
            false,
        ),
        Field::new("source_file", DataType::Utf8, false),
        Field::new("updated_at", DataType::Utf8, false),
    ]))
}

/// Read every `(term_key, row_hash)` pair currently in the table, for the
/// diff step. Empty map when the table doesn't exist yet (first sync).
async fn existing_hashes(db: &Connection, name: &str) -> Result<HashMap<String, String>, String> {
    if !db
        .table_names()
        .execute()
        .await
        .map_err(|e| e.to_string())?
        .contains(&name.to_string())
    {
        return Ok(HashMap::new());
    }
    let table = db
        .open_table(name)
        .execute()
        .await
        .map_err(|e| e.to_string())?;
    let batches: Vec<RecordBatch> = table
        .query()
        .select(lancedb::query::Select::Columns(vec![
            "term_key".into(),
            "row_hash".into(),
        ]))
        .execute()
        .await
        .map_err(|e| e.to_string())?
        .try_collect()
        .await
        .map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for batch in &batches {
        let keys = batch
            .column_by_name("term_key")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            .ok_or("bad term_key column")?;
        let hashes = batch
            .column_by_name("row_hash")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            .ok_or("bad row_hash column")?;
        for i in 0..batch.num_rows() {
            out.insert(keys.value(i).to_string(), hashes.value(i).to_string());
        }
    }
    Ok(out)
}

/// SQL-escape a value for use inside a single-quoted string literal in a
/// LanceDB filter expression.
fn sql_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

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
#[tauri::command]
pub async fn sync_vocab_source(
    app: AppHandle,
    registry: State<'_, SyncCancelRegistry>,
    source_id: String,
    provider: EmbeddingProvider,
    fields: Vec<VocabSourceField>,
    term_field: Option<String>,
) -> Result<SyncResult, String> {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        registry
            .lock()
            .map_err(|e| format!("cancel registry poisoned: {e}"))?
            .insert(source_id.clone(), cancel_flag.clone());
    }
    let result = run_sync(
        &app,
        &source_id,
        &provider,
        &fields,
        term_field.as_deref(),
        &cancel_flag,
    )
    .await;
    registry
        .lock()
        .map_err(|e| format!("cancel registry poisoned: {e}"))?
        .remove(&source_id);
    result
}

async fn run_sync(
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
    let emit = |done: usize, status: &'static str, error: Option<String>| {
        let _ = app.emit(
            SYNC_EVENT,
            SyncProgressEvent {
                source_id: source_id.to_string(),
                rows_done: done,
                rows_total: total,
                status,
                error,
            },
        );
    };
    emit(0, "syncing", None);

    let mut table: Option<LanceDbTable> = None;
    let mut dimensions: u32 = 0;
    let mut embedded = 0usize;

    for chunk in to_embed.chunks(EMBED_BATCH_SIZE) {
        if cancel_flag.load(Ordering::SeqCst) {
            emit(embedded, "error", Some("cancelled".to_string()));
            return Err("__ac_vocab_sync_cancelled__".to_string());
        }
        let texts: Vec<String> = chunk.iter().map(|r| r.embed_text.clone()).collect();
        let vectors = match embed_texts(provider, &texts).await {
            Ok(v) => v,
            Err(e) => {
                emit(embedded, "error", Some(e.clone()));
                return Err(e);
            }
        };
        if dimensions == 0 {
            dimensions = vectors.first().map(|v| v.len()).unwrap_or(0) as u32;
            if dimensions == 0 {
                let e = "embedding call returned no vector".to_string();
                emit(embedded, "error", Some(e.clone()));
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
        emit(embedded, "syncing", None);
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
    if dimensions == 0 {
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
            if let Ok(schema) = t.schema().await {
                if let Ok(f) = schema.field_with_name("vector") {
                    if let DataType::FixedSizeList(_, w) = f.data_type() {
                        dimensions = *w as u32;
                    }
                }
            }
        }
    }

    emit(embedded, "done", None);
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

/// Drop just this source's table (keeps its staged files). No-op if the table
/// doesn't exist.
#[tauri::command]
pub async fn flush_vocab_source(source_id: String) -> Result<(), String> {
    let db = connect_db().await?;
    let name = table_name(&source_id);
    if db
        .table_names()
        .execute()
        .await
        .map_err(|e| e.to_string())?
        .contains(&name)
    {
        db.drop_table(&name, &[]).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Remove the whole `vocab_db` directory — every source's embedded index.
#[tauri::command]
pub fn flush_all_vocab() -> Result<(), String> {
    let dir = vocab_db_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// One candidate returned by a similarity search, ready to be merged with
/// another modality's results (see M4/M5 in ai.rs) and formatted into the
/// cataloguing prompt.
pub struct CandidateTerm {
    pub term: String,
    /// Cosine similarity (1.0 - distance). Fused by max cosine in
    /// `ai::resolve_vocab_fields`; the kept score becomes the field pick's
    /// `similarity`.
    pub score: f32,
}

/// Nearest-neighbour search against one source's table. Returns the empty
/// vec (not an error) when the source has never been synced — callers treat
/// "no table" the same as "no candidates from this source".
pub async fn search_similar(
    source_id: &str,
    vector: &[f32],
    k: usize,
) -> Result<Vec<CandidateTerm>, String> {
    let db = connect_db().await?;
    let name = table_name(source_id);
    if !db
        .table_names()
        .execute()
        .await
        .map_err(|e| e.to_string())?
        .contains(&name)
    {
        return Ok(Vec::new());
    }
    let table = db
        .open_table(&name)
        .execute()
        .await
        .map_err(|e| e.to_string())?;
    let batches: Vec<RecordBatch> = table
        .query()
        // Only `term` is consumed by the search path now (the per-field
        // embedding fuses by cosine score, not by the row's other columns).
        // `columns_json` remains stored in the table for `list_vocab_terms`.
        .select(lancedb::query::Select::Columns(vec!["term".into()]))
        .limit(k)
        .nearest_to(vector)
        .map_err(|e| e.to_string())?
        .distance_type(DistanceType::Cosine)
        .execute()
        .await
        .map_err(|e| e.to_string())?
        .try_collect()
        .await
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for batch in &batches {
        let terms = batch
            .column_by_name("term")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let dist = batch
            .column_by_name("_distance")
            .and_then(|c| c.as_any().downcast_ref::<arrow_array::Float32Array>());
        let Some(terms) = terms else {
            continue;
        };
        for i in 0..batch.num_rows() {
            let score = dist.map(|d| 1.0 - d.value(i)).unwrap_or(0.0);
            out.push(CandidateTerm {
                term: terms.value(i).to_string(),
                score,
            });
        }
    }
    Ok(out)
}

/// Best-effort table drop used when a whole source is deleted (its files are
/// already gone by that point, so a missing table is not an error).
pub async fn drop_table_best_effort(source_id: &str) {
    let _ = flush_vocab_source(source_id.to_string()).await;
}

/// One row of `list_vocab_terms`: the term plus its other detected columns
/// (as a JSON object string), so the frontend can resolve a source's
/// configured label/badge columns for the manual picker's "[label] [badge]"
/// display without a second round-trip.
#[derive(Serialize)]
pub struct VocabTermRow {
    pub term: String,
    #[serde(rename = "columnsJson")]
    pub columns_json: String,
}

/// Full listing of every term in one source's table, for the manual
/// vocab-picker dropdown (see `ResultRow.tsx`/`vterms`) — unlike
/// `search_similar`, this is a plain scan with no vector/ranking, and returns
/// every row rather than a top-k shortlist. Empty vec (not an error) when the
/// source has never been synced, matching `search_similar`'s convention.
#[tauri::command]
pub async fn list_vocab_terms(source_id: String) -> Result<Vec<VocabTermRow>, String> {
    let db = connect_db().await?;
    let name = table_name(&source_id);
    if !db
        .table_names()
        .execute()
        .await
        .map_err(|e| e.to_string())?
        .contains(&name)
    {
        return Ok(Vec::new());
    }
    let table = db
        .open_table(&name)
        .execute()
        .await
        .map_err(|e| e.to_string())?;
    let batches: Vec<RecordBatch> = table
        .query()
        .select(lancedb::query::Select::Columns(vec![
            "term".into(),
            "columns_json".into(),
        ]))
        .execute()
        .await
        .map_err(|e| e.to_string())?
        .try_collect()
        .await
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for batch in &batches {
        let terms = batch
            .column_by_name("term")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let cols = batch
            .column_by_name("columns_json")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let (Some(terms), Some(cols)) = (terms, cols) else {
            continue;
        };
        for i in 0..batch.num_rows() {
            out.push(VocabTermRow {
                term: terms.value(i).to_string(),
                columns_json: cols.value(i).to_string(),
            });
        }
    }
    Ok(out)
}
