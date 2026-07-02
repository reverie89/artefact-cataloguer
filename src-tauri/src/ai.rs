//! Cataloguing via the active AI provider, run from Rust so API keys never
//! reach the renderer and CORS is a non-issue.
//!
//! `catalogue_artefact` sends each artefact's source fields and (when present)
//! its extracted image as **one single prompt** to the active provider, asking
//! the model to return — for every configured catalogue field at once — a
//! ranked list of `{value, confidence}` suggestions. Vocab fields are
//! constrained to the supplied allowed terms.
//!
//! Providers use the OpenAI/Anthropic/Gemini chat-completions API — one
//! multimodal POST with the image inlined as a content block.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;
// `Engine` must be in scope to call `base64::engine::general_purpose::STANDARD.encode`.
use base64::Engine;

const TIMEOUT_SECS: u64 = 120;

/// Sentinel error string the renderer recognises as a cancellation (vs. a real
/// transport/provider failure). Kept short and unlikely to collide so a genuine
/// provider error quoting it can't masquerade as a cancel.
pub const CANCEL_ERROR: &str = "__ac_cancelled__";

/// In-flight cancellation handles, keyed by the per-call job id the renderer
/// supplies (`"row-<uid>"`, one outstanding call per row at most). Registered
/// in `catalogue_artefact` and fired by `cancel_catalogue`. Arc<Mutex<...>> so
/// it can be shared through Tauri's `State` without `Send`/lifetime issues.
pub type CancelRegistry = Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>;

