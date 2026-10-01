//! Renderer-supplied path-segment validation, shared by the file-staging
//! modules (`images`, `vocab_files`). The renderer is untrusted, so every path
//! component it supplies must be a plain base name before it touches the
//! filesystem.

/// Validate a single renderer-supplied path segment, returning the cleaned base
/// name. Rejects anything that could escape one directory level.
pub fn validate_path_segment(raw: &str, label: &str) -> Result<String, String> {
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
