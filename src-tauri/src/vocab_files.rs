//! Vocabulary-source file staging: uploaded files are persisted **beside the
//! binary** (unlike the scratch-wiped `tmp/artefact-cataloguer/` used for
//! extracted images, this directory survives restarts, since incremental sync
//! needs to re-diff against the same bytes later, and the Settings UI's
//! Download button reads them back). Layout:
//! `<exe_dir>/vocab_files/<sourceId>/<filename>`.
//!
//! Also owns header/column detection (reading just the first row of a newly
//! staged file) and the streaming per-file row parse consumed by
//! `embeddings::sync_vocab_source`.

use calamine::{open_workbook_auto, Reader};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::settings::exe_dir;

const VOCAB_FILES_DIR: &str = "vocab_files";

/// A source's field config, mirroring the frontend `VocabSourceField` — sent
/// down from Settings on every sync so `embed_text` reflects the user's
/// current Include-for-AI choices.
#[derive(Deserialize, Clone)]
pub struct VocabSourceField {
    pub name: String,
    #[serde(rename = "includeForAI")]
    pub include_for_ai: bool,
}

/// Metadata returned after staging one file, including every column detected
/// from its header row (the frontend lets the user pick which one is used
/// for ingestion — see `VocabSource.ingestionField` in app/types.ts).
#[derive(Serialize)]
pub struct StagedVocabFile {
    pub id: String,
    pub filename: String,
    #[serde(rename = "addedDate")]
    pub added_date: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "detectedFields")]
    pub detected_fields: Vec<String>,
    /// This file's own row count, for `VocabSourceFile.rowCountLast` — known
    /// immediately at staging since a full parse is cheap enough to do here
    /// too (mirrors `diff_rows`' per-file "found" tally in embeddings.rs).
    #[serde(rename = "rowCount")]
    pub row_count: usize,
}

/// One fully-parsed row from a source file, ready for hashing/embedding.
/// `columns` holds every column except whichever one is currently the term
/// (ingestion) column, in file order.
pub struct ParsedRow {
    pub term: String,
    pub columns: Vec<(String, String)>,
    pub source_file: String,
}

pub fn vocab_files_dir() -> PathBuf {
    exe_dir().join(VOCAB_FILES_DIR)
}

/// Validate a single renderer-supplied path segment (source id or filename),
/// returning the cleaned base name. Mirrors `images::validate_path_segment` —
/// rejects anything that could escape one directory level.
fn validate_path_segment(raw: &str, label: &str) -> Result<String, String> {
    let cleaned = Path::new(raw)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty() && s != "." && s != "..");
    match cleaned {
        Some(name) if name == raw => Ok(name),
        _ => Err(format!("invalid {label}: rejected path traversal")),
    }
}

pub fn source_dir(source_id: &str) -> Result<PathBuf, String> {
    let id = validate_path_segment(source_id, "source id")?;
    Ok(vocab_files_dir().join(id))
}

fn file_path(source_id: &str, filename: &str) -> Result<PathBuf, String> {
    let dir = source_dir(source_id)?;
    let name = validate_path_segment(filename, "filename")?;
    Ok(dir.join(name))
}

/// Detect header columns from one file (first row only — cheap even for a
/// large file). Returns every detected column, including whichever one ends
/// up used as the term/ingestion column — the frontend lets the user pick
/// that role from the full list rather than it being implicitly column 0.
fn detect_fields(path: &Path) -> Result<Vec<String>, String> {
    let lower = path.to_string_lossy().to_lowercase();
    if lower.ends_with(".csv") {
        let mut rdr = csv::ReaderBuilder::new()
            .has_headers(false)
            .from_path(path)
            .map_err(|e| format!("read header failed: {e}"))?;
        let mut iter = rdr.records();
        let Some(first) = iter.next() else {
            return Ok(Vec::new());
        };
        let first = first.map_err(|e| format!("read header failed: {e}"))?;
        // Only treat the first row as a header (drop it) if it looks like a
        // label rather than data — mirrors the old parseVocabFile heuristic.
        let looks_like_header = first
            .iter()
            .next()
            .is_some_and(|c| !c.chars().any(|ch| ch.is_ascii_digit()));
        if !looks_like_header {
            return Ok(Vec::new());
        }
        Ok(first
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect())
    } else {
        let mut wb = open_workbook_auto(path).map_err(|e| format!("open workbook failed: {e}"))?;
        let sheet_name = wb
            .sheet_names()
            .first()
            .cloned()
            .ok_or("workbook has no sheets")?;
        let range = wb
            .worksheet_range(&sheet_name)
            .map_err(|e| format!("read sheet failed: {e}"))?;
        let Some(first) = range.rows().next() else {
            return Ok(Vec::new());
        };
        let looks_like_header = first
            .first()
            .is_some_and(|c| !c.to_string().chars().any(|ch| ch.is_ascii_digit()));
        if !looks_like_header {
            return Ok(Vec::new());
        }
        Ok(first
            .iter()
            .map(|c| c.to_string().trim().to_string())
            .filter(|s| !s.is_empty())
            .collect())
    }
}

