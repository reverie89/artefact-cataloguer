//! Debug logging for the catalogue pipeline: redaction helpers so nothing
//! sensitive reaches the Logs Viewer, the verbose payload / stage-event
//! envelopes, and the `"ac-logs"` emitter shared by transport logging and the
//! pipeline's warning surfacing.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use super::transport::APP_USER_AGENT;

/// Event name for the curated run-activity stream that powers the Logs Viewer
/// drawer. `do_completion` logs the chat-completions request/response here.
const LOG_STAGE_EVENT: &str = "ac-logs";

/// Mask a secret for logging: keep the last 4 chars, hide the rest. Mirrors the
/// frontend's redaction so neither side ever logs a raw key.
fn mask_secret(s: &str) -> String {
    if s.len() <= 4 {
        "••••".to_string()
    } else {
        "•".repeat(4) + &s[s.len() - 4..]
    }
}

/// Build the header list to show in the Logs Viewer request envelope, reusing
/// the provider's auth headers as the source of truth. Any value that carries
/// the raw API key has only the key masked in place (so `Bearer <key>` becomes
/// `Bearer ••••wxyz`, not a fully obscured blob), then the shared User-Agent +
/// Accept defaults are appended. Nothing sensitive is emitted.
pub(crate) fn log_headers(auth: &[(&'static str, String)], api_key: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = auth
        .iter()
        .map(|(name, value)| {
            let v = if value.contains(api_key) {
                value.replace(api_key, &mask_secret(api_key))
            } else {
                value.clone()
            };
            (name.to_string(), v)
        })
        .collect();
    out.push(("User-Agent".to_string(), APP_USER_AGENT.to_string()));
    out.push(("Accept".to_string(), "application/json".to_string()));
    out
}

/// Produce a copy of a request body safe to emit to the Logs Viewer drawer.
///
/// Replaces inlined image payloads (`data:` URLs and raw base64 `data` fields)
/// with compact size markers. All other fields — including prompt text — are
/// passed through verbatim.
pub(crate) fn redact_body(body: &Value) -> Value {
    let mut v = body.clone();
    redact_body_in_place(&mut v);
    v
}

/// In-place companion to `redact_body`.
fn redact_body_in_place(v: &mut Value) {
    match v {
        Value::Object(map) => {
            // Inline image payloads. The three shapes produced in this module:
            //   OpenAI  → image_url.url = "data:<mime>;base64,<bytes>"
            //   Anthropic → source.data = "<base64>"
            redact_string_field(map, "url", |s| s.starts_with("data:"), redact_data_url);
            redact_string_field(map, "data", is_likely_base64, |s| {
                format!("<redacted base64, {} bytes>", s.len())
            });
            for (_, child) in map.iter_mut() {
                redact_body_in_place(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_body_in_place(item);
            }
        }
        _ => {}
    }
}

/// Replace a string field in place. The field is read immutably to decide
/// whether it needs redacting and to build the replacement (an owned `String`);
/// only then is the slot overwritten, so no borrow is held across the mutation.
fn redact_string_field(
    map: &mut serde_json::Map<String, Value>,
    key: &str,
    should_redact: impl Fn(&str) -> bool,
    replace: impl Fn(&str) -> String,
) {
    let replacement = map
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| should_redact(s))
        .map(replace);
    if let Some(r) = replacement {
        map.insert(key.to_string(), Value::String(r));
    }
}

/// Collapse a `data:<mime>;base64,<bytes>` URL to a size marker.
fn redact_data_url(url: &str) -> String {
    let bytes = url.split(',').nth(1).map(str::len).unwrap_or(0);
    format!("<redacted base64 image, {} bytes>", bytes)
}

/// Heuristic: a non-trivial run of base64 alphabet chars with no spaces.
fn is_likely_base64(s: &str) -> bool {
    s.len() > 64
        && !s.contains(' ')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

/// Verbose HTTP/row envelope attached to a Logs Viewer stage event. Auth
/// values are masked before emission (reusing `mask_secret`), so nothing
/// sensitive is leaked.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerbosePayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) headers: Option<Vec<(String, String)>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) body: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "jobId")]
    pub(crate) job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

/// One cataloguing-pipeline stage, surfaced as a row in the Logs Viewer.
/// `stage`/`label` drive the rendered label; `status` drives the dot colour
/// (ok/busy/fail). `job_group` ties every stage of one call together so the
/// renderer can resolve earlier "busy" dots when a terminal stage lands. The
/// same `"ac-logs"` channel also carries embedding stages emitted from
/// `embeddings.rs` (each with its own `job_group`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PipelineStageEvent {
    pub(crate) stage: &'static str,
    /// Group id shared by every stage of one call (assigned before the POST,
    /// before the platform job id is known). The renderer resolves prior busy
    /// stages of the same group when a terminal stage arrives.
    pub(crate) job_group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) elapsed_ms: Option<u64>,
    pub(crate) status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) verbose: Option<VerbosePayload>,
}

/// Emit a pipeline-stage event to the renderer. Best-effort: a logging failure
/// must never break a provider call, so errors are swallowed.
pub(crate) fn log_stage(app: &AppHandle, event: PipelineStageEvent) {
    let _ = app.emit(LOG_STAGE_EVENT, event);
}

/// Monotonic per-call group id so the renderer can tie every stage of one AI
/// call together. The job id isn't known until after the request, so this is
/// assigned up front.
pub(crate) fn next_call_group() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("ac-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redact_body_strips_openai_image_data_url() {
        let body = json!({
            "model": "gpt-4o",
            "messages": [{ "role": "user", "content": [
                { "type": "text", "text": "x".repeat(200) },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } }
            ]}]
        });
        let redacted = redact_body(&body);
        let url = redacted["messages"][0]["content"][1]["image_url"]["url"]
            .as_str()
            .unwrap();
        assert!(url.starts_with("<redacted base64 image"));
        assert!(!url.contains("AAAA"));
        // Prompt text is passed through unchanged.
        let text = redacted["messages"][0]["content"][0]["text"]
            .as_str()
            .unwrap();
        assert_eq!(text, &"x".repeat(200));
    }

    #[test]
    fn redact_body_strips_anthropic_base64_source() {
        let body = json!({
            "messages": [{ "role": "user", "content": [
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "A".repeat(128) } }
            ]}]
        });
        let redacted = redact_body(&body);
        assert!(redacted["messages"][0]["content"][0]["source"]["data"]
            .as_str()
            .unwrap()
            .starts_with("<redacted base64"));
    }
}
