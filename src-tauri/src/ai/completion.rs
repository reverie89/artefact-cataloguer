//! The chat-completions round trip: the multi-turn conversation model
//! (`Turn`/`ImageData`), per-provider request-body serialization
//! (`build_completion_body`), per-provider answer extraction
//! (`parse_completion_content`), and `do_completion`, the HTTP call itself.
//!
//! Serialization and transport deliberately live together in this one module:
//! `do_completion` interleaves its boundary logging with the request/response
//! flow, so a clean split would need an emitter/callback abstraction first.
//! The pure serialization/extraction halves are kept free of transport and
//! logging concerns (they take JSON in / return values out).

// `Engine` must be in scope to call `base64::engine::general_purpose::STANDARD.encode`.
use base64::Engine;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime};

use super::logging::{
    log_headers, log_stage, next_call_group, redact_body, PipelineStageEvent, VerbosePayload,
};
use super::transport::{http_client, trim_trailing_slash, TIMEOUT_SECS};
use super::types::{ApiFormat, CustomBodyKind, FormField, FormFieldType, Provider, ThinkingEffort};

/// Inlined image attached to a single multimodal prompt: raw bytes + mime type.
/// When `Some`, `do_completion` embeds the image as a content block alongside
/// the text instruction (OpenAI `image_url` / Anthropic `image`). `Clone`
/// because a `Turn` may carry an image and the cataloguing pipeline clones
/// turns into the threaded conversation.
#[derive(Clone, Debug)]
pub(crate) struct ImageData {
    pub(crate) bytes: Vec<u8>,
    pub(crate) mime: String,
}

/// One turn of a multi-turn conversation sent to a chat-completions provider.
/// The cataloguing pipeline threads validation (vocab validation) onto artefact
/// analysis (image + extraction) so the model keeps the image and its own
/// analysis in context while picking vocab candidates. An image attaches only
/// to the turn that carries it (artefact analysis's user turn); validation's
/// user turn is text-only but still sees the earlier image via the replayed
/// artefact-analysis history.
#[derive(Clone)]
pub(crate) struct Turn {
    pub role: TurnRole,
    pub text: String,
    pub image: Option<ImageData>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnRole {
    User,
    Assistant,
}

impl TurnRole {
    /// Role label for the Anthropic/OpenAI `messages` array.
    fn as_str(&self) -> &'static str {
        match self {
            TurnRole::User => "user",
            TurnRole::Assistant => "assistant",
        }
    }
}

/// The request body `build_completion_body` materializes: every native format
/// (and custom-JSON) produces a JSON value; custom-multipart produces its form
/// description. `do_completion` turns either into the outgoing request.
#[derive(Debug)]
pub(crate) enum CompletionBody {
    Json(Value),
    Multipart {
        /// The image every file part carries.
        image: ImageData,
        /// Rows in authored order — list order is field order on the wire.
        parts: Vec<MultipartPart>,
    },
}

/// One custom-multipart form row (see `FormField`): a text field with its
/// tokens already substituted, or a file part carrying the artefact image.
#[derive(Debug)]
pub(crate) enum MultipartPart {
    Text { key: String, value: String },
    File { key: String },
}

/// Build the chat-completions request body for one conversation (possibly
/// multi-turn). Pure: no transport, no logging. The body differs by API family;
/// each provider encodes the turns as its native multi-turn shape (OpenAI /
/// Anthropic `messages` array; Gemini Interactions `input` array of steps).
/// An image attached to a turn is inlined as a content block on that turn only
/// — later text-only turns still see it via the conversation history. The
/// custom family flattens the conversation into its single `input` string and
/// shapes the body from the user-authored template/form (see the variant doc
/// in `types.rs`).
fn build_completion_body(provider: &Provider, turns: &[Turn]) -> Result<CompletionBody, String> {
    match provider.api_format {
        ApiFormat::OpenAi => {
            let messages: Vec<Value> = turns
                .iter()
                .map(|t| match (&t.image, t.role) {
                    (Some(img), TurnRole::User) => {
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&img.bytes);
                        let data_url = format!("data:{};base64,{}", img.mime, b64);
                        json!({
                            "role": t.role.as_str(),
                            "content": [
                                { "type": "text", "text": t.text },
                                { "type": "image_url", "image_url": { "url": data_url } }
                            ]
                        })
                    }
                    _ => json!({ "role": t.role.as_str(), "content": t.text }),
                })
                .collect();
            let mut body = json!({
                "model": provider.model,
                "messages": messages,
                "temperature": 0.2
            });
            if let Some(effort) = provider.thinking {
                body["reasoning_effort"] = json!(effort);
            }
            Ok(CompletionBody::Json(body))
        }
        // Anthropic requires `max_tokens`.
        ApiFormat::Anthropic => {
            let messages: Vec<Value> = turns
                .iter()
                .map(|t| match (&t.image, t.role) {
                    (Some(img), TurnRole::User) => {
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&img.bytes);
                        json!({
                            "role": t.role.as_str(),
                            "content": [
                                { "type": "image", "source": { "type": "base64", "media_type": img.mime, "data": b64 } },
                                { "type": "text", "text": t.text }
                            ]
                        })
                    }
                    _ => json!({ "role": t.role.as_str(), "content": t.text }),
                })
                .collect();
            let mut body = json!({
                "model": provider.model,
                "max_tokens": 4096,
                "messages": messages
            });
            if let Some(effort) = provider.thinking {
                // Anthropic takes a token budget rather than a level; it must
                // stay below `max_tokens`. Thinking and the answer share that
                // cap, and endpoints vary in how strictly they honour the
                // budget (z.ai GLM thinks well past it), so the cap must cover
                // a full catalogue answer PLUS thinking. 32000 stays within the
                // output limit of every thinking-capable Claude model
                // (opus-4/4.1 cap at 32k).
                let budget_tokens = match effort {
                    ThinkingEffort::Low => 2048,
                    ThinkingEffort::Medium => 8192,
                    ThinkingEffort::High => 12288,
                };
                body["max_tokens"] = json!(32000);
                body["thinking"] = json!({ "type": "enabled", "budget_tokens": budget_tokens });
            }
            Ok(CompletionBody::Json(body))
        }
        // Gemini Interactions API: the whole request is one `input` array of
        // steps (multi-turn), text preceding any image per Gemini's guidance.
        ApiFormat::Gemini => {
            let mut input: Vec<Value> = Vec::new();
            for t in turns {
                if let Some(img) = &t.image {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&img.bytes);
                    input.push(json!({ "type": "text", "text": t.text }));
                    input.push(json!({ "type": "image", "data": b64, "mime_type": img.mime }));
                } else {
                    input.push(json!({ "type": "text", "text": t.text }));
                }
            }
            let mut body = json!({
                "model": provider.model,
                "input": input,
                "generation_config": { "temperature": 0.2 }
            });
            if let Some(effort) = provider.thinking {
                body["generation_config"]["thinking_level"] = json!(effort);
            }
            Ok(CompletionBody::Json(body))
        }
        // Custom gateways POST the user-authored body (`body_kind`): the JSON
        // message template, or a multipart form whose text rows take the
        // tokens and file rows carry the image. Either way the image must
        // have a destination — it fails loudly rather than being silently
        // dropped. Only the first image turn's image is sent: custom bodies
        // are single-image shapes.
        ApiFormat::Custom => {
            let input = turns
                .iter()
                .map(|t| t.text.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            let image = turns.iter().find_map(|t| t.image.as_ref());
            match provider.body_kind {
                CustomBodyKind::Json => build_custom_body(&provider.body_template, &input, image)
                    .map(CompletionBody::Json),
                CustomBodyKind::Multipart => {
                    build_custom_multipart(&provider.form_fields, &input, image)
                }
            }
        }
    }
}