/// Construct the empty registry; managed by the Tauri app in `lib.rs`.
pub fn default_registry() -> CancelRegistry {
    Arc::new(Mutex::new(HashMap::new()))
}

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
fn log_headers(auth: &[(&'static str, String)], api_key: &str) -> Vec<(String, String)> {
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
fn redact_body(body: &Value) -> Value {
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
        .map(|s| replace(s));
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
struct VerbosePayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    headers: Option<Vec<(String, String)>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "jobId")]
    job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// One vision-pipeline stage, surfaced as a row in the Logs Viewer. `stage`
/// drives the renderer-side label; `status` drives the dot colour (ok/busy/fail).
/// `job_group` ties every stage of one vision call together so the renderer can
/// resolve the earlier "busy" dots when a terminal stage lands.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VisionStageEvent {
    stage: &'static str,
    /// Group id shared by every stage of one vision call (assigned before the
    /// POST, before the platform job id is known). The renderer resolves prior
    /// busy stages of the same group when a terminal stage arrives.
    job_group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    elapsed_ms: Option<u64>,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    verbose: Option<VerbosePayload>,
}

/// Emit a vision-stage event to the renderer. Best-effort: a logging failure
/// must never break a provider call, so errors are swallowed.
fn log_stage(app: &AppHandle, event: VisionStageEvent) {
    let _ = app.emit(LOG_STAGE_EVENT, event);
}

/// Monotonic per-call group id so the renderer can tie every stage of one AI
/// call together. The job id isn't known until after the request, so this is
/// assigned up front.
fn next_call_group() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    format!("ac-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Which API family a provider speaks. Determines both the auth header(s) and
/// the endpoint paths used for completion + models calls.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum ApiFormat {
    /// OpenAI-compatible: `Authorization: Bearer <key>`, `/chat/completions`,
    /// `/models`. The default (and only option before this field existed).
    #[serde(rename = "openai")]
    #[default]
    OpenAi,
    /// Anthropic: `x-api-key: <key>` + `anthropic-version`, `/v1/messages`,
    /// `/v1/models`.
    #[serde(rename = "anthropic")]
    Anthropic,
    /// Google Gemini: `x-goog-api-key: <key>`, Interactions API
    /// (`/v1beta/interactions`, `/v1beta/models`).
    #[serde(rename = "gemini")]
    Gemini,
}

impl ApiFormat {
    /// Header(s) to attach for this key + format. OpenAI uses one; Anthropic
    /// additionally pins the API version.
    fn auth(&self, api_key: &str) -> Vec<(&'static str, String)> {
        match self {
            ApiFormat::OpenAi => vec![("Authorization", format!("Bearer {}", api_key))],
            ApiFormat::Anthropic => vec![
                ("x-api-key", api_key.to_string()),
                ("anthropic-version", "2023-06-01".to_string()),
            ],
            ApiFormat::Gemini => vec![("x-goog-api-key", api_key.to_string())],
        }
    }

    /// (completions URL, models URL) for this format against a trimmed base.
    fn endpoints(&self, base: &str) -> (String, String) {
        match self {
            ApiFormat::OpenAi => (
                format!("{}/chat/completions", base),
                format!("{}/models", base),
            ),
            // Anthropic paths are versioned under /v1; the base is the bare host.
            ApiFormat::Anthropic => (
                format!("{}/v1/messages", base),
                format!("{}/v1/models", base),
            ),
            // Gemini uses the Interactions API; paths are versioned under /v1beta.
            ApiFormat::Gemini => (
                format!("{}/v1beta/interactions", base),
                format!("{}/v1beta/models", base),
            ),
        }
    }
}

/// One AI provider, mirroring the frontend `Provider` type.
#[derive(Deserialize, Clone)]
pub struct Provider {
    /// Sent by the frontend for completeness; not read on the Rust side.
    #[allow(dead_code)]
    pub name: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    pub model: String,
    /// Optional; older providers without the field default to OpenAI format.
    #[serde(rename = "apiFormat", default)]
    pub api_format: ApiFormat,
}

/// One catalogue field the AI must populate.
#[derive(Deserialize, Clone)]
pub struct FieldSpec {
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub prompt: String,
    /// For vocab fields only: the allowed terms.
    #[serde(default)]
    pub allowed: Vec<String>,
}

/// A single artefact's source record (column → value) plus optional image path.
#[derive(Deserialize, Clone)]
pub struct ArtefactInput {
    /// e.g. { "ID": "ACM-1021", "Title": "...", "Image": "<extracted path>" }
    #[serde(default)]
    pub record: Value,
    /// Absolute path to the extracted image file, if any.
    #[serde(rename = "imagePath")]
    pub image_path: Option<String>,
    /// Part 1 of the system instructions — user-edited context prose, verbatim.
    #[serde(rename = "systemPrompt", default)]
    pub system_prompt: String,
    /// Part 2 of the system instructions — the read-only output contract the
    /// parser relies on. The frontend owns the effective string (default or
    /// override) and passes it here verbatim.
    #[serde(rename = "systemPromptContract", default)]
    pub system_prompt_contract: String,
}

/// One ranked suggestion returned per field.
#[derive(Serialize)]
pub struct Suggestion {
    pub value: String,
    pub confidence: f64,
}

/// Per-field suggestions: field name → ranked list.
#[derive(Serialize)]
pub struct CatalogueResult {
    #[serde(rename = "fieldResults")]
    pub field_results: std::collections::BTreeMap<String, Vec<Suggestion>>,
}

/// Result of a successful connection test: a status line plus the model ids the
/// endpoint advertises (used to populate the model dropdown in the UI).
#[derive(Serialize)]
pub struct ConnectionTest {
    pub ok: String,
    pub models: Vec<String>,
}

fn trim_trailing_slash(s: &str) -> String {
    let t = s.trim_end_matches('/');
    if t.is_empty() {
        s.to_string()
    } else {
        t.to_string()
    }
}

/// `User-Agent` string presented to API gateways. Some gateways (notably
/// government / WAF-fronted ones like `*.tech.gov.sg`) reject the default
/// `reqwest/*` UA with HTTP 403 even when the API key is valid. Posing as a
/// legitimate Edge (Chromium) browser satisfies bot/UA filters that would
/// otherwise block a non-browser client. Keep it in sync with a current stable
/// Edge release; bump the Chrome/Edge versions periodically.
const APP_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

/// Build the shared `reqwest::Client` with a browser-friendly request envelope:
/// a real `User-Agent` and a default `Accept: application/json`. Both call sites
/// (test_connection, do_completion) go through here so the envelope never drifts.
fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/json"),
    );
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(APP_USER_AGENT)
        .default_headers(headers)
        .build()
        .map_err(|e| e.to_string())
}

fn visible_record(record: &Value) -> Value {
    let Some(obj) = record.as_object() else {
        return record.clone();
    };
    let mut filtered = serde_json::Map::new();
    for (k, v) in obj {
        let lower = k.to_ascii_lowercase();
        let id_related = lower.contains("accession")
            || lower.contains("obj. number")
            || lower.contains("object number")
            || lower == "id"
            || lower.ends_with(" id")
            || lower.contains("identifier");
        if !id_related {
            filtered.insert(k.clone(), v.clone());
        }
    }
    Value::Object(filtered)
}

/// Compose the single user-facing instruction covering **every** catalogue
/// field for one artefact. Vocab fields are constrained to their allowed terms.
///
/// The message has no hidden behavioural framing: it is just the two-part
/// system instruction (Part 1 = user-edited context prose, Part 2 = the
/// read-only output contract the parser relies on), the artefact record, and
/// one requirement block per field. Field-type rules differ — controlled-vocab
/// fields ask for up to 3 ranked candidates from the list only, open fields ask
/// for a single free-text answer.
fn build_combined_prompt(
    fields: &[FieldSpec],
    record: &Value,
    system_prompt: &str,
    prompt_contract: &str,
) -> String {
    let mut sections = Vec::new();
    let part1 = system_prompt.trim();
    if !part1.is_empty() {
        sections.push(part1.to_string());
    }
    let part2 = prompt_contract.trim();
    if !part2.is_empty() {
        sections.push(part2.to_string());
    }
    sections.push(format!(
        "Artefact File information: {}",
        visible_record(record)
    ));
    for f in fields {
        let block = if f.field_type == "vocab" && !f.allowed.is_empty() {
            format!(
                "_{}_:\n{}\nProvide up to 3 candidates ranked by confidence, drawn ONLY from this controlled vocabulary (use fewer if appropriate; never more than 3 and never a term outside the list): [{}].",
                f.name,
                f.prompt.trim(),
                f.allowed.join(", ")
            )
        } else {
            format!(
                "_{}_:\n{}\nProvide a single free-text answer (no ranking, no list).",
                f.name,
                f.prompt.trim()
            )
        };
        sections.push(block);
    }
    sections.join("\n\n")
}

