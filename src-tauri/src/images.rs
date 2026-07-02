//! Image scratch files: extracted spreadsheet images written to a temp
//! directory created **beside the running binary** (never the OS temp dir),
//! then served back to the webview via Tauri's asset protocol.
//!
//! Layout: `<exe_dir>/tmp/artefact-cataloguer/<session>/<filename>`.
//! The whole subtree is wiped on app start and on app quit (see `lib.rs`),
//! and a fresh parse overwrites the current session's files.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::settings::exe_dir;

const TEMP_ROOT: &str = "tmp";
const TEMP_APP: &str = "artefact-cataloguer";

/// One image to write. `bytes` is the raw PNG/JPEG payload extracted in JS.
#[derive(Deserialize)]
pub struct ImageEntry {
    pub filename: String,
    pub bytes: Vec<u8>,
}

/// Result row: stable id + absolute path for `convertFileSrc` in the webview.
#[derive(Serialize)]
pub struct ExtractedImage {
    pub id: String,
    pub abs_path: String,
}

/// The scratch dir extracted images are written under:
/// `<exe_dir>/tmp/artefact-cataloguer/`. Exposed so startup can grant this
/// directory to the asset-protocol scope at runtime (see `lib.rs`).
pub fn temp_app_dir() -> PathBuf {
    exe_dir().join(TEMP_ROOT).join(TEMP_APP)
}

/// Resolve the session directory after validating `session_id`. The id is a
/// renderer-supplied path component, so it must be a plain base name: rejecting
/// separators, parent traversal, drive letters, and empty/`.`/`..` prevents the
/// renderer from writing outside `<exe_dir>/tmp/artefact-cataloguer/`.
fn session_dir(session_id: &str) -> Result<PathBuf, String> {
    let id = validate_path_segment(session_id, "session id")?;
    Ok(temp_app_dir().join(id))
}

/// Validate a single renderer-supplied path segment, returning the cleaned base
/// name. Rejects anything that could escape one directory level.
fn validate_path_segment(raw: &str, label: &str) -> Result<String, String> {
    let cleaned = std::path::Path::new(raw)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty() && s != "." && s != "..");
    match cleaned {
        // `file_name` already strips any leading dir components, but a raw id
        // like "../x" would resolve to "x" — reject it unless it matched verbatim.
        Some(name) if name == raw => Ok(name),
        _ => Err(format!("invalid {label}: rejected path traversal")),
    }
}

/// Validate that `path` (renderer-supplied absolute image path) resolves inside
/// the image scratch dir `<exe_dir>/tmp/artefact-cataloguer/`. Returns the
/// canonicalized path on success. The renderer is untrusted, so an absolute path
/// that escapes the scratch dir is rejected rather than read.
pub fn validate_scratch_path(path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path);
    let root = temp_app_dir();
    let canonical_root = fs::canonicalize(&root).unwrap_or(root);
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("image path not accessible: {e}"))?;
    if canonical.starts_with(&canonical_root) {
        Ok(canonical)
    } else {
        Err("image path outside scratch dir".to_string())
    }
}

/// Wipe the entire `<exe_dir>/tmp/artefact-cataloguer/` subtree.
/// Safe to call when the dir does not exist. Called on startup and on quit.
#[tauri::command]
pub fn cleanup_temp() -> Result<(), String> {
    let dir = temp_app_dir();
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Write a batch of extracted images for one parse session. Each call with
/// the same `session_id` overwrites the same session directory.
#[tauri::command]
pub fn extract_images(
    session_id: String,
    entries: Vec<ImageEntry>,
) -> Result<Vec<ExtractedImage>, String> {
    let dir = session_dir(&session_id)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(entries.len());
    for (i, entry) in entries.into_iter().enumerate() {
        // Guard against path traversal in crafted filenames: keep only the
        // base name and fall back to an index if empty.
        let safe_name = std::path::Path::new(&entry.filename)
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("image-{i}"));

        let path = dir.join(&safe_name);
        fs::write(&path, &entry.bytes).map_err(|e| e.to_string())?;

        out.push(ExtractedImage {
            id: safe_name,
            abs_path: path.to_string_lossy().into_owned(),
        });
    }
    Ok(out)
}
