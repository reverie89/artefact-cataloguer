//! LanceDB persistence for vocab embeddings: table naming/connection, the
//! shared row schema, hash scans used by the sync diff, SQL-filter quoting,
//! and the read paths (nearest-neighbour search + full listing) consumed by
//! the catalogue pipeline and the manual vocab picker.

use arrow_array::{Array, RecordBatch, StringArray};
use arrow_schema::{DataType, Field, Schema};
use futures::TryStreamExt;
use lancedb::query::{ExecutableQuery, QueryBase};
use lancedb::{connect, Connection, DistanceType};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

use super::vocab_db_dir;

pub(crate) fn table_name(source_id: &str) -> String {
    format!("vocab_{source_id}")
}

pub(crate) async fn connect_db() -> Result<Connection, String> {
    let dir = vocab_db_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let uri = dir.to_str().ok_or("non-utf8 vocab_db path")?;
    connect(uri).execute().await.map_err(|e| e.to_string())
}

pub(crate) fn table_schema(dim: i32) -> Arc<Schema> {
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
pub(crate) async fn existing_hashes(
    db: &Connection,
    name: &str,
) -> Result<HashMap<String, String>, String> {
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
pub(crate) fn sql_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Drop just this source's table (keeps its staged files). No-op if the table
/// doesn't exist. Exposed through the `flush_vocab_source` command.
pub(crate) async fn flush_source(source_id: String) -> Result<(), String> {
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
    let _ = flush_source(source_id.to_string()).await;
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
/// Exposed through the `list_vocab_terms` command.
pub(crate) async fn list_terms(source_id: String) -> Result<Vec<VocabTermRow>, String> {
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
