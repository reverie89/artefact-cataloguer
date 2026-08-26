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
//!
//! Layout: [`provider`] owns the embedding HTTP protocol (text/image embed
//! calls, retry, connection check), [`store`] the LanceDB persistence and
//! read paths, [`sync`] the hash-diff sync pipeline. The Tauri commands stay
//! here as a thin state/command facade over them.

mod provider;
mod store;
mod sync;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

use crate::settings::exe_dir;
use crate::vocab_files::VocabSourceField;

// Items consumed by sibling modules (`ai.rs`, `vocab_files.rs`, `lib.rs`) are
// re-exported here so external paths like `crate::embeddings::search_similar`
// stay valid.
pub use provider::EmbeddingProvider;
pub(crate) use provider::{embed_image_with_retry, embed_texts};
pub use store::CandidateTerm;
pub use store::{drop_table_best_effort, search_similar};

use provider::{check_connection, EmbeddingConnectionTest};
use store::{flush_source, list_terms, VocabTermRow};
use sync::{run_sync, SyncResult};

const VOCAB_DB_DIR: &str = "vocab_db";

pub fn vocab_db_dir() -> PathBuf {
    exe_dir().join(VOCAB_DB_DIR)
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
    check_connection(provider).await
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

/// Drop just this source's table (keeps its staged files). No-op if the table
/// doesn't exist.
#[tauri::command]
pub async fn flush_vocab_source(source_id: String) -> Result<(), String> {
    flush_source(source_id).await
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

/// Full listing of every term in one source's table, for the manual
/// vocab-picker dropdown (see `ResultRow.tsx`/`vterms`) — unlike
/// `search_similar`, this is a plain scan with no vector/ranking, and returns
/// every row rather than a top-k shortlist. Empty vec (not an error) when the
/// source has never been synced, matching `search_similar`'s convention.
#[tauri::command]
pub async fn list_vocab_terms(source_id: String) -> Result<Vec<VocabTermRow>, String> {
    list_terms(source_id).await
}