/// Inlined image attached to a single multimodal prompt: raw bytes + mime type.
/// When `Some`, `do_completion` embeds the image as a content block alongside
/// the text instruction (OpenAI `image_url` / Anthropic `image`).
struct ImageData {
    bytes: Vec<u8>,
    mime: String,
}

/// Build the chat-completions request body for a Standard provider. Pure: no
/// transport, no logging. The body differs by API family and by whether an
/// image is inlined; the user message carries the whole two-part system
/// instruction plus the per-field requirements.
fn build_completion_body(provider: &Provider, user_text: &str, image: Option<&ImageData>) -> Value {
    match provider.api_format {
        ApiFormat::OpenAi => match image {
            Some(img) => {
                let b64 = base64::engine::general_purpose::STANDARD.encode(&img.bytes);
                let data_url = format!("data:{};base64,{}", img.mime, b64);
                json!({
                    "model": provider.model,
                    "messages": [
                        { "role": "user", "content": [
                            { "type": "text", "text": user_text },
                            { "type": "image_url", "image_url": { "url": data_url } }
                        ]}
                    ],
                    "temperature": 0.2
                })
            }
            None => json!({
                "model": provider.model,
                "messages": [
                    { "role": "user", "content": user_text }
                ],
                "temperature": 0.2
            }),
        },
        // Anthropic requires `max_tokens`. One call returns every field, so
        // allow more room.
        ApiFormat::Anthropic => match image {
            Some(img) => {
                let b64 = base64::engine::general_purpose::STANDARD.encode(&img.bytes);
                json!({
                    "model": provider.model,
                    "max_tokens": 4096,
                    "messages": [
                        { "role": "user", "content": [
                            { "type": "image", "source": { "type": "base64", "media_type": img.mime, "data": b64 } },
                            { "type": "text", "text": user_text }
                        ]}
                    ]
                })
            }
            None => json!({
                "model": provider.model,
                "max_tokens": 4096,
                "messages": [
                    { "role": "user", "content": user_text }
                ]
            }),
        },
        // Gemini Interactions API. The whole request is one `input` array; the
        // model id is a body field (not part of the URL), so the endpoint is a
        // single fixed path. Text precedes the image per Gemini's guidance.
        ApiFormat::Gemini => match image {
            Some(img) => {
                let b64 = base64::engine::general_purpose::STANDARD.encode(&img.bytes);
                json!({
                    "model": provider.model,
                    "input": [
                        { "type": "text", "text": user_text },
                        { "type": "image", "data": b64, "mime_type": img.mime }
                    ],
                    "generation_config": { "temperature": 0.2 }
                })
            }
            None => json!({
                "model": provider.model,
                "input": [
                    { "type": "text", "text": user_text }
                ],
                "generation_config": { "temperature": 0.2 }
            }),
        },
    }
}

/// Pull the model's text answer out of a chat-completions response, by API
/// family. Pure: takes the parsed JSON, returns the content string or an error.
fn parse_completion_content(fmt: ApiFormat, v: &Value) -> Result<String, String> {
    // OpenAI: choices[0].message.content. Anthropic: content[0].text.
    let content = match fmt {
        // OpenRouter (and some other providers) may return content as a parts array
        // [{type:"text",text:"..."}] rather than a plain string, so try both.
        ApiFormat::OpenAi => {
            let c = &v["choices"][0]["message"]["content"];
            c.as_str().map(str::to_string)
                .or_else(|| {
                    c.as_array()?.iter()
                        .filter_map(|p| p.get("text").and_then(Value::as_str))
                        .next()
                        .map(str::to_string)
                })
                .ok_or_else(|| "response missing choices[0].message.content".to_string())?
        }
        ApiFormat::Anthropic => v["content"][0]["text"]
            .as_str()
            .ok_or_else(|| "response missing content[0].text".to_string())?.to_string(),
        // Gemini Interactions API: prefer the top-level convenience field, then
        // the current `steps` array, then the legacy `outputs` array (pre the
        // 2026-06 schema sunset). The final entry holds the complete answer.
        ApiFormat::Gemini => v
            .get("output_text")
            .and_then(Value::as_str)
            .or_else(|| gemini_entries_text(v.get("steps")))
            .or_else(|| gemini_entries_text(v.get("outputs")))
            .ok_or_else(|| "response missing output_text / steps / outputs".to_string())?.to_string(),
    };
    Ok(content)
}

