//! Persistence: a single `settings.json` next to the running binary.
//!
//! All app state that must survive a restart — the settings blob, the
//! dark-mode flag, and the zoom level — is stored together in this one file
//! under the keys the reference app used (`ac_settings`, `ac_darkMode`,
//! `ac_zoom`). No `tauri-plugin-store`, no OS app-data dir, no localStorage.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

/// The on-disk shape of the single settings file.
/// `settings` is kept as a raw JSON value so the frontend owns its schema.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StateBundle {
    /// Same logical key as the reference: the full settings object.
    #[serde(rename = "ac_settings")]
    pub settings: Value,
    /// `"true"` / `"false"` — mirrors the reference's string storage.
    #[serde(rename = "ac_darkMode")]
    pub dark_mode: String,
    /// Stringified float, e.g. `"1.05"`.
    #[serde(rename = "ac_zoom")]
    pub zoom: String,
}

/// Resolves the directory the executable lives in.
pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::env::temp_dir())
}

fn settings_path() -> PathBuf {
    exe_dir().join("settings.json")
}

/// Read the settings file. A missing file → defaults (normal first run). A
/// *present but corrupt* file → back it up beside the binary and boot into
/// defaults, so corruption is surfaced (not silently erased) while the app
/// still always boots into a usable state.
#[tauri::command]
pub fn load_state() -> StateBundle {
    let path = settings_path();
    match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<StateBundle>(&text) {
            Ok(mut b) => {
                normalize_prompt_settings(&mut b.settings);
                b
            }
            Err(e) => {
                // Preserve the user's data for inspection instead of discarding it.
                let backup =
                    path.with_extension(format!("json.corrupt-{}", chrono_system_timestamp()));
                let _ = fs::write(&backup, &text);
                eprintln!(
                    "[artefact] settings.json failed to parse ({e}); backed up to {} and booting into defaults",
                    backup.display()
                );
                StateBundle::default()
            }
        },
        Err(_) => StateBundle::default(),
    }
}

/// A best-effort UTC timestamp for naming corrupt-settings backups. Uses only
/// `std` (format `YYYYMMDD-HHMMSS`) so no time crate is pulled in for this edge
/// case.
fn chrono_system_timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

/// Atomically write the full bundle back to disk (temp file + rename) so a
/// crash mid-write cannot corrupt the settings file.
#[tauri::command]
pub fn save_state(mut bundle: StateBundle) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    normalize_prompt_settings(&mut bundle.settings);
    let text = serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())?;

    let tmp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);

    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

impl Default for StateBundle {
    fn default() -> Self {
        // The frontend supplies a richer default (`_DEF()`); here we only
        // emit a minimal placeholder so Rust never needs the full schema.
        Self {
            settings: serde_json::json!({}),
            dark_mode: "true".to_string(),
            zoom: "1".to_string(),
        }
    }
}

fn normalize_prompt_settings(settings: &mut Value) {
    decode_string_at(settings, &["systemPromptInstruction"]);
    decode_string_at(settings, &["systemPromptContractOverride"]);

    let Some(fields) = settings.get_mut("fields").and_then(Value::as_array_mut) else {
        return;
    };
    for field in fields {
        decode_string_at(field, &["prompt"]);
    }
}

fn decode_string_at(value: &mut Value, path: &[&str]) {
    let mut current = value;
    for key in path {
        let Some(next) = current.get_mut(*key) else {
            return;
        };
        current = next;
    }

    if let Some(text) = current.as_str().and_then(decode_escaped_prompt_text) {
        *current = Value::String(text);
    }
}

fn decode_escaped_prompt_text(text: &str) -> Option<String> {
    if !text.contains('\\') {
        return None;
    }

    let chars: Vec<char> = text.chars().collect();
    let mut decoded = String::with_capacity(text.len());
    let mut i = 0;
    let mut changed = false;

    while i < chars.len() {
        let ch = chars[i];
        if ch != '\\' {
            decoded.push(ch);
            i += 1;
            continue;
        }

        let Some(next) = chars.get(i + 1).copied() else {
            decoded.push(ch);
            break;
        };

        let replacement = match next {
            'n' => Some('\n'),
            'r' => Some('\r'),
            't' => Some('\t'),
            'b' => Some('\u{0008}'),
            'f' => Some('\u{000C}'),
            '\\' => Some('\\'),
            '"' => Some('"'),
            _ => None,
        };

        if let Some(replacement) = replacement {
            decoded.push(replacement);
            changed = true;
            i += 2;
        } else if next == 'u' {
            if let Some((replacement, consumed)) = decode_unicode_escape(&chars, i) {
                decoded.push(replacement);
                changed = true;
                i += consumed;
            } else {
                decoded.push(ch);
                decoded.push(next);
                i += 2;
            }
        } else {
            decoded.push(ch);
            decoded.push(next);
            i += 2;
        }
    }

    changed.then_some(decoded)
}

fn decode_unicode_escape(chars: &[char], slash_index: usize) -> Option<(char, usize)> {
    let high = parse_hex4(chars, slash_index + 2)?;

    if (0xD800..=0xDBFF).contains(&high) {
        let low_slash = slash_index + 6;
        if chars.get(low_slash) != Some(&'\\') || chars.get(low_slash + 1) != Some(&'u') {
            return None;
        }
        let low = parse_hex4(chars, low_slash + 2)?;
        if !(0xDC00..=0xDFFF).contains(&low) {
            return None;
        }
        let codepoint = 0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00);
        return char::from_u32(codepoint).map(|ch| (ch, 12));
    }

    if (0xDC00..=0xDFFF).contains(&high) {
        return None;
    }

    char::from_u32(high).map(|ch| (ch, 6))
}

fn parse_hex4(chars: &[char], start: usize) -> Option<u32> {
    if start + 4 > chars.len() {
        return None;
    }
    let mut value = 0;
    for ch in &chars[start..start + 4] {
        value = (value << 4) + ch.to_digit(16)?;
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_escaped_prompt_fields() {
        let mut settings = serde_json::json!({
            "systemPromptInstruction": "shared\\nline\\tindent",
            "systemPromptContractOverride": "override\\nsecond line",
            "fields": [
                { "prompt": "first\\nsecond" },
                { "prompt": "quote: \\\"term\\\"" },
                { "prompt": "unicode: \\u03A9 \\uD83D\\uDCA0" }
            ]
        });

        normalize_prompt_settings(&mut settings);

        assert_eq!(
            settings["systemPromptInstruction"].as_str(),
            Some("shared\nline\tindent")
        );
        assert_eq!(
            settings["systemPromptContractOverride"].as_str(),
            Some("override\nsecond line")
        );
        assert_eq!(
            settings["fields"][0]["prompt"].as_str(),
            Some("first\nsecond")
        );
        assert_eq!(
            settings["fields"][1]["prompt"].as_str(),
            Some("quote: \"term\"")
        );
        assert_eq!(
            settings["fields"][2]["prompt"].as_str(),
            Some("unicode: \u{03A9} \u{1F4A0}")
        );
    }

    #[test]
    fn leaves_non_prompt_strings_unchanged() {
        let mut settings = serde_json::json!({
            "fields": [
                { "name": "literal\\nname", "prompt": "prompt" }
            ]
        });

        normalize_prompt_settings(&mut settings);

        assert_eq!(
            settings["fields"][0]["name"].as_str(),
            Some("literal\\nname")
        );
        assert_eq!(settings["fields"][0]["prompt"].as_str(), Some("prompt"));
    }
}
