//! HTTP transport primitives shared across the AI pipeline and `embeddings`:
//! the browser-envelope reqwest client, its UA constant, the request timeout,
//! base-URL / model-id munging helpers, the status/body error check, and the
//! advertised-models listing used by both connection tests.

use serde_json::Value;
use std::time::Duration;

/// Shared chat-completions request timeout (also the effective cap on how long
/// a catalogue row can stay in-flight before failing).
pub(crate) const TIMEOUT_SECS: u64 = 120;

pub(crate) fn trim_trailing_slash(s: &str) -> String {
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
pub(crate) const APP_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

/// Build the shared `reqwest::Client` with a browser-friendly request envelope:
/// a real `User-Agent` and a default `Accept: application/json`. All call sites
/// (do_completion, test_connection, embeddings) go through here so the envelope
/// never drifts.
pub(crate) fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
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

/// Drop a leading `models/` from a Gemini model name so the value matches the
/// bare id the Interactions request body expects (e.g. `models/gemini-3.5-flash`
/// → `gemini-3.5-flash`).
pub(crate) fn strip_models_prefix(name: &str) -> String {
    name.strip_prefix("models/").unwrap_or(name).to_string()
}

/// API root for an embeddings-style base URL: strips a trailing `/embeddings`
/// or `/embed` (after slash-trim). `None` when the base carries no such suffix,
/// so callers can skip a redundant fallback fetch to the same root.
pub(crate) fn embeddings_root(base: &str) -> Option<String> {
    let trimmed = trim_trailing_slash(base);
    let root = trimmed
        .strip_suffix("/embeddings")
        .or_else(|| trimmed.strip_suffix("/embed"))
        .map(str::to_string)?;
    if root.is_empty() {
        None
    } else {
        Some(root)
    }
}

/// Read a response body as text, mapping a non-success status to the shared
/// `HTTP <code>: <body>` error. `read_label` prefixes the body-read failure
/// wording so each call site keeps its existing message (e.g. "embed response
/// read failed"); an empty label yields the bare error string. The `HTTP
/// <code>:` wording is load-bearing — `embeddings::is_transient_embed_error`
/// substring-matches it to decide retries.
pub(crate) async fn response_text_checked(
    resp: reqwest::Response,
    read_label: &str,
) -> Result<String, String> {
    let status = resp.status();
    let text = resp.text().await.map_err(|e| {
        if read_label.is_empty() {
            e.to_string()
        } else {
            format!("{read_label}: {e}")
        }
    })?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), text));
    }
    Ok(text)
}