/// Read the text out of the last entry of a Gemini Interactions `steps`/`outputs`
/// array. Each entry carries a `content` array of parts whose `text` holds the
/// model's answer; the final entry is the complete response. Scans from the end
/// so a trailing metadata entry without text is skipped.
fn gemini_entries_text(arr: Option<&Value>) -> Option<&str> {
    let arr = arr?.as_array()?;
    arr.iter().rev().find_map(|entry| {
        entry
            .get("content")
            .and_then(Value::as_array)
            .and_then(|parts| {
                parts
                    .iter()
                    .find_map(|p| p.get("text").and_then(Value::as_str))
            })
    })
}

async fn do_completion(
    app: &AppHandle,
    provider: &Provider,
    user_text: &str,
    image: Option<&ImageData>,
) -> Result<(String, String), String> {
    let base = trim_trailing_slash(&provider.base_url);
    let (url, _models_url) = provider.api_format.endpoints(&base);

    // Body construction is isolated in `build_completion_body`; this function
    // owns only transport + boundary logging.
    let body: Value = build_completion_body(provider, user_text, image);
    let auth = provider.api_format.auth(&provider.api_key);

    // One group id per call so the renderer resolves the in-flight "busy" dot
    // (request sent) when the terminal stage lands.
    let job_group = next_call_group();
    log_stage(
        app,
        VisionStageEvent {
            stage: "postSent",
            job_group: job_group.clone(),
            status: "busy",
            label: None,
            detail: Some(url.clone()),
            elapsed_ms: None,
            verbose: Some(VerbosePayload {
                method: Some("POST".to_string()),
                url: Some(url.clone()),
                headers: Some(log_headers(&auth, &provider.api_key)),
                body: Some(redact_body(&body)),
                status: None,
                job_id: None,
                description: None,
                error: None,
            }),
        },
    );

    let client = http_client(Duration::from_secs(TIMEOUT_SECS))?;

    let mut req = client.post(&url).json(&body);
    for (name, value) in auth {
        req = req.header(name, value);
    }

    let started = Instant::now();
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let message = format!("request failed: {e}");
            log_stage(
                app,
                VisionStageEvent {
                    stage: "failed",
                    job_group: job_group.clone(),
                    status: "fail",
                    label: None,
                    detail: Some("transport error".to_string()),
                    elapsed_ms: Some(started.elapsed().as_millis() as u64),
                    verbose: Some(VerbosePayload {
                        method: Some("POST".to_string()),
                        url: Some(url.clone()),
                        error: Some(message.clone()),
                        body: None,
                        headers: None,
                        status: None,
                        job_id: None,
                        description: None,
                    }),
                },
            );
            return Err(message);
        }
    };

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let elapsed = started.elapsed().as_millis() as u64;
    if !status.is_success() {
        log_stage(
            app,
            VisionStageEvent {
                stage: "failed",
                job_group: job_group.clone(),
                status: "fail",
                label: None,
                detail: Some(format!("HTTP {}", status.as_u16())),
                elapsed_ms: Some(elapsed),
                verbose: Some(VerbosePayload {
                    method: Some("POST".to_string()),
                    url: Some(url.clone()),
                    status: Some(status.as_u16()),
                    error: Some(text.clone()),
                    body: None,
                    headers: None,
                    job_id: None,
                    description: None,
                }),
            },
        );
        return Err(format!("HTTP {}: {}", status.as_u16(), text));
    }

    // Parse JSON first so the log description can show the extracted model text
    // rather than a raw 500-char JSON blob.
    let v: Value = serde_json::from_str(&text).map_err(|e| {
        let msg = format!("bad JSON response: {e}");
        log_stage(
            app,
            VisionStageEvent {
                stage: "done",
                job_group: job_group.clone(),
                status: "ok",
                label: None,
                detail: Some(format!("HTTP {} ({}ms)", status.as_u16(), elapsed)),
                elapsed_ms: Some(elapsed),
                verbose: Some(VerbosePayload {
                    method: Some("POST".to_string()),
                    url: Some(url.clone()),
                    status: Some(status.as_u16()),
                    description: Some(text.clone()),
                    error: Some(msg.clone()),
                    body: None,
                    headers: None,
                    job_id: None,
                }),
            },
        );
        msg
    })?;

    let content = match parse_completion_content(provider.api_format, &v) {
        Ok(c) => c,
        Err(e) => {
            log_stage(
                app,
                VisionStageEvent {
                    stage: "done",
                    job_group: job_group.clone(),
                    status: "ok",
                    label: None,
                    detail: Some(format!("HTTP {} ({}ms)", status.as_u16(), elapsed)),
                    elapsed_ms: Some(elapsed),
                    verbose: Some(VerbosePayload {
                        method: Some("POST".to_string()),
                        url: Some(url.clone()),
                        status: Some(status.as_u16()),
                        description: Some(text.clone()),
                        error: Some(e.clone()),
                        body: None,
                        headers: None,
                        job_id: None,
                    }),
                },
            );
            return Err(e);
        }
    };

    // Surface the selected model for OpenRouter free-router debugging (the free
    // router picks a model dynamically; the response `model` field reveals which).
    let selected_model = v["model"].as_str().map(str::to_string);
    let detail = match &selected_model {
        Some(m) => format!("HTTP {} ({}ms) via {}", status.as_u16(), elapsed, m),
        None => format!("HTTP {} ({}ms)", status.as_u16(), elapsed),
    };

    log_stage(
        app,
        VisionStageEvent {
            stage: "done",
            job_group: job_group.clone(),
            status: "ok",
            label: None,
            detail: Some(detail),
            elapsed_ms: Some(elapsed),
            verbose: Some(VerbosePayload {
                method: Some("POST".to_string()),
                url: Some(url.clone()),
                status: Some(status.as_u16()),
                description: Some(content.trim().to_string()),
                body: None,
                headers: None,
                job_id: None,
                error: None,
            }),
        },
    );

    Ok((content, job_group))
}