/// The token a custom body's template or text form rows must carry —
/// replaced with the flattened prompt text.
const CUSTOM_INPUT_TOKEN: &str = "{{input}}";
/// Replaced with the artefact image's raw base64. Empty when the call carries
/// no image — but a body referencing the token then fails the build instead.
const CUSTOM_IMAGE_TOKEN: &str = "{{image}}";
/// Replaced with the artefact image's mime type (empty when there is none).
const CUSTOM_MIME_TOKEN: &str = "{{mime}}";

/// Which custom tokens a substitution pass saw. `{{input}}` and `{{image}}`
/// drive the build-time validation; `{{mime}}` is free to come and go.
#[derive(Default)]
struct TokenHits {
    input: bool,
    image: bool,
}

/// Replace every token occurrence in one string value, recording what was
/// seen. Shared by the JSON template walker and the multipart text rows so
/// both body modes accept exactly the same token set.
fn replace_tokens(
    s: &str,
    input: &str,
    image_b64: Option<&str>,
    mime: &str,
    hits: &mut TokenHits,
) -> String {
    if s.contains(CUSTOM_INPUT_TOKEN) {
        hits.input = true;
    }
    if s.contains(CUSTOM_IMAGE_TOKEN) {
        hits.image = true;
    }
    s.replace(CUSTOM_INPUT_TOKEN, input)
        .replace(CUSTOM_IMAGE_TOKEN, image_b64.unwrap_or(""))
        .replace(CUSTOM_MIME_TOKEN, mime)
}

/// Base64 + mime pair for token substitution; `None`/empty when the call
/// carries no image.
fn image_tokens(image: Option<&ImageData>) -> (Option<String>, String) {
    match image {
        Some(img) => (
            Some(base64::engine::general_purpose::STANDARD.encode(&img.bytes)),
            img.mime.clone(),
        ),
        None => (None, String::new()),
    }
}

/// Materialize a custom provider's user-typed JSON message template into the
/// request body. The template must parse as JSON and carry `{{input}}`; when
/// the call carries the artefact image it must also carry `{{image}}` — the
/// image never silently drops. The substitution happens on the parsed
/// `Value`, so arbitrary prompt text (quotes, newlines) is re-escaped safely
/// by serde on the way out. Errors name the exact defect: empty template,
/// invalid JSON, a missing token, or an image mismatch.
fn build_custom_body(
    template: &str,
    input: &str,
    image: Option<&ImageData>,
) -> Result<Value, String> {
    if template.trim().is_empty() {
        return Err(
            "custom provider has no message format — set it on the provider card".to_string(),
        );
    }
    let mut body: Value = serde_json::from_str(template)
        .map_err(|e| format!("message format is not valid JSON: {e}"))?;
    let (image_b64, mime) = image_tokens(image);
    let mut hits = TokenHits::default();
    substitute_custom_tokens(&mut body, input, image_b64.as_deref(), &mime, &mut hits);
    if !hits.input {
        return Err(format!(
            "message format must include {CUSTOM_INPUT_TOKEN} — the prompt text has nowhere to go"
        ));
    }
    if !hits.image && image.is_some() {
        return Err(
            "the message format cannot carry the artefact image — add {{image}} (raw base64) or switch the body to the multipart form"
                .to_string(),
        );
    }
    if hits.image && image.is_none() {
        return Err(format!(
            "the message format references {CUSTOM_IMAGE_TOKEN} but this call carries no image"
        ));
    }
    Ok(body)
}

/// Walk `v`, replacing every token occurrence inside string values.
fn substitute_custom_tokens(
    v: &mut Value,
    input: &str,
    image_b64: Option<&str>,
    mime: &str,
    hits: &mut TokenHits,
) {
    match v {
        Value::String(s) => {
            *s = replace_tokens(s, input, image_b64, mime, hits);
        }
        Value::Array(items) => {
            for item in items {
                substitute_custom_tokens(item, input, image_b64, mime, hits);
            }
        }
        Value::Object(map) => {
            for value in map.values_mut() {
                substitute_custom_tokens(value, input, image_b64, mime, hits);
            }
        }
        _ => {}
    }
}

