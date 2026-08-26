//! HTTP transport primitives shared across the AI pipeline and `embeddings`:
//! the browser-envelope reqwest client, its UA constant, the request timeout,
//! and base-URL / model-id munging helpers.

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