/// Parse the model's raw text answer into per-field suggestions. Tolerates a
/// leading code fence or surrounding prose by extracting the outermost JSON
/// object. Field handling diverges by type:
/// - **vocab** fields read a `[{value, confidence}]` array (confidence clamped
///   0..1). An item that's a bare string (a weaker model skipping the
///   `{value, confidence}` wrapper) is accepted too, at confidence 0.0.
/// - **open** fields read a single answer, tolerating the several shapes a model
///   may wrap it in (see `parse_open_value`). The single value becomes one
///   suggestion at confidence 0.0 (open fields carry no ranking).
///
/// Returns the parsed result alongside a list of human-readable warnings for
/// any field that ended up with zero suggestions despite being requested —
/// distinguishing "the model dropped this field's key entirely" from "the key
/// was present but its value couldn't be turned into a suggestion" — so a
/// caller can surface *why* a field came back empty instead of it silently
/// rendering blank in the UI.
fn parse_field_results(
    content: &str,
    fields: &[FieldSpec],
) -> Result<(CatalogueResult, Vec<String>), String> {
    let json_str = extract_json_object(content).ok_or_else(|| {
        format!(
            "model returned bad JSON: no object found (raw: {})",
            content
        )
    })?;
    let parsed: Value = serde_json::from_str(json_str).map_err(|e| {
        format!(
            "model returned bad JSON: {e} (raw: {})",
            content
        )
    })?;
    let obj = parsed.as_object().ok_or_else(|| {
        format!(
            "model returned non-object JSON (raw: {})",
            content
        )
    })?;
    // The contract asks the model to key every field as `_<Field Name>_`, but
    // models drop one or both underscores often enough — even mid-response,
    // even on controlled-vocabulary fields whose value shape is otherwise
    // well-formed — that treating the decoration as load-bearing produces
    // frequent false "key missing" warnings. Normalize away leading/trailing
    // underscores on both sides of the comparison so `_Name_`, `_Name`,
    // `Name_`, and bare `Name` are all treated as the same key, for every
    // field type alike.
    let normalized: std::collections::HashMap<&str, &Value> = obj
        .iter()
        .map(|(k, v)| (k.trim_matches('_'), v))
        .collect();

    let mut field_results = std::collections::BTreeMap::new();
    let mut warnings = Vec::new();
    for f in fields {
        let is_vocab = f.field_type == "vocab";
        let value = normalized.get(f.name.as_str()).copied();
        let key_present = value.is_some();
        let sugs: Vec<Suggestion> = match value {
            Some(v) if is_vocab => match v {
                Value::Array(a) => a
                    .iter()
                    .filter_map(|item| {
                        if let Some(s) = item.as_str() {
                            return Some(Suggestion {
                                value: s.to_string(),
                                confidence: 0.0,
                            });
                        }
                        let value = item.get("value")?.as_str()?.to_string();
                        let confidence = item
                            .get("confidence")
                            .and_then(Value::as_f64)
                            .unwrap_or(0.0)
                            .clamp(0.0, 1.0);
                        Some(Suggestion { value, confidence })
                    })
                    .collect(),
                _ => Vec::new(),
            },
            Some(v) => parse_open_value(v)
                .map(|value| {
                    vec![Suggestion {
                        value,
                        confidence: 0.0,
                    }]
                })
                .unwrap_or_default(),
            None => Vec::new(),
        };
        if sugs.is_empty() {
            warnings.push(if key_present {
                format!("{}: key present but no usable candidates", f.name)
            } else {
                format!("{}: key missing from response", f.name)
            });
        }
        field_results.insert(f.name.clone(), sugs);
    }
    Ok((CatalogueResult { field_results }, warnings))
}