/// Materialize a custom provider's multipart form: text rows carry the
/// tokens, file rows all carry the artefact image as binary parts. Validation
/// mirrors the JSON template's rules — the prompt must land in a text row
/// (`{{input}}`) and the image must leave through a file row, loudly.
fn build_custom_multipart(
    fields: &[FormField],
    input: &str,
    image: Option<&ImageData>,
) -> Result<CompletionBody, String> {
    if fields.is_empty() {
        return Err(
            "custom provider has no form fields — add them on the provider card".to_string(),
        );
    }
    let (image_b64, mime) = image_tokens(image);
    let mut parts: Vec<MultipartPart> = Vec::new();
    let mut hits = TokenHits::default();
    let mut file_rows = 0usize;
    for field in fields {
        let key = field.key.trim();
        if key.is_empty() {
            return Err("a form field has no name — set the key on every row".to_string());
        }
        match field.field_type {
            FormFieldType::File => {
                file_rows += 1;
                parts.push(MultipartPart::File {
                    key: key.to_string(),
                });
            }
            FormFieldType::Text => {
                let value =
                    replace_tokens(&field.value, input, image_b64.as_deref(), &mime, &mut hits);
                parts.push(MultipartPart::Text {
                    key: key.to_string(),
                    value,
                });
            }
        }
    }
    if !hits.input {
        return Err(format!(
            "the form needs {CUSTOM_INPUT_TOKEN} in a text field — the prompt text has nowhere to go"
        ));
    }
    if file_rows == 0 {
        return Err(
            "the form needs a file field — the artefact image has nowhere to go".to_string(),
        );
    }
    let image = image.ok_or_else(|| {
        "the multipart form sends the artefact image as a file field but this call carries none"
            .to_string()
    })?;
    Ok(CompletionBody::Multipart {
        image: image.clone(),
        parts,
    })
}

/// One-line description of a multipart form for the boundary log: field
/// names and sizes only — the image bytes never reach the log.
fn multipart_log_body(image: &ImageData, parts: &[MultipartPart]) -> String {
    let fields = parts
        .iter()
        .map(|p| match p {
            MultipartPart::Text { key, value } => format!("{key}=<text {} chars>", value.len()),
            MultipartPart::File { key } => {
                format!("{key}=<file {} {}B>", image.mime, image.bytes.len())
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("<multipart: {fields}>")
}

/// File-name extension for the multipart file part, from the image mime.
fn mime_ext(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "bin",
    }
}

/// Error returned when the model stopped because it exhausted its output
/// budget. Surfed explicitly (instead of parsing the partial text and letting
/// the XML contract complain about "missing" blocks) because the real cause —
/// and its fix — is the output budget, not the response format.
const TRUNCATED_ERR: &str = "response hit max_tokens before finishing — if this model thinks by default (e.g. GLM-5.3), set Thinking to Low or higher to raise the output budget";

/// Pull the model's text answer out of a chat-completions response, by API
/// family. Pure: takes the parsed JSON, returns the content string or an
/// error, delegating to the per-dialect helpers (which the custom family
/// chains across — see `parse_custom_answer`).
fn parse_completion_content(fmt: ApiFormat, v: &Value) -> Result<String, String> {
    match fmt {
        ApiFormat::OpenAi => parse_openai_answer(v),
        ApiFormat::Anthropic => parse_anthropic_answer(v),
        ApiFormat::Gemini => parse_gemini_answer(v),
        ApiFormat::Custom => parse_custom_answer(v),
    }
}

/// OpenAI dialect: `choices[0].message.content`, a plain string or a parts
/// array. Reasoning models carry chain-of-thought beside `message.content`;
/// only `content` is the answer. A `finish_reason` of "length" is the
/// truncation error, not partial content.
fn parse_openai_answer(v: &Value) -> Result<String, String> {
    if v["choices"][0]["finish_reason"].as_str() == Some("length") {
        return Err(TRUNCATED_ERR.to_string());
    }
    let c = &v["choices"][0]["message"]["content"];
    let mut parts: Vec<&str> = Vec::new();
    if let Some(s) = c.as_str() {
        parts.push(s);
    } else if let Some(arr) = c.as_array() {
        parts.extend(
            arr.iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str)),
        );
    }
    (!parts.is_empty())
        .then(|| parts.concat())
        .ok_or_else(|| "response missing choices[0].message.content".to_string())
}

/// Anthropic dialect: `content` holds typed blocks; reasoning models put a
/// "thinking" block ahead of the answer's "text" block(s). A `stop_reason` of
/// "max_tokens" is the truncation error, not partial content.
fn parse_anthropic_answer(v: &Value) -> Result<String, String> {
    if v["stop_reason"].as_str() == Some("max_tokens") {
        return Err(TRUNCATED_ERR.to_string());
    }
    let mut text = String::new();
    let mut types: Vec<&str> = Vec::new();
    if let Some(blocks) = v["content"].as_array() {
        for b in blocks {
            let ty = b["type"].as_str().unwrap_or("unknown");
            types.push(ty);
            if ty == "text" {
                text.push_str(b["text"].as_str().unwrap_or(""));
            }
        }
    }
    let got = if types.is_empty() {
        "no content array".to_string()
    } else {
        format!("got {}", types.join(", "))
    };
    (!text.is_empty())
        .then_some(text)
        .ok_or_else(|| format!("response content has no text ({got})"))
}