/// GET a provider's `/models` endpoint and return the advertised model ids,
/// sorted. Consumed by `ai::test_connection` (all models) and
/// `embeddings::check_connection` (`embedding_only`); the parse/filter lives in
/// the pure [`parse_advertised_models`] so it stays unit-testable.
pub(crate) async fn fetch_advertised_models(
    client: &reqwest::Client,
    models_url: &str,
    auth: &[(&'static str, String)],
    gemini: bool,
    embedding_only: bool,
) -> Result<Vec<String>, String> {
    let mut req = client.get(models_url);
    for (name, value) in auth {
        req = req.header(*name, value.as_str());
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let text = response_text_checked(resp, "response body read failed").await?;
    Ok(parse_advertised_models(&text, gemini, embedding_only))
}

/// Pure parse + optional embedding filter over an advertised-models payload.
/// Gemini answers `{"models":[{"name":"models/<id>"}]}` (prefix stripped so
/// values match the id the request body expects); OpenAI-shaped APIs (OpenAI,
/// Anthropic, OpenRouter) answer `{"data":[{"id":"..."}]}`. A JSON parse
/// failure yields an empty list — listing is best-effort across gateways.
///
/// With `embedding_only`, an OpenAI-shaped entry is kept when its
/// `architecture.output_modalities` contains `"embeddings"` (gateway metadata
/// — catches ids like `gte-base`/`e5-*` that don't say so) or its id contains
/// "embed"; Gemini ids are matched by name alone. If the filter would empty a
/// non-empty list (e.g. Voyage, whose whole catalog is embeddings but whose
/// ids say nothing), the unfiltered list is returned so the picker never goes
/// blank.
pub(crate) fn parse_advertised_models(
    text: &str,
    gemini: bool,
    embedding_only: bool,
) -> Vec<String> {
    let v = serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
    let raw: Vec<(String, &Value)> = if gemini {
        v.get("models")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        m.get("name")
                            .and_then(Value::as_str)
                            .map(|n| (strip_models_prefix(n), m))
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        v.get("data")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        m.get("id")
                            .and_then(Value::as_str)
                            .map(|id| (id.to_string(), m))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut models: Vec<String> = if !embedding_only {
        raw.into_iter().map(|(id, _)| id).collect()
    } else {
        let kept: Vec<String> = raw
            .iter()
            .filter(|(id, m)| is_embedding_model(id, m, gemini))
            .map(|(id, _)| id.clone())
            .collect();
        if kept.is_empty() && !raw.is_empty() {
            raw.into_iter().map(|(id, _)| id).collect()
        } else {
            kept
        }
    };
    models.sort();
    models
}

/// Embedding-capability signal for one advertised-models entry: an id that
/// names itself an embedding model, or (OpenAI-shaped gateways only) advertised
/// embeddings output modality.
fn is_embedding_model(id: &str, entry: &Value, gemini: bool) -> bool {
    if id.to_lowercase().contains("embed") {
        return true;
    }
    if gemini {
        return false;
    }
    entry
        .get("architecture")
        .and_then(|a| a.get("output_modalities"))
        .and_then(Value::as_array)
        .is_some_and(|mods| {
            mods.iter()
                .filter_map(Value::as_str)
                .any(|s| s.eq_ignore_ascii_case("embeddings"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedding_filter_keeps_metadata_and_name_matches_drops_chat_models() {
        // OpenRouter-shaped catalog: one embedding model by metadata whose id
        // says nothing (`gte-base`), one by id (`text-embedding-*`), one chat
        // model.
        let text = r#"{"data":[
            {"id":"thenlper/gte-base","architecture":{"output_modalities":["embeddings"]}},
            {"id":"openai/text-embedding-3-small","architecture":{"output_modalities":["text"]}},
            {"id":"openai/gpt-4o","architecture":{"output_modalities":["text"]}}
        ]}"#;
        assert_eq!(
            parse_advertised_models(text, false, true),
            vec!["openai/text-embedding-3-small", "thenlper/gte-base"]
        );
    }

    #[test]
    fn embedding_filter_falls_back_to_raw_list_when_nothing_matches() {
        // Voyage-style catalog: every id is an embedding model but none carries
        // either signal — an empty picker would be worse than the full list.
        let text = r#"{"data":[{"id":"voyage-3"},{"id":"voyage-code-3"}]}"#;
        assert_eq!(
            parse_advertised_models(text, false, true),
            vec!["voyage-3", "voyage-code-3"]
        );
    }

    #[test]
    fn embedding_filter_off_returns_every_model() {
        let text = r#"{"data":[{"id":"b"},{"id":"a"}]}"#;
        assert_eq!(parse_advertised_models(text, false, false), vec!["a", "b"]);
    }

    #[test]
    fn gemini_arm_filters_embedding_models_by_name() {
        let text = r#"{"models":[
            {"name":"models/gemini-embedding-001"},
            {"name":"models/gemini-2.5-flash"},
            {"name":"models/text-embedding-004"}
        ]}"#;
        assert_eq!(
            parse_advertised_models(text, true, true),
            vec!["gemini-embedding-001", "text-embedding-004"]
        );
    }

    #[test]
    fn unparseable_payload_yields_empty_list() {
        assert!(parse_advertised_models("<html>502</html>", false, true).is_empty());
    }

    #[test]
    fn embeddings_root_strips_embeddings_and_embed_suffixes() {
        assert_eq!(
            embeddings_root("https://openrouter.ai/api/v1/embeddings").as_deref(),
            Some("https://openrouter.ai/api/v1")
        );
        assert_eq!(
            embeddings_root("https://tei.example/v1/embed/").as_deref(),
            Some("https://tei.example/v1")
        );
    }

    #[test]
    fn embeddings_root_is_none_without_a_known_suffix() {
        // A root already: the fallback would re-fetch the same URL, so none.
        assert_eq!(embeddings_root("https://openrouter.ai/api/v1"), None);
        assert_eq!(embeddings_root("https://x/embedding"), None);
        assert_eq!(embeddings_root("/embeddings"), None);
    }
}