/// Read an open-ended field's single answer out of whatever shape the model
/// returned: a bare JSON string, `{"value": "..."}`, or a one-element
/// `[{value, confidence}]` array. Returns the string value, or `None` if no
/// value could be extracted.
///
/// As a last resort, an object that doesn't match `{"value": ...}` (e.g. a
/// model answering a multi-part question like Inscription's "raw text" +
/// "translated" with its own nested keys) is flattened into a single
/// `"Key: value / Key: value"` string rather than discarded — the contract
/// only promises the model a single free-text answer, not a specific object
/// shape, so any object it invents is still a real answer worth keeping.
fn parse_open_value(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    if let Some(s) = v.get("value").and_then(Value::as_str) {
        return Some(s.to_string());
    }
    if let Some(first) = v.as_array().and_then(|a| a.first()) {
        if let Some(s) = first.get("value").and_then(Value::as_str) {
            return Some(s.to_string());
        }
        if let Some(s) = first.as_str() {
            return Some(s.to_string());
        }
    }
    if let Some(obj) = v.as_object() {
        if obj.is_empty() {
            return None;
        }
        let parts: Vec<String> = obj
            .iter()
            .map(|(k, val)| {
                let rendered = val.as_str().map(str::to_string).unwrap_or_else(|| val.to_string());
                format!("{k}: {rendered}")
            })
            .collect();
        return Some(parts.join(" / "));
    }
    None
}

/// Pull the outermost JSON object out of a model answer that may be wrapped in a
/// code fence or padded with prose. Returns the matching substring, or `None`.
fn extract_json_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    // Walk braces, respecting strings, to find the matching close of the first
    // top-level object. This is deliberately simple — it only needs to skip
    // braces inside string literals, which is enough for well-formed model JSON.
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        let c = b as char;
        if in_string {
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Cancel an in-flight `catalogue_artefact` call by job id. Idempotent: a job
/// that already finished (or was never registered) is a no-op. Firing the
/// oneshot makes the matching `select!` in `catalogue_artefact` drop the
/// reqwest future, closing the socket — a real transport-level abort, not just
/// a renderer-side status flip.
#[tauri::command]
pub async fn cancel_catalogue(
    cancel_registry: State<'_, CancelRegistry>,
    job_id: String,
) -> Result<(), String> {
    let tx = {
        cancel_registry
            .lock()
            .map_err(|e| format!("cancel registry poisoned: {e}"))?
            .remove(&job_id)
    };
    // A send error means the receiver was already dropped (call finished); the
    // cancel is moot but still successful from the caller's perspective.
    let _ = tx.map(|tx| tx.send(()));
    Ok(())
}

/// Catalogue one artefact in a single LLM round-trip via the active provider.
/// Sends one multimodal chat-completions POST with the image inlined; the model
/// returns JSON covering every field.
///
/// The HTTP call is raced against a per-job cancellation signal: `cancel_catalogue`
/// fires the matching oneshot, this `select!` drops the in-flight reqwest future
/// (closing the socket → true transport abort), and the call resolves with
/// [`CANCEL_ERROR`]. The job id comes from the renderer (`"row-<uid>"`) and is
/// unique per outstanding call, enforced by the renderer's `processing` guard.
#[tauri::command]
pub async fn catalogue_artefact(
    app: AppHandle,
    cancel_registry: State<'_, CancelRegistry>,
    job_id: String,
    provider: Provider,
    fields: Vec<FieldSpec>,
    artefact: ArtefactInput,
) -> Result<CatalogueResult, String> {
    // Read the image once (if present); both transports consume the same bytes.
    // The renderer is untrusted, so the absolute image path is validated to lie
    // inside the image scratch dir before it is read.
    let image: Option<ImageData> = match artefact.image_path.as_deref() {
        Some(p) if !p.is_empty() => {
            let resolved = crate::images::validate_scratch_path(p)?;
            let bytes = std::fs::read(&resolved).map_err(|e| format!("read image failed: {e}"))?;
            Some(ImageData {
                bytes,
                mime: guess_mime(p),
            })
        }
        _ => None,
    };

    // A single combined prompt covering every requested field.
    let prompt = build_combined_prompt(
        &fields,
        &artefact.record,
        &artefact.system_prompt,
        &artefact.system_prompt_contract,
    );

    // Register this call's cancel signal before starting the request so a
    // cancel that arrives the instant the POST begins can't race past the
    // registration. A stale sender under this key (only possible if a previous
    // call for the same job was dropped without being removed) is replaced and
    // dropped — its receiver is already gone.
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    {
        let mut map = cancel_registry
            .lock()
            .map_err(|e| format!("cancel registry poisoned: {e}"))?;
        map.insert(job_id.clone(), cancel_tx);
    }
    // Drop-guard: whatever path we take out of this function, the entry must be
    // removed or a later cancel for the same job id finds a dead sender.
    struct CancelGuard<'a> {
        registry: &'a CancelRegistry,
        job_id: String,
    }
    impl Drop for CancelGuard<'_> {
        fn drop(&mut self) {
            if let Ok(mut map) = self.registry.lock() {
                map.remove(&self.job_id);
            }
        }
    }
    let _guard = CancelGuard {
        registry: &*cancel_registry,
        job_id: job_id.clone(),
    };

    // Race the completion against the cancel signal. Dropping `do_completion`'s
    // future aborts the in-flight reqwest request (its async client closes the
    // connection on drop), so a cancel terminates the network call, not just
    // the await.
    let completion = do_completion(&app, &provider, &prompt, image.as_ref());
    let (content, job_group) = tokio::select! {
        biased;
        _ = cancel_rx => return Err(CANCEL_ERROR.to_string()),
        result = completion => result?,
    };

    let (result, warnings) = parse_field_results(&content, &fields)?;

    // The model's own contract promises every requested field appears as a
    // key (`_DEF_SYSTEM_PROMPT_CONTRACT`), but nothing enforces that — a
    // field can silently render blank in the UI with no trace of why. Surface
    // it as a soft warning on the same call's Logs Viewer entry rather than
    // failing the whole request, since the other fields still parsed fine.
    if !warnings.is_empty() {
        log_stage(
            &app,
            VisionStageEvent {
                stage: "done",
                job_group,
                status: "ok",
                label: Some("field parse warnings".to_string()),
                detail: Some(warnings.join("; ")),
                elapsed_ms: None,
                verbose: Some(VerbosePayload {
                    method: None,
                    url: None,
                    headers: None,
                    body: None,
                    status: None,
                    job_id: None,
                    description: Some(content.clone()),
                    error: None,
                }),
            },
        );
    }

    Ok(result)
}