/// Gemini Interactions API dialect: prefer the top-level convenience field,
/// then the current `steps` array, then the legacy `outputs` array (pre the
/// 2026-06 schema sunset). The final entry holds the complete answer.
fn parse_gemini_answer(v: &Value) -> Result<String, String> {
    v.get("output_text")
        .and_then(Value::as_str)
        .or_else(|| gemini_entries_text(v.get("steps")))
        .or_else(|| gemini_entries_text(v.get("outputs")))
        .map(str::to_string)
        .ok_or_else(|| "response missing output_text / steps / outputs".to_string())
}

/// Custom gateways answer in whichever dialect their message template speaks:
/// the flat reference contract answers `{"output": "<text>"}`, and the
/// OpenAI / Anthropic / Gemini template baselines get their native response
/// shapes — so the dialect helpers are tried in order. Truncation signals are
/// checked first so a max-tokens stop surfaces instead of falling through the
/// shape chain as "unrecognized". Nothing matching names the observed
/// top-level keys: the first real response corrects the contract instead of a
/// guess.
fn parse_custom_answer(v: &Value) -> Result<String, String> {
    if v["choices"][0]["finish_reason"].as_str() == Some("length")
        || v["stop_reason"].as_str() == Some("max_tokens")
    {
        return Err(TRUNCATED_ERR.to_string());
    }
    if let Some(s) = v
        .get("output")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        return Ok(s.to_string());
    }
    for parse in [
        parse_openai_answer,
        parse_anthropic_answer,
        parse_gemini_answer,
    ] {
        if let Ok(text) = parse(v) {
            return Ok(text);
        }
    }
    Err(match v.as_object() {
        Some(o) => {
            let mut keys: Vec<&str> = o.keys().map(String::as_str).collect();
            keys.sort_unstable();
            format!(
                "no recognizable answer text in the response (got keys: {})",
                keys.join(", ")
            )
        }
        None => "response was not a JSON object with recognizable answer text".to_string(),
    })
}

