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
use tauri::AppHandle;

use super::logging::{
    log_headers, log_stage, next_call_group, redact_body, PipelineStageEvent, VerbosePayload,
};
use super::transport::{http_client, trim_trailing_slash, TIMEOUT_SECS};
use super::types::{ApiFormat, Provider};

/// Inlined image attached to a single multimodal prompt: raw bytes + mime type.
/// When `Some`, `do_completion` embeds the image as a content block alongside
/// the text instruction (OpenAI `image_url` / Anthropic `image`). `Clone`
/// because a `Turn` may carry an image and the cataloguing pipeline clones
/// turns into the threaded conversation.
#[derive(Clone)]
pub(crate) struct ImageData {
    pub(crate) bytes: Vec<u8>,
    pub(crate) mime: String,
}

/// One turn of a multi-turn conversation sent to a chat-completions provider.
/// The cataloguing pipeline threads validation (vocab validation) onto vision
/// analysis (vision + extraction) so the model keeps the image and its own
/// analysis in context while picking vocab candidates. An image attaches only
/// to the turn that carries it (vision analysis's user turn); validation's
/// user turn is text-only but still sees the earlier image via the replayed
/// vision-analysis history.
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

/// Build the chat-completions request body for one conversation (possibly
/// multi-turn). Pure: no transport, no logging. The body differs by API family;
/// each provider encodes the turns as its native multi-turn shape (OpenAI /
/// Anthropic `messages` array; Gemini Interactions `input` array of steps).
/// An image attached to a turn is inlined as a content block on that turn only
/// — later text-only turns still see it via the conversation history.
fn build_completion_body(provider: &Provider, turns: &[Turn]) -> Value {
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
            json!({
                "model": provider.model,
                "messages": messages,
                "temperature": 0.2
            })
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
            json!({
                "model": provider.model,
                "max_tokens": 4096,
                "messages": messages
            })
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
            json!({
                "model": provider.model,
                "input": input,
                "generation_config": { "temperature": 0.2 }
            })
        }
    }
}

/// Pull the model's text answer out of a chat-completions response, by API
/// family. Pure: takes the parsed JSON, returns the content string or an error.
///
/// Reasoning output can share the response with the answer — as leading
/// `thinking` blocks (Anthropic) or sibling fields beside the content
/// (OpenAI) — so each arm gathers only the answer text, in order.
fn parse_completion_content(fmt: ApiFormat, v: &Value) -> Result<String, String> {
    let content = match fmt {
        // Content is a plain string or a parts array
        // [{type:"text",text:"..."}].
        ApiFormat::OpenAi => {
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
                .ok_or_else(|| "response missing choices[0].message.content".to_string())?
        }
        // `content` holds typed blocks; reasoning models put a "thinking"
        // block ahead of the answer's "text" block(s).
        ApiFormat::Anthropic => {
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
                .ok_or_else(|| format!("response content has no text ({got})"))?
        }
        // Gemini Interactions API: prefer the top-level convenience field, then
        // the current `steps` array, then the legacy `outputs` array (pre the
        // 2026-06 schema sunset). The final entry holds the complete answer.
        ApiFormat::Gemini => v
            .get("output_text")
            .and_then(Value::as_str)
            .or_else(|| gemini_entries_text(v.get("steps")))
            .or_else(|| gemini_entries_text(v.get("outputs")))
            .ok_or_else(|| "response missing output_text / steps / outputs".to_string())?
            .to_string(),
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

pub(crate) async fn do_completion(
    app: &AppHandle,
    provider: &Provider,
    label: &str,
    turns: &[Turn],
) -> Result<(String, String), String> {
    let base = trim_trailing_slash(&provider.base_url);
    let (url, _models_url) = provider.api_format.endpoints(&base);

    // Body construction is isolated in `build_completion_body`; this function
    // owns only transport + boundary logging.
    let body: Value = build_completion_body(provider, turns);
    let auth = provider.api_format.auth(&provider.api_key);

    // One group id per call so the renderer resolves the in-flight "busy" dot
    // (request sent) when the terminal stage lands. The label identifies which
    // pipeline step this call belongs to ("Vision Analysis" / "Cataloguing").
    let job_group = next_call_group();
    log_stage(
        app,
        PipelineStageEvent {
            stage: "postSent",
            job_group: job_group.clone(),
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
                PipelineStageEvent {
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
            PipelineStageEvent {
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
            PipelineStageEvent {
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
                PipelineStageEvent {
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
        }
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
        let body = build_completion_body(&provider_with(ApiFormat::OpenAi), &turns);
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
        let body = build_completion_body(&provider_with(ApiFormat::Gemini), &turns);
        let input = body.get("input").and_then(Value::as_array).unwrap();
        // text, image, text — image is its own step.
        assert_eq!(input.len(), 3);
        assert_eq!(input[0]["type"], "text");
        assert_eq!(input[1]["type"], "image");
        assert_eq!(input[2]["type"], "text");
    }
}