/// Assemble the single combined prompt exactly as `catalogue_artefact` would
/// send it, without making any network call. Used by the Settings "Prompt
/// Preview" tab to show the final message (including all hardcoded framing) for
/// a parsing job. The `artefact.record` is runtime-only data the Settings view
/// doesn't have, so callers pass an empty object and the preview shows it as a
/// placeholder; everything else reflects the live field/contract/prompt config.
#[tauri::command]
pub fn build_prompts_preview(fields: Vec<FieldSpec>, artefact: ArtefactInput) -> String {
    build_combined_prompt(
        &fields,
        &artefact.record,
        &artefact.system_prompt,
        &artefact.system_prompt_contract,
    )
}

/// Ping the provider to validate the URL + key. Hits the format-appropriate
/// `/models` endpoint (cheap GET) and returns the advertised model ids so the
/// UI can populate its model dropdown.
#[tauri::command]
pub async fn test_connection(provider: Provider) -> Result<ConnectionTest, String> {
    let base = trim_trailing_slash(&provider.base_url);
    let (_completions, url) = provider.api_format.endpoints(&base);

    let client = http_client(Duration::from_secs(20))?;

    let mut req = client.get(&url);
    for (name, value) in provider.api_format.auth(&provider.api_key) {
        req = req.header(name, value);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return Err(format!("request failed: {e}"));
        }
    };

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("response body read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), text));
    }

    // Both OpenAI and Anthropic return `{"data":[{"id":"..."}, ...]}`. Gemini
    // returns `{"models":[{"name":"models/<id>"}, ...]}` — strip the `models/`
    // prefix so the value matches the id the request body expects.
    let mut models: Vec<String> = Vec::new();
    if let Ok(v) = serde_json::from_str::<Value>(&text) {
        match provider.api_format {
            ApiFormat::Gemini => {
                if let Some(arr) = v.get("models").and_then(Value::as_array) {
                    models = arr
                        .iter()
                        .filter_map(|m| m.get("name").and_then(Value::as_str).map(strip_models_prefix))
                        .collect();
                    models.sort();
                }
            }
            _ => {
                if let Some(arr) = v.get("data").and_then(Value::as_array) {
                    models = arr
                        .iter()
                        .filter_map(|m| m.get("id").and_then(Value::as_str).map(String::from))
                        .collect();
                    models.sort();
                }
            }
        }
    }

    Ok(ConnectionTest {
        ok: "Connection successful".to_string(),
        models,
    })
}

/// Drop a leading `models/` from a Gemini model name so the value matches the
/// bare id the Interactions request body expects (e.g. `models/gemini-3.5-flash`
/// → `gemini-3.5-flash`).
fn strip_models_prefix(name: &str) -> String {
    name.strip_prefix("models/").unwrap_or(name).to_string()
}