/// Stream-parse one source file into rows. Called by `embeddings::sync_vocab_source`
/// for every staged file. `filename` is recorded on each row as `source_file`
/// so removing a file later can prune exactly the rows it contributed.
///
/// Note: rows are collected into a `Vec` here rather than truly streamed
/// batch-by-batch — a meaningful improvement over the former client-side
/// approach (which held the raw file *and* a flat JS term array in React
/// state), but not a hard memory bound for an extreme (many-million-row)
/// single file. If profiling shows this matters in practice, switch to a
/// chunked fold that hashes/classifies/embeds in batches without collecting
/// the whole file first.
///
/// `term_field` names which detected header column supplies `ParsedRow.term`
/// — resolved to a column index via `resolve_term_index` (falls back to
/// column 0 when unset, not found, or the file has no header row, matching
/// the original hardcoded behaviour).
pub fn parse_source_file(
    path: &Path,
    filename: &str,
    term_field: Option<&str>,
) -> Result<Vec<ParsedRow>, String> {
    let lower = path.to_string_lossy().to_lowercase();
    let mut rows = Vec::new();
    if lower.ends_with(".csv") {
        let mut rdr = csv::ReaderBuilder::new()
            .has_headers(false)
            .flexible(true)
            .from_path(path)
            .map_err(|e| format!("read failed: {e}"))?;
        let mut records = rdr.records();
        let Some(first) = records.next() else {
            return Ok(rows);
        };
        let first = first.map_err(|e| format!("read failed: {e}"))?;
        let header_row = first
            .iter()
            .next()
            .is_some_and(|c| !c.chars().any(|ch| ch.is_ascii_digit()));
        let headers: Vec<String> = if header_row {
            first.iter().map(|s| s.trim().to_string()).collect()
        } else {
            Vec::new()
        };
        let term_index = resolve_term_index(&headers, term_field);
        if !header_row {
            push_row_csv(&mut rows, &first, &headers, term_index, filename);
        }
        for rec in records {
            let rec = rec.map_err(|e| format!("read failed: {e}"))?;
            push_row_csv(&mut rows, &rec, &headers, term_index, filename);
        }
    } else {
        let mut wb = open_workbook_auto(path).map_err(|e| format!("open workbook failed: {e}"))?;
        let sheet_name = wb
            .sheet_names()
            .first()
            .cloned()
            .ok_or("workbook has no sheets")?;
        let range = wb
            .worksheet_range(&sheet_name)
            .map_err(|e| format!("read sheet failed: {e}"))?;
        let mut iter = range.rows();
        let Some(first) = iter.next() else {
            return Ok(rows);
        };
        let header_row = first
            .first()
            .is_some_and(|c| !c.to_string().chars().any(|ch| ch.is_ascii_digit()));
        let headers: Vec<String> = if header_row {
            first
                .iter()
                .map(|c| c.to_string().trim().to_string())
                .collect()
        } else {
            Vec::new()
        };
        let term_index = resolve_term_index(&headers, term_field);
        if !header_row {
            push_row_calamine(&mut rows, first, &headers, term_index, filename);
        }
        for rec in iter {
            push_row_calamine(&mut rows, rec, &headers, term_index, filename);
        }
    }
    Ok(rows)
}

/// Resolve which column index holds the term: the index of `term_field` in
/// `headers` if it names a real detected column, otherwise column 0 — the
/// original hardcoded behaviour, kept as the default for unset/legacy
/// sources and for headerless files (where `headers` is always empty).
fn resolve_term_index(headers: &[String], term_field: Option<&str>) -> usize {
    term_field
        .and_then(|t| headers.iter().position(|h| h == t))
        .unwrap_or(0)
}

