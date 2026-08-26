//! Embedding-provider protocol: request/response handling for the supported
//! API families, the batched text/image embed HTTP calls, and the retry
//! wrapper used by the multimodal vocab pipeline.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

use crate::ai::{http_client, strip_models_prefix, trim_trailing_slash, ImageData};

/// Max rows sent per `/embeddings` / `batchEmbedContents` request; the sync
/// pipeline chunks rows into requests of this size.
pub(crate) const EMBED_BATCH_SIZE: usize = 64;

/// Which API family an embedding provider speaks. Anthropic has no
/// embeddings API, so this is a subset of `ai::ApiFormat`.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum EmbeddingApiFormat {
    #[serde(rename = "openai")]
    #[default]
    OpenAi,
    #[serde(rename = "gemini")]
    Gemini,
}

/// One embedding provider, mirroring the frontend `EmbeddingProvider` type.
#[derive(Deserialize, Clone)]
pub struct EmbeddingProvider {
    #[allow(dead_code)]
    pub name: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    pub model: String,
    #[serde(rename = "apiFormat", default)]
    pub api_format: EmbeddingApiFormat,
    /// User-declared capability hint: whether this provider's embedding model
    /// accepts image input. A hint, not a guarantee — a rejected image call
    /// still surfaces as a normal `Err` so the caller can fall back to
    /// text-only for that row. Deserialized from settings and documented as the
    /// precondition on [`embed_image`]; the caller-side gating check that
    /// consumes it hasn't landed yet, hence `allow(dead_code)`.
    #[serde(rename = "supportsImageInput", default)]
    #[allow(dead_code)]
    pub supports_image_input: bool,
}

#[derive(Serialize)]
pub struct EmbeddingConnectionTest {
    pub ok: String,
    pub models: Vec<String>,
    pub dimensions: u32,
}

/// Embed a batch of texts against the given provider's `/embeddings`
/// (OpenAI-shaped) or `batchEmbedContents` (Gemini-shaped) endpoint. Returns
/// one vector per input text, in the same order.
pub(crate) async fn embed_texts(
    provider: &EmbeddingProvider,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let base = trim_trailing_slash(&provider.base_url);
    let client = http_client(Duration::from_secs(60))?;
    match provider.api_format {
        EmbeddingApiFormat::OpenAi => {
            let url = base.clone();
            let body = serde_json::json!({ "model": provider.model, "input": texts });
            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", provider.api_key))
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("embed request failed: {e}"))?;
            let status = resp.status();
            let text = resp
                .text()
                .await
                .map_err(|e| format!("embed response read failed: {e}"))?;
            if !status.is_success() {
                return Err(format!("HTTP {}: {}", status.as_u16(), text));
            }
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| format!("embed response parse failed: {e}"))?;
            let data = v
                .get("data")
                .and_then(Value::as_array)
                .ok_or("embed response missing data")?;
            let mut out = vec![Vec::new(); texts.len()];
            for item in data {
                let idx = item.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let emb = item
                    .get("embedding")
                    .and_then(Value::as_array)
                    .ok_or("embed item missing embedding")?;
                if idx < out.len() {
                    out[idx] = emb
                        .iter()
                        .filter_map(Value::as_f64)
                        .map(|f| f as f32)
                        .collect();
                }
            }
            Ok(out)
        }
        EmbeddingApiFormat::Gemini => {
            let url = format!("{base}/v1beta/models/{}:batchEmbedContents", provider.model);
            let requests: Vec<Value> = texts
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "model": format!("models/{}", provider.model),
                        "content": { "parts": [{ "text": t }] }
                    })
                })
                .collect();
            let body = serde_json::json!({ "requests": requests });
            let resp = client
                .post(&url)
                .header("x-goog-api-key", &provider.api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("embed request failed: {e}"))?;
            let status = resp.status();
            let text = resp
                .text()
                .await
                .map_err(|e| format!("embed response read failed: {e}"))?;
            if !status.is_success() {
                return Err(format!("HTTP {}: {}", status.as_u16(), text));
            }
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| format!("embed response parse failed: {e}"))?;
            let embeddings = v
                .get("embeddings")
                .and_then(Value::as_array)
                .ok_or("embed response missing embeddings")?;
            Ok(embeddings
                .iter()
                .map(|e| {
                    e.get("values")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_f64)
                                .map(|f| f as f32)
                                .collect()
                        })
                        .unwrap_or_default()
                })
                .collect())
        }
    }
}