fn guess_mime(path: &str) -> String {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        "image/png".to_string()
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg".to_string()
    } else if lower.ends_with(".gif") {
        "image/gif".to_string()
    } else if lower.ends_with(".webp") {
        "image/webp".to_string()
    } else {
        "image/png".to_string()
    }
}


#[cfg(test)]
mod tests {
    use super::*;

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

    fn open_field(name: &str) -> FieldSpec {
        FieldSpec {
            name: name.to_string(),
            field_type: "open".to_string(),
            prompt: String::new(),
            allowed: Vec::new(),
        }
    }

    fn vocab_field(name: &str, allowed: &[&str]) -> FieldSpec {
        FieldSpec {
            name: name.to_string(),
            field_type: "vocab".to_string(),
            prompt: String::new(),
            allowed: allowed.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn open_field_nested_object_is_flattened_instead_of_dropped() {
        let content = r#"{"_Inscription_": {"Raw text": "abc", "Translated": "xyz"}}"#;
        let fields = vec![open_field("Inscription")];
        let (result, warnings) = parse_field_results(content, &fields).unwrap();
        let sugs = &result.field_results["Inscription"];
        assert_eq!(sugs.len(), 1);
        assert!(sugs[0].value.contains("Raw text: abc"));
        assert!(sugs[0].value.contains("Translated: xyz"));
        assert!(warnings.is_empty());
    }

    #[test]
    fn vocab_field_accepts_bare_strings_alongside_value_objects() {
        let content = r#"{"_Style_": ["Colonial", {"value": "Realist", "confidence": 0.8}]}"#;
        let fields = vec![vocab_field("Style", &["Colonial", "Realist"])];
        let (result, warnings) = parse_field_results(content, &fields).unwrap();
        let sugs = &result.field_results["Style"];
        assert_eq!(sugs.len(), 2);
        assert_eq!(sugs[0].value, "Colonial");
        assert_eq!(sugs[0].confidence, 0.0);
        assert_eq!(sugs[1].value, "Realist");
        assert_eq!(sugs[1].confidence, 0.8);
        assert!(warnings.is_empty());
    }

    #[test]
    fn open_field_falls_back_to_bare_key_when_undecorated() {
        let content = r#"{"Materials": "paper and gilt"}"#;
        let fields = vec![open_field("Materials")];
        let (result, warnings) = parse_field_results(content, &fields).unwrap();
        let sugs = &result.field_results["Materials"];
        assert_eq!(sugs.len(), 1);
        assert_eq!(sugs[0].value, "paper and gilt");
        assert!(warnings.is_empty());
    }

    #[test]
    fn vocab_field_matches_bare_or_partially_decorated_key() {
        let content = r#"{"Style": ["Colonial"]}"#;
        let fields = vec![vocab_field("Style", &["Colonial"])];
        let (result, warnings) = parse_field_results(content, &fields).unwrap();
        assert_eq!(result.field_results["Style"][0].value, "Colonial");
        assert!(warnings.is_empty());
    }

    /// Real trace: a model answered every field (two open, two vocab) with
    /// the leading underscore only, dropping the trailing one — including on
    /// vocab fields, whose otherwise well-formed array values proved the
    /// model wasn't confused about content, just sloppy about the key form.
    #[test]
    fn mixed_fields_keyed_with_leading_underscore_only_produce_no_warnings() {
        let content = r#"{
            "_Description": "A rectangular document on aged paper.",
            "_Style": [{"value": "Colonial", "confidence": 0.8}],
            "_Material": [{"value": "Paper", "confidence": 1.0}],
            "_Inscription": "Raw text: ..."
        }"#;
        let fields = vec![
            open_field("Description"),
            vocab_field("Style", &["Colonial"]),
            vocab_field("Material", &["Paper"]),
            open_field("Inscription"),
        ];
        let (result, warnings) = parse_field_results(content, &fields).unwrap();
        assert!(warnings.is_empty());
        assert!(!result.field_results["Description"].is_empty());
        assert_eq!(result.field_results["Style"][0].value, "Colonial");
        assert_eq!(result.field_results["Material"][0].value, "Paper");
        assert!(!result.field_results["Inscription"].is_empty());
    }

    #[test]
    fn missing_key_produces_a_distinct_warning_from_unparseable_value() {
        let content = r#"{"_Materials_": "paper", "_Style_": [123]}"#;
        let fields = vec![
            open_field("Inscription"),
            vocab_field("Style", &["Colonial"]),
        ];
        let (result, warnings) = parse_field_results(content, &fields).unwrap();
        assert!(result.field_results["Inscription"].is_empty());
        assert!(result.field_results["Style"].is_empty());
        assert_eq!(warnings.len(), 2);
        assert!(warnings.iter().any(|w| w.contains("Inscription") && w.contains("key missing")));
        assert!(warnings.iter().any(|w| w.contains("Style") && w.contains("no usable candidates")));
    }
}
