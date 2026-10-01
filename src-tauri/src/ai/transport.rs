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
/// sorted. Gemini answers `{"models":[{"name":"models/<id>"}]}` (prefix
/// stripped so values match the id the request body expects); OpenAI-shaped
/// APIs (OpenAI, Anthropic) answer `{"data":[{"id":"..."}]}`. A JSON parse
/// failure yields an empty list — listing is best-effort across gateways.
/// Consumed by `ai::test_connection` and `embeddings::check_connection`.
pub(crate) async fn fetch_advertised_models(
    client: &reqwest::Client,
    models_url: &str,
    auth: &[(&'static str, String)],
    gemini: bool,
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
    let v = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
    let mut models: Vec<String> = if gemini {
        v.get("models")
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
            .unwrap_or_default()
    } else {
        v.get("data")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("id").and_then(Value::as_str).map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    models.sort();
    Ok(models)
}