/// Embed one image (M5). Only meaningful when `provider.supports_image_input`
/// is true (a genuinely multimodal embedding model) — the caller is
/// responsible for that check; this function just makes the call and lets a
/// text-only model's rejection surface as a normal `Err`, so the caller can
/// fall back to text-only retrieval for that row.
///
/// Reuses the same base64 image encoding used for chat completions
/// (`ai::build_completion_body`), but targets the embeddings endpoint. The
/// input shape differs from chat's `messages[].content`: OpenAI-compatible
/// multimodal-embedding endpoints expect each `input` element to be a
/// message-object with a `content` array (the same wrapper chat uses, but
/// nested under `input`, not `messages`); Gemini uses its native
/// `batchEmbedContents` `requests[].content.parts[].inline_data` shape.
pub(crate) async fn embed_image(
    provider: &EmbeddingProvider,
    image: &ImageData,
) -> Result<Vec<f32>, String> {
    let base = trim_trailing_slash(&provider.base_url);
    let client = http_client(Duration::from_secs(60))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&image.bytes);
    match provider.api_format {
        EmbeddingApiFormat::OpenAi => {
            let url = base.clone();
            let data_url = format!("data:{};base64,{}", image.mime, b64);
            // OpenAI-compatible multimodal-embeddings input: each `input`
            // element is a message-object whose `content` array holds the
            // `image_url` part (the same `content: [...]` shape chat user
            // messages use in ai.rs). A bare `{type,image_url}` element is
            // rejected by gateways that validate against the OpenAI union
            // schema — the `content` wrapper is required.
            let body = serde_json::json!({
                "model": provider.model,
                "input": [{ "content": [{ "type": "image_url", "image_url": { "url": data_url } }] }]
            });
            let resp = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", provider.api_key))
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("image embed request failed: {e}"))?;
            let status = resp.status();
            let text = resp
                .text()
                .await
                .map_err(|e| format!("image embed response read failed: {e}"))?;
            if !status.is_success() {
                return Err(format!("HTTP {}: {}", status.as_u16(), text));
            }
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| format!("image embed response parse failed: {e}"))?;
            let emb = v
                .get("data")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|item| item.get("embedding"))
                .and_then(Value::as_array)
                .ok_or("image embed response missing embedding")?;
            Ok(emb
                .iter()
                .filter_map(Value::as_f64)
                .map(|f| f as f32)
                .collect())
        }
        EmbeddingApiFormat::Gemini => {
            let url = format!("{base}/v1beta/models/{}:batchEmbedContents", provider.model);
            let body = serde_json::json!({
                "requests": [{
                    "model": format!("models/{}", provider.model),
                    "content": { "parts": [{ "inline_data": { "mime_type": image.mime, "data": b64 } }] }
                }]
            });
            let resp = client
                .post(&url)
                .header("x-goog-api-key", &provider.api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("image embed request failed: {e}"))?;
            let status = resp.status();
            let text = resp
                .text()
                .await
                .map_err(|e| format!("image embed response read failed: {e}"))?;
            if !status.is_success() {
                return Err(format!("HTTP {}: {}", status.as_u16(), text));
            }
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| format!("image embed response parse failed: {e}"))?;
            let emb = v
                .get("embeddings")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|item| item.get("values"))
                .and_then(Value::as_array)
                .ok_or("image embed response missing values")?;
            Ok(emb
                .iter()
                .filter_map(Value::as_f64)
                .map(|f| f as f32)
                .collect())
        }
    }
}

/// A retriable image-embed attempt: `embed_image` returns a plain `String`
/// error (no retry semantics), so callers that want a single best-effort retry
/// on transient failures use this wrapper instead. The returned error records
/// whether a retry happened, so the user-facing message can surface "failed
/// after retry" rather than masking the retry.
#[derive(thiserror::Error, Debug)]
pub(crate) enum ImageEmbedError {
    /// All attempts failed. `retries` is how many retries were attempted
    /// before giving up (0 = failed on the first try, 1 = retried once then
    /// failed again). `message` is the final failure's error string.
    Failed { message: String, retries: u32 },
}

impl std::fmt::Display for ImageEmbedError {
    /// User-facing message for the pipeline log/row error. Delegates to
    /// [`message`](Self::message) so `Display`, logging, and the explicit
    /// `.message()` call site all agree on the wording.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl ImageEmbedError {
    /// User-facing message for the pipeline log/row error.
    pub fn message(&self) -> String {
        match self {
            ImageEmbedError::Failed {
                message,
                retries: 0,
            } => message.clone(),
            ImageEmbedError::Failed {
                message,
                retries: _,
            } => {
                format!("{message} (after retry)")
            }
        }
    }
}