/// Read the text out of the last entry of a Gemini Interactions `steps`/`outputs`
/// array. Each entry carries a `content` array of parts whose `text` holds the
/// model's answer; the final entry is the complete response. Scans from the end
/// so a trailing metadata entry without text is skipped. Entries with
/// `type: "thought"` hold reasoning summaries, never the answer, and are
/// skipped so thinking output can't leak into extraction.
fn gemini_entries_text(arr: Option<&Value>) -> Option<&str> {
    let arr = arr?.as_array()?;
    arr.iter()
        .rev()
        .filter(|entry| entry.get("type").and_then(Value::as_str) != Some("thought"))
        .find_map(|entry| {
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

/// Generic over the runtime so the live-pipeline probe can run the real
/// command against a mock app (production infers `R = Wry`).
pub(crate) async fn do_completion<R: Runtime>(
    app: &AppHandle<R>,
    provider: &Provider,
    label: &str,
    row_id: &str,
    turns: &[Turn],
) -> Result<(String, String), String> {
    let base = trim_trailing_slash(&provider.base_url);
    let (url, _models_url) = provider.api_format.endpoints(&base);

    // Body construction is isolated in `build_completion_body`; this function
    // owns only transport + boundary logging.
    let body: CompletionBody = build_completion_body(provider, turns)?;
    let auth = provider
        .api_format
        .auth(&provider.api_key, &provider.auth_header);

    // One group id per call so the renderer resolves the in-flight "busy" dot
    // (request sent) when the terminal stage lands. The label identifies which
    // pipeline step this call belongs to ("Artefact Analysis" / "Cataloguing").
    let job_group = next_call_group();
    log_stage(
        app,
        PipelineStageEvent {
            stage: "postSent",
            job_group: job_group.clone(),
            row_id: Some(row_id.to_string()),
            status: "busy",
            label: if label.is_empty() {
                None
            } else {
                Some(label.to_string())
            },
            detail: Some(url.clone()),
            elapsed_ms: None,
            verbose: Some(VerbosePayload {
                method: Some("POST".to_string()),
                url: Some(url.clone()),
                headers: Some(log_headers(&auth, &provider.api_key)),
                body: Some(match &body {
                    CompletionBody::Json(v) => redact_body(v),
                    CompletionBody::Multipart { image, parts } => {
                        Value::String(multipart_log_body(image, parts))
                    }
                }),
                status: None,
                job_id: None,
                description: None,
                error: None,
            }),
        },
    );

    let client = http_client(Duration::from_secs(TIMEOUT_SECS))?;

    let mut req = client.post(&url);
    match &body {
        CompletionBody::Json(v) => req = req.json(v),
        CompletionBody::Multipart { image, parts } => {
            let mut form = reqwest::multipart::Form::new();
            for part in parts {
                form = match part {
                    MultipartPart::Text { key, value } => form.text(key.clone(), value.clone()),
                    MultipartPart::File { key } => form.part(
                        key.clone(),
                        reqwest::multipart::Part::bytes(image.bytes.clone())
                            .file_name(format!("image.{}", mime_ext(&image.mime)))
                            .mime_str(&image.mime)
                            .map_err(|e| format!("invalid image mime type {}: {e}", image.mime))?,
                    ),
                };
            }
            req = req.multipart(form);
        }
    }
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
                PipelineStageEvent {
                    stage: "failed",
                    job_group: job_group.clone(),
                    row_id: Some(row_id.to_string()),
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
            PipelineStageEvent {
                stage: "failed",
                job_group: job_group.clone(),
                row_id: Some(row_id.to_string()),
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
            PipelineStageEvent {
                stage: "done",
                job_group: job_group.clone(),
                row_id: Some(row_id.to_string()),
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
                PipelineStageEvent {
                    stage: "done",
                    job_group: job_group.clone(),
                    row_id: Some(row_id.to_string()),
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

    // Surface which model actually answered — routed endpoints may resolve
    // the requested model to something else, and the response `model` field
    // reveals it.
    let selected_model = v["model"].as_str().map(str::to_string);
    let detail = match &selected_model {
        Some(m) => format!("HTTP {} ({}ms) via {}", status.as_u16(), elapsed, m),
        None => format!("HTTP {} ({}ms)", status.as_u16(), elapsed),
    };

    log_stage(
        app,
        PipelineStageEvent {
            stage: "done",
            job_group: job_group.clone(),
            row_id: Some(row_id.to_string()),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::types::{ApiFormat, Provider};
    use serde_json::{json, Value};

    #[test]
    fn parse_completion_anthropic_single_text_block() {
        let v = json!({
            "content": [{ "type": "text", "text": "<extraction field=\"Material\">bronze</extraction>" }]
        });
        assert_eq!(
            parse_completion_content(ApiFormat::Anthropic, &v).unwrap(),
            "<extraction field=\"Material\">bronze</extraction>"
        );
    }

    #[test]
    fn parse_completion_anthropic_skips_leading_thinking_block() {
        // Reasoning models answer their Anthropic endpoint with a
        // "thinking" block before the text, which broke content[0].text.
        let v = json!({
            "content": [
                { "type": "thinking", "thinking": "The user wants…", "signature": "abc" },
                { "type": "text", "text": "final answer" }
            ]
        });
        assert_eq!(
            parse_completion_content(ApiFormat::Anthropic, &v).unwrap(),
            "final answer"
        );
    }

    #[test]
    fn parse_completion_anthropic_concatenates_text_blocks_in_order() {
        let v = json!({
            "content": [
                { "type": "text", "text": "part one " },
                { "type": "thinking", "thinking": "side quest" },
                { "type": "text", "text": "part two" }
            ]
        });
        assert_eq!(
            parse_completion_content(ApiFormat::Anthropic, &v).unwrap(),
            "part one part two"
        );
    }

    #[test]
    fn parse_completion_anthropic_error_names_observed_block_types() {
        let v = json!({
            "content": [
                { "type": "tool_use", "id": "t1", "name": "f", "input": {} }
            ]
        });
        let err = parse_completion_content(ApiFormat::Anthropic, &v).unwrap_err();
        assert!(
            err.contains("tool_use"),
            "error should name block types, got: {err}"
        );
    }

    #[test]
    fn parse_completion_openai_accepts_plain_string_content() {
        let v = json!({
            "choices": [{ "message": { "content": "plain string answer" } }]
        });
        assert_eq!(
            parse_completion_content(ApiFormat::OpenAi, &v).unwrap(),
            "plain string answer"
        );
    }

    #[test]
    fn parse_completion_openai_joins_parts_array_in_order() {
        // Parts-array content shape; non-text parts must be skipped.
        let v = json!({
            "choices": [{ "message": { "content": [
                { "type": "text", "text": "part one " },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAAA" } },
                { "type": "text", "text": "part two" }
            ] } }]
        });
        assert_eq!(
            parse_completion_content(ApiFormat::OpenAi, &v).unwrap(),
            "part one part two"
        );
    }

    #[test]
    fn parse_completion_openai_ignores_reasoning_fields() {
        // Reasoning models carry chain-of-thought beside
        // `message.content`; only `content` is the answer.
        let v = json!({
            "choices": [{ "message": {
                "reasoning_content": "step by step…",
                "content": "the actual answer"
            } }]
        });
        assert_eq!(
            parse_completion_content(ApiFormat::OpenAi, &v).unwrap(),
            "the actual answer"
        );
    }

    /// Build a throwaway provider for body-shape tests (no transport happens).
    fn provider_with(format: ApiFormat) -> Provider {
        Provider {
            name: "test".to_string(),
            base_url: "https://example.test".to_string(),
            api_key: "k".to_string(),
            model: "m".to_string(),
            api_format: format,
            thinking: None,
            auth_header: String::new(),
            body_template: String::new(),
            body_kind: CustomBodyKind::default(),
            form_fields: Vec::new(),
        }
    }

    fn custom_provider_with(template: &str) -> Provider {
        let mut p = provider_with(ApiFormat::Custom);
        p.body_template = template.to_string();
        p
    }

    fn multipart_provider_with(fields: Value) -> Provider {
        let mut p = provider_with(ApiFormat::Custom);
        p.body_kind = CustomBodyKind::Multipart;
        p.form_fields = serde_json::from_value(fields).unwrap();
        p
    }

    /// Unwrap the JSON variant of a built body (native formats + custom-JSON).
    fn json_body(body: CompletionBody) -> Value {
        match body {
            CompletionBody::Json(v) => v,
            CompletionBody::Multipart { .. } => panic!("expected a JSON body"),
        }
    }

    fn image_turn() -> Turn {
        Turn {
            role: TurnRole::User,
            text: "describe".to_string(),
            image: Some(ImageData {
                bytes: vec![1, 2, 3],
                mime: "image/jpeg".to_string(),
            }),
        }
    }

    fn provider_with_thinking(format: ApiFormat, thinking: ThinkingEffort) -> Provider {
        let mut p = provider_with(format);
        p.thinking = Some(thinking);
        p
    }

    #[test]
    fn openai_body_threads_turns_and_attaches_image_once() {
        let img = ImageData {
            bytes: vec![1, 2, 3],
            mime: "image/png".to_string(),
        };
        let turns = vec![
            Turn {
                role: TurnRole::User,
                text: "describe this".to_string(),
                image: Some(img),
            },
            Turn {
                role: TurnRole::Assistant,
                text: "a description".to_string(),
                image: None,
            },
            Turn {
                role: TurnRole::User,
                text: "catalogue it".to_string(),
                image: None,
            },
        ];
        let body =
            json_body(build_completion_body(&provider_with(ApiFormat::OpenAi), &turns).unwrap());
        let messages = body.get("messages").and_then(Value::as_array).unwrap();
        assert_eq!(messages.len(), 3);
        // Turn 1: user with a parts array (text + image_url).
        assert_eq!(messages[0]["role"], "user");
        assert!(messages[0]["content"].is_array());
        assert!(messages[0]["content"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p.get("type") == Some(&serde_json::Value::String("image_url".into()))));
        // Turn 2: assistant, plain string content.
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"], "a description");
        // Turn 3: user, plain string content (no image).
        assert_eq!(messages[2]["role"], "user");
        assert_eq!(messages[2]["content"], "catalogue it");
    }

    #[test]
    fn gemini_body_threads_input_array_with_image_step() {
        let img = ImageData {
            bytes: vec![9],
            mime: "image/jpeg".to_string(),
        };
        let turns = vec![
            Turn {
                role: TurnRole::User,
                text: "describe".to_string(),
                image: Some(img),
            },
            Turn {
                role: TurnRole::Assistant,
                text: "desc".to_string(),
                image: None,
            },
        ];
        let body =
            json_body(build_completion_body(&provider_with(ApiFormat::Gemini), &turns).unwrap());
        let input = body.get("input").and_then(Value::as_array).unwrap();
        // text, image, text — image is its own step.
        assert_eq!(input.len(), 3);
        assert_eq!(input[0]["type"], "text");
        assert_eq!(input[1]["type"], "image");
        assert_eq!(input[2]["type"], "text");
    }

    #[test]
    fn openai_body_adds_reasoning_effort_only_when_thinking() {
        let off = json_body(build_completion_body(&provider_with(ApiFormat::OpenAi), &[]).unwrap());
        assert!(off.get("reasoning_effort").is_none());

        let on = json_body(
            build_completion_body(
                &provider_with_thinking(ApiFormat::OpenAi, ThinkingEffort::High),
                &[],
            )
            .unwrap(),
        );
        assert_eq!(on["reasoning_effort"], "high");
    }

    #[test]
    fn anthropic_body_adds_thinking_budget_below_max_tokens_only_when_thinking() {
        let off =
            json_body(build_completion_body(&provider_with(ApiFormat::Anthropic), &[]).unwrap());
        assert_eq!(off["max_tokens"], 4096);
        assert!(off.get("thinking").is_none());

        let on = json_body(
            build_completion_body(
                &provider_with_thinking(ApiFormat::Anthropic, ThinkingEffort::Medium),
                &[],
            )
            .unwrap(),
        );
        assert_eq!(on["thinking"]["type"], "enabled");
        let max_tokens = on["max_tokens"].as_u64().unwrap();
        assert_eq!(max_tokens, 32000);
        let budget = on["thinking"]["budget_tokens"].as_u64().unwrap();
        assert!(budget < max_tokens, "budget must stay below max_tokens");
    }

    #[test]
    fn gemini_body_adds_thinking_level_only_when_thinking() {
        let off = json_body(build_completion_body(&provider_with(ApiFormat::Gemini), &[]).unwrap());
        assert!(off["generation_config"].get("thinking_level").is_none());

        let on = json_body(
            build_completion_body(
                &provider_with_thinking(ApiFormat::Gemini, ThinkingEffort::Low),
                &[],
            )
            .unwrap(),
        );
        assert_eq!(on["generation_config"]["thinking_level"], "low");
    }

    #[test]
    fn provider_json_without_thinking_deserializes_with_none() {
        // Providers persisted before the field existed (and test_connection
        // payloads) carry no `thinking` key.
        let p: Provider = serde_json::from_value(json!({
            "name": "p", "baseUrl": "https://example.test", "apiKey": "k",
            "model": "m", "apiFormat": "anthropic"
        }))
        .unwrap();
        assert_eq!(p.thinking, None);

        let p: Provider = serde_json::from_value(json!({
            "name": "p", "baseUrl": "https://example.test", "apiKey": "k",
            "model": "m", "apiFormat": "anthropic", "thinking": "high"
        }))
        .unwrap();
        assert_eq!(p.thinking, Some(ThinkingEffort::High));
    }

    #[test]
    fn parse_completion_gemini_skips_thought_steps() {
        // With thinking enabled the Interactions API can interleave
        // `type: "thought"` steps carrying reasoning summaries; the answer
        // lives in the model_output step.
        let v = json!({
            "steps": [
                { "type": "thought", "content": [{ "type": "text", "text": "let me reason…" }] },
                { "type": "model_output", "content": [{ "type": "text", "text": "the answer" }] },
                { "type": "thought", "content": [{ "type": "text", "text": "double-checking…" }] }
            ]
        });
        assert_eq!(
            parse_completion_content(ApiFormat::Gemini, &v).unwrap(),
            "the answer"
        );
    }

    #[test]
    fn parse_completion_surfaces_truncation_instead_of_partial_text() {
        // A max_tokens stop must name the real cause, not surface as partial
        // content whose "missing" XML blocks mislead downstream parsing.
        let anthropic = json!({
            "stop_reason": "max_tokens",
            "content": [{ "type": "text", "text": "<image_description> partial…" }]
        });
        let err = parse_completion_content(ApiFormat::Anthropic, &anthropic).unwrap_err();
        assert!(err.contains("max_tokens"), "{err}");

        let openai = json!({
            "choices": [{ "finish_reason": "length", "message": { "content": "partial" } }]
        });
        let err = parse_completion_content(ApiFormat::OpenAi, &openai).unwrap_err();
        assert!(err.contains("max_tokens"), "{err}");

        // A normal stop is unaffected by the truncation check.
        let complete = json!({
            "stop_reason": "end_turn",
            "content": [{ "type": "text", "text": "the answer" }]
        });
        assert_eq!(
            parse_completion_content(ApiFormat::Anthropic, &complete).unwrap(),
            "the answer"
        );
    }

    #[test]
    fn custom_endpoints_post_to_the_base_verbatim() {
        let (completions, models) = ApiFormat::Custom.endpoints("https://api.test/platform/svc");
        assert_eq!(completions, "https://api.test/platform/svc");
        assert_eq!(models, "");
    }

    #[test]
    fn custom_auth_defaults_to_bearer_and_switches_on_a_typed_header() {
        assert_eq!(
            ApiFormat::Custom.auth("k", ""),
            vec![("Authorization".to_string(), "Bearer k".to_string())]
        );
        assert_eq!(
            ApiFormat::Custom.auth("k", "x-api-key"),
            vec![("x-api-key".to_string(), "k".to_string())]
        );
        // Whitespace around the typed header name doesn't change the wire.
        assert_eq!(
            ApiFormat::Custom.auth("k", " x-api-key "),
            vec![("x-api-key".to_string(), "k".to_string())]
        );
    }

    #[test]
    fn custom_body_substitutes_turns_into_the_message_template() {
        let turns = vec![
            Turn {
                role: TurnRole::User,
                text: "analyse this".to_string(),
                image: None,
            },
            Turn {
                role: TurnRole::Assistant,
                text: "a description".to_string(),
                image: None,
            },
            Turn {
                role: TurnRole::User,
                text: "catalogue it".to_string(),
                image: None,
            },
        ];
        // The reference template: flattened turns land in `input`.
        let body = json_body(
            build_completion_body(&custom_provider_with(r#"{"input": "{{input}}"}"#), &turns)
                .unwrap(),
        );
        assert_eq!(
            body,
            json!({ "input": "analyse this\n\na description\n\ncatalogue it" })
        );

        // A dialect template keeps its other fields and substitutes in place.
        let body = json_body(
            build_completion_body(
                &custom_provider_with(
                    r#"{"messages": [{ "role": "user", "content": "{{input}}" }], "temperature": 0.2}"#,
                ),
                &turns,
            )
            .unwrap(),
        );
        assert_eq!(
            body["messages"][0]["content"],
            "analyse this\n\na description\n\ncatalogue it"
        );
        assert_eq!(body["temperature"], 0.2);
    }

    #[test]
    fn custom_body_substitutes_every_token_occurrence_including_nested() {
        let body = json_body(
            build_completion_body(
                &custom_provider_with(r#"{"a": {"b": "x {{input}} y"}, "arr": ["{{input}}", 1]}"#),
                &[Turn {
                    role: TurnRole::User,
                    text: "prompt".to_string(),
                    image: None,
                }],
            )
            .unwrap(),
        );
        assert_eq!(body["a"]["b"], "x prompt y");
        assert_eq!(body["arr"][0], "prompt");
        assert_eq!(body["arr"][1], 1);
    }

    #[test]
    fn custom_body_errors_name_the_exact_template_defect() {
        let empty = build_completion_body(&custom_provider_with("  "), &[]).unwrap_err();
        assert!(empty.contains("no message format"), "{empty}");

        let invalid = build_completion_body(&custom_provider_with("{not json"), &[]).unwrap_err();
        assert!(invalid.contains("valid JSON"), "{invalid}");

        let no_token =
            build_completion_body(&custom_provider_with(r#"{"q": "hello"}"#), &[]).unwrap_err();
        assert!(no_token.contains("{{input}}"), "{no_token}");
    }

    #[test]
    fn custom_json_body_rejects_an_image_turn_without_the_image_token() {
        // The image must never silently drop: a JSON template without
        // `{{image}}` fails the build when the call carries one.
        let err = build_completion_body(
            &custom_provider_with(r#"{"input": "{{input}}"}"#),
            &[image_turn()],
        )
        .unwrap_err();
        assert!(err.contains("{{image}}"), "{err}");
    }

    #[test]
    fn custom_json_body_substitutes_image_and_mime_tokens() {
        let body = json_body(
            build_completion_body(
                &custom_provider_with(
                    r#"{"q": "{{input}}", "img": "data:{{mime}};base64,{{image}}"}"#,
                ),
                &[image_turn()],
            )
            .unwrap(),
        );
        assert_eq!(body["q"], "describe");
        // base64([1,2,3]) is AQID.
        assert_eq!(body["img"], "data:image/jpeg;base64,AQID");
    }

    #[test]
    fn custom_json_body_errors_when_the_template_references_an_image_without_one() {
        let err = build_completion_body(
            &custom_provider_with(r#"{"q": "{{input}}", "img": "{{image}}"}"#),
            &[Turn {
                role: TurnRole::User,
                text: "describe".to_string(),
                image: None,
            }],
        )
        .unwrap_err();
        assert!(err.contains("carries no image"), "{err}");
    }

    #[test]
    fn custom_multipart_builds_parts_in_authored_order() {
        // Text rows keep their list position; file rows all carry the image.
        let body = build_completion_body(
            &multipart_provider_with(json!([
                { "key": "query", "type": "text", "value": "{{input}}" },
                { "key": "image01", "type": "file" },
                { "key": "language", "type": "text", "value": "en" }
            ])),
            &[image_turn()],
        )
        .unwrap();
        let CompletionBody::Multipart { image, parts } = body else {
            panic!("expected a multipart body");
        };
        assert_eq!(image.bytes, vec![1, 2, 3]);
        assert_eq!(parts.len(), 3);
        assert!(matches!(
            &parts[0],
            MultipartPart::Text { key, value } if key == "query" && value == "describe"
        ));
        assert!(matches!(&parts[1], MultipartPart::File { key } if key == "image01"));
        assert!(matches!(
            &parts[2],
            MultipartPart::Text { key, value } if key == "language" && value == "en"
        ));
        // The boundary log names fields and sizes only, never values/bytes.
        let log = multipart_log_body(&image, &parts);
        assert!(log.contains("image01=<file image/jpeg 3B>"), "{log}");
        assert!(log.contains("query=<text 8 chars>"), "{log}");
    }

    #[test]
    fn custom_multipart_substitutes_tokens_in_text_rows() {
        let body = build_completion_body(
            &multipart_provider_with(json!([
                { "key": "image01", "type": "file" },
                { "key": "q", "type": "text", "value": "{{input}} {{mime}} {{image}}" }
            ])),
            &[image_turn()],
        )
        .unwrap();
        let CompletionBody::Multipart { parts, .. } = body else {
            panic!("expected a multipart body");
        };
        let MultipartPart::Text { value, .. } = &parts[1] else {
            panic!("expected a text part");
        };
        assert_eq!(value, "describe image/jpeg AQID");
    }

    #[test]
    fn custom_multipart_errors_name_the_exact_defect() {
        let image_turns = &[image_turn()];

        let no_fields =
            build_completion_body(&multipart_provider_with(json!([])), image_turns).unwrap_err();
        assert!(no_fields.contains("no form fields"), "{no_fields}");

        let no_input = build_completion_body(
            &multipart_provider_with(json!([
                { "key": "image01", "type": "file" },
                { "key": "lang", "type": "text", "value": "en" }
            ])),
            image_turns,
        )
        .unwrap_err();
        assert!(no_input.contains("{{input}}"), "{no_input}");

        let no_file = build_completion_body(
            &multipart_provider_with(json!([{ "key": "q", "type": "text", "value": "{{input}}" }])),
            image_turns,
        )
        .unwrap_err();
        assert!(no_file.contains("file field"), "{no_file}");

        let empty_key = build_completion_body(
            &multipart_provider_with(json!([
                { "key": "  ", "type": "text", "value": "{{input}}" },
                { "key": "image01", "type": "file" }
            ])),
            image_turns,
        )
        .unwrap_err();
        assert!(empty_key.contains("no name"), "{empty_key}");

        // Multipart mode is the image transport: an imageless call fails.
        let imageless = build_completion_body(
            &multipart_provider_with(json!([
                { "key": "q", "type": "text", "value": "{{input}}" },
                { "key": "image01", "type": "file" }
            ])),
            &[Turn {
                role: TurnRole::User,
                text: "describe".to_string(),
                image: None,
            }],
        )
        .unwrap_err();
        assert!(imageless.contains("carries none"), "{imageless}");
    }

    #[test]
    fn provider_body_kind_and_form_fields_deserialize_with_defaults() {
        // Providers persisted before the fields existed stay JSON-mode.
        let p: Provider = serde_json::from_value(json!({
            "name": "p", "baseUrl": "https://example.test", "apiKey": "k",
            "model": "m", "apiFormat": "custom"
        }))
        .unwrap();
        assert_eq!(p.body_kind, CustomBodyKind::Json);
        assert!(p.form_fields.is_empty());

        let p: Provider = serde_json::from_value(json!({
            "name": "p", "baseUrl": "https://example.test", "apiKey": "k",
            "model": "m", "apiFormat": "custom", "bodyKind": "multipart",
            "formFields": [
                { "key": "image01", "type": "file" },
                { "key": "query", "type": "text", "value": "{{input}}" }
            ]
        }))
        .unwrap();
        assert_eq!(p.body_kind, CustomBodyKind::Multipart);
        assert_eq!(p.form_fields.len(), 2);
        // An omitted "type" defaults to text.
        assert_eq!(p.form_fields[1].field_type, FormFieldType::Text);
    }

    #[test]
    fn mime_ext_maps_the_image_mimes() {
        assert_eq!(mime_ext("image/jpeg"), "jpg");
        assert_eq!(mime_ext("image/png"), "png");
        assert_eq!(mime_ext("image/tiff"), "bin");
    }

    #[test]
    fn custom_parse_reads_the_output_field() {
        let v = json!({ "output": "<extraction field=\"Material\">bronze</extraction>" });
        assert_eq!(
            parse_completion_content(ApiFormat::Custom, &v).unwrap(),
            "<extraction field=\"Material\">bronze</extraction>"
        );
    }

    #[test]
    fn custom_parse_error_names_observed_top_level_keys() {
        // The response shape is not live-validated; the error must show what
        // actually came back so the real contract is visible in the row error.
        let v = json!({ "result": 1, "text": "x" });
        let err = parse_completion_content(ApiFormat::Custom, &v).unwrap_err();
        assert!(err.contains("result, text"), "{err}");
    }

    #[test]
    fn custom_parse_auto_detects_the_template_s_response_dialect() {
        // A gateway addressed through the OpenAI baseline answers openai-shaped.
        let openai = json!({
            "choices": [{ "message": { "content": "openai answer" } }]
        });
        assert_eq!(
            parse_completion_content(ApiFormat::Custom, &openai).unwrap(),
            "openai answer"
        );
        // Anthropic baseline: typed content blocks.
        let anthropic = json!({
            "content": [{ "type": "text", "text": "anthropic answer" }]
        });
        assert_eq!(
            parse_completion_content(ApiFormat::Custom, &anthropic).unwrap(),
            "anthropic answer"
        );
        // Gemini baseline: steps entries.
        let gemini = json!({
            "steps": [{ "content": [{ "type": "text", "text": "gemini answer" }] }]
        });
        assert_eq!(
            parse_completion_content(ApiFormat::Custom, &gemini).unwrap(),
            "gemini answer"
        );
    }

    #[test]
    fn custom_parse_surfaces_truncation_over_shape_fallthrough() {
        // A max-tokens stop must not fall through the dialect chain into the
        // generic "unrecognized" error.
        let openai = json!({
            "choices": [{ "finish_reason": "length", "message": { "content": "partial" } }]
        });
        let err = parse_completion_content(ApiFormat::Custom, &openai).unwrap_err();
        assert!(err.contains("max_tokens"), "{err}");

        let anthropic = json!({
            "stop_reason": "max_tokens",
            "content": [{ "type": "text", "text": "partial" }]
        });
        let err = parse_completion_content(ApiFormat::Custom, &anthropic).unwrap_err();
        assert!(err.contains("max_tokens"), "{err}");
    }
}