fn push_row_csv(
    rows: &mut Vec<ParsedRow>,
    rec: &csv::StringRecord,
    headers: &[String],
    term_index: usize,
    filename: &str,
) {
    let cells: Vec<String> = rec.iter().map(|c| c.trim().to_string()).collect();
    let Some(term) = cells.get(term_index).cloned() else {
        return;
    };
    if term.is_empty() {
        return;
    }
    let columns = headers
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != term_index)
        .filter_map(|(i, name)| cells.get(i).map(|val| (name.clone(), val.clone())))
        .collect();
    rows.push(ParsedRow {
        term,
        columns,
        source_file: filename.to_string(),
    });
}

fn push_row_calamine(
    rows: &mut Vec<ParsedRow>,
    rec: &[calamine::Data],
    headers: &[String],
    term_index: usize,
    filename: &str,
) {
    let cells: Vec<String> = rec
        .iter()
        .map(|c| c.to_string().trim().to_string())
        .collect();
    let Some(term) = cells.get(term_index).cloned() else {
        return;
    };
    if term.is_empty() {
        return;
    }
    let columns = headers
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != term_index)
        .filter_map(|(i, name)| cells.get(i).map(|val| (name.clone(), val.clone())))
        .collect();
    rows.push(ParsedRow {
        term,
        columns,
        source_file: filename.to_string(),
    });
}

/// Persist one uploaded file's bytes, detect its header columns, and count its
/// data rows (a full parse — cheap for vocab-list-sized files, and it's the
/// only way to know "rows ready for sync" before the user actually syncs).
#[tauri::command]
pub fn stage_vocab_file(
    source_id: String,
    filename: String,
    bytes: Vec<u8>,
) -> Result<StagedVocabFile, String> {
    let dir = source_dir(&source_id)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = validate_path_segment(&filename, "filename")?;
    if !name.to_lowercase().ends_with(".csv")
        && !name.to_lowercase().ends_with(".xlsx")
        && !name.to_lowercase().ends_with(".xls")
    {
        return Err("only .csv, .xlsx, .xls files are accepted".to_string());
    }
    let path = dir.join(&name);
    fs::write(&path, &bytes).map_err(|e| format!("write failed: {e}"))?;
    let detected_fields = detect_fields(&path)?;
    // The source's configured ingestion column isn't known at staging time
    // (it lives in frontend settings, sent only on sync) — `None` counts
    // rows by the positional default, a preview number the sync's own tally
    // may later refine, same as `rowCountLast` vs `rowCountSyncedLast` today.
    let row_count = parse_source_file(&path, &name, None)?.len();
    Ok(StagedVocabFile {
        id: name.clone(),
        filename: name,
        added_date: today_date(),
        size_bytes: bytes.len() as u64,
        detected_fields,
        row_count,
    })
}

#[tauri::command]
pub fn remove_vocab_file(source_id: String, filename: String) -> Result<(), String> {
    let path = file_path(&source_id, &filename)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn download_vocab_file(source_id: String, filename: String) -> Result<Vec<u8>, String> {
    let path = file_path(&source_id, &filename)?;
    fs::read(&path).map_err(|e| format!("read failed: {e}"))
}

/// Remove a source's whole file directory and drop its LanceDB table (a
/// missing table is not an error — deleting a never-synced source is normal).
#[tauri::command]
pub async fn delete_vocab_source(source_id: String) -> Result<(), String> {
    let dir = source_dir(&source_id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    crate::embeddings::drop_table_best_effort(&source_id).await;
    Ok(())
}

/// List every staged file's path under a source, for `sync_vocab_source` to
/// iterate. Returns `(filename, path)` pairs, sorted for deterministic diffs.
pub fn list_source_files(source_id: &str) -> Result<Vec<(String, PathBuf)>, String> {
    let dir = source_dir(source_id)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                out.push((name.to_string(), path));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

fn today_date() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Days since epoch → a plain Y-M-D via civil_from_days (Howard Hinnant's
    // algorithm), avoiding a chrono dependency for this one display field.
    let days = (secs / 86400) as i64;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