/// True if an `embed_image` error string looks like a transient/network
/// failure worth one retry: a request or response-read failure, or any HTTP
/// 5xx. Parse errors, 4xx, and "missing embedding" are deterministic and
/// won't succeed on retry, so they are not retried.
///
/// This substring-matches error strings built in `embed_texts`/`embed_image`
/// above (`"... request failed"`, `"... response read failed"`,
/// `"HTTP <code>: ..."`); changing that wording silently disables retries.
fn is_transient_embed_error(err: &str) -> bool {
    err.contains("request failed") || err.contains("response read failed") || err.contains("HTTP 5")
}

/// Embed one image with a single retry on a transient failure. Used by the
/// multimodal vocab pipeline (`ai::resolve_vocab_fields`), where an image
/// embed hard-fails the row rather than silently degrading to text-only
/// retrieval — the one retry absorbs a flaky-network blip before surfacing
/// the failure.
pub(crate) async fn embed_image_with_retry(
    provider: &EmbeddingProvider,
    image: &ImageData,
) -> Result<Vec<f32>, ImageEmbedError> {
    let first = embed_image(provider, image).await;
    match first {
        Ok(v) => Ok(v),
        Err(e) if is_transient_embed_error(&e) => match embed_image(provider, image).await {
            Ok(v) => Ok(v),
            Err(final_err) => Err(ImageEmbedError::Failed {
                message: final_err,
                retries: 1,
            }),
        },
        Err(e) => Err(ImageEmbedError::Failed {
            message: e,
            retries: 0,
        }),
    }
}

/// Ping the embedding provider: list advertised models (best-effort — some
/// gateways don't expose this) and, once a model has been picked, perform one
/// real embed call, which is both the genuine connectivity check and how the
/// vector width is learned. Two-phase so the UI can bootstrap the model
/// dropdown from a first call with no model selected: called with an empty
/// `model`, this only lists models (mirrors `ai::test_connection`); called
/// again once the user has picked one, it also validates that model via a
/// real embed call. Exposed through the `test_embedding_connection` command.
pub(crate) async fn check_connection(
    provider: EmbeddingProvider,
) -> Result<EmbeddingConnectionTest, String> {
    let base = trim_trailing_slash(&provider.base_url);
    let client = http_client(Duration::from_secs(20))?;
    let models_url = match provider.api_format {
        EmbeddingApiFormat::OpenAi => format!("{base}/models"),
        EmbeddingApiFormat::Gemini => format!("{base}/v1beta/models"),
    };
    let mut req = client.get(&models_url);
    req = match provider.api_format {
        EmbeddingApiFormat::OpenAi => {
            req.header("Authorization", format!("Bearer {}", provider.api_key))
        }
        EmbeddingApiFormat::Gemini => req.header("x-goog-api-key", provider.api_key.clone()),
    };
    let mut models = Vec::new();
    let mut list_error: Option<String> = None;
    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            match resp.text().await {
                Ok(text) => {
                    if status.is_success() {
                        if let Ok(v) = serde_json::from_str::<Value>(&text) {
                            models = match provider.api_format {
                                EmbeddingApiFormat::Gemini => v
                                    .get("models")
                                    .and_then(Value::as_array)
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|m| {
                                                m.get("name")
                                                    .and_then(Value::as_str)
                                                    .map(strip_models_prefix)
                                            })
                                            .collect()
                                    })
                                    .unwrap_or_default(),
                                EmbeddingApiFormat::OpenAi => v
                                    .get("data")
                                    .and_then(Value::as_array)
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|m| {
                                                m.get("id")
                                                    .and_then(Value::as_str)
                                                    .map(String::from)
                                            })
                                            .collect()
                                    })
                                    .unwrap_or_default(),
                            };
                            models.sort();
                        }
                    } else {
                        list_error = Some(format!("HTTP {}: {}", status.as_u16(), text));
                    }
                }
                Err(e) => list_error = Some(format!("response body read failed: {e}")),
            }
        }
        Err(e) => list_error = Some(format!("request failed: {e}")),
    }
    if provider.model.trim().is_empty() {
        // No model yet, so this listing call is the only connectivity/auth
        // signal available — unlike the "model selected" path below, a
        // failure here can't be masked by a real embed call, so surface it.
        if let Some(err) = list_error {
            return Err(err);
        }
        return Ok(EmbeddingConnectionTest {
            ok: "Connected — model list loaded".to_string(),
            models,
            dimensions: 0,
        });
    }
    let vectors = embed_texts(&provider, &["connection test".to_string()]).await?;
    let dimensions = vectors.first().map(|v| v.len()).unwrap_or(0);
    if dimensions == 0 {
        return Err("embedding call returned no vector".to_string());
    }
    Ok(EmbeddingConnectionTest {
        ok: "Connection successful".to_string(),
        models,
        dimensions: dimensions as u32,
    })
}
