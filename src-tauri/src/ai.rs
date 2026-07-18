//! Cataloguing via the active AI provider, run from Rust so API keys never
//! reach the renderer and CORS is a non-issue.
//!
//! `catalogue_artefact` catalogues one artefact in a **three-step XML pipeline**
//! (validation optional, user-toggleable):
//!
//!   - **Vision analysis (unified prompt)** — image + the artefact record as
//!     `<artefact_file>` XML + the persona/output-format preamble. The model
//!     replies in a fixed XML contract: one `<image_description>`, one
//!     `<extraction field="…">` per controlled-vocab field (field-specific text
//!     used to search that field's vocab source), and one `<open_field
//!     field="…">` per open-ended field (the free-text answer, used directly).
//!   - **Embedding step** — each vocab field's *own* extraction is embedded in
//!     one batched call and searched against its LanceDB source(s); the top
//!     `net_count` candidates (default 20) are kept with their cosine scores.
//!     This per-field embedding is the primary fix for the global-vector
//!     mis-matches the previous single-description embedding produced.
//!   - **Validation (threaded from vision analysis, optional)** — one batched
//!     call presenting each vocab field's extracted text plus its ≤`net_count`
//!     candidate **terms** (no cosine, no thesaurus — pure strings). The vision
//!     model picks up to `shortlist_count` (default 3) verbatim; if none fit it
//!     returns an empty block and the field is left blank. Rust attaches each
//!     pick's cosine as `similarity`. When validation is disabled, the cosine
//!     top-`shortlist_count` is used directly.
//!
//! Open-ended fields are filled directly from vision analysis (`similarity`
//! absent); controlled-vocab fields carry cosine `similarity`. The XML format is
//! used for both the request payload (the artefact record) and the response, so
//! the model sees one consistent format.
//!
//! Providers use the OpenAI/Anthropic/Gemini chat-completions API — multi-turn
//! `messages`/`input` arrays, with the image inlined as a content block on the
//! turn that carries it.

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

/// One cataloguing-pipeline stage, surfaced as a row in the Logs Viewer.
/// `stage`/`label` drive the rendered label; `status` drives the dot colour
/// (ok/busy/fail). `job_group` ties every stage of one call together so the
/// renderer can resolve earlier "busy" dots when a terminal stage lands. The
/// same `"ac-logs"` channel also carries embedding stages emitted from
/// `embeddings.rs` (each with its own `job_group`).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PipelineStageEvent {
    stage: &'static str,
    /// Group id shared by every stage of one call (assigned before the POST,
    /// before the platform job id is known). The renderer resolves prior busy
    /// stages of the same group when a terminal stage arrives.
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

/// Emit a pipeline-stage event to the renderer. Best-effort: a logging failure
/// must never break a provider call, so errors are swallowed.
fn log_stage(app: &AppHandle, event: PipelineStageEvent) {
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

/// One catalogue field the AI must populate. For open-ended fields, the model
/// answers directly in vision analysis's `<open_field>` block. For
/// controlled-vocab fields, the model emits a field-specific `<extraction>` in
/// vision analysis; that text is embedded and searched against
/// `vocab_source_ids` to build a candidate net, then (optionally) validation
/// validates the net against the image. The vocab list itself is never sent to
/// the LLM; `similarity` is grounded in cosine.
#[derive(Deserialize, Clone)]
pub struct FieldSpec {
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub prompt: String,
    /// Ids of this field's vocab sources whose embedded index is ready for
    /// server-side retrieval (see `lib/ai.ts` `vocabSourceIdsForRetrieval`).
    /// Only meaningful for vocab-type fields; open-ended fields leave this empty.
    #[serde(rename = "vocabSourceIds", default)]
    pub vocab_source_ids: Vec<String>,
}

/// The candidate net for one vocab field — produced by per-field embedding
/// search against that field's own `<extraction>` text. Each candidate carries
/// its cosine score so validation's picks can be stamped with grounded
/// similarity. When validation is disabled, the top `shortlist_count`
/// candidates (by cosine) become the field's suggestions directly.
pub(crate) struct ResolvedVocab {
    /// Index into the `fields: Vec<FieldSpec>` passed to the resolver — which
    /// field these candidates belong to.
    pub field_index: usize,
    /// The net (≤ net_count), cosine-ranked desc, each with its score.
    pub candidates: Vec<NetCandidate>,
}

/// One shortlisted candidate with its cosine score.
pub(crate) struct NetCandidate {
    pub term: String,
    pub score: f32,
}

/// One configured artefact-file column, as seen by the vision-analysis prompt.
/// `prompt` is the optional per-column guidance the user edits on the Artefact
/// File tab; empty means "no field-specific guidance" and is omitted from the
/// prompt (the column's value still reaches the model via the record).
#[derive(Deserialize, Clone)]
pub struct ArtefactColumnSpec {
    pub name: String,
    #[serde(default)]
    pub prompt: String,
}

/// A single artefact's source record (column → value) plus optional image path.
#[derive(Deserialize, Clone)]
pub struct ArtefactInput {
    /// e.g. { "Object Name": "Bowl", "Material": "Bronze", "Image": "<extracted path>" }
    #[serde(default)]
    pub record: Value,
    /// Absolute path to the extracted image file, if any.
    #[serde(rename = "imagePath")]
    pub image_path: Option<String>,
    /// The unified vision-analysis prompt: persona + output-format preamble.
    /// The XML field enumeration and the `<artefact_file>` record block are
    /// appended by Rust at runtime, so this field holds only the user-editable
    /// prose.
    #[serde(rename = "visionSystemPrompt", default)]
    pub vision_system_prompt: String,
    /// The configured artefact-file columns with their optional per-column
    /// prompts. Used to seed the per-column guidance block in vision analysis.
    #[serde(rename = "artefactColumns", default)]
    pub artefact_columns: Vec<ArtefactColumnSpec>,
    /// **Deprecated** (kept for `settings.json` serde back-compat; the frontend
    /// no longer sends it). Was Part 1 of the old Call-2 cataloguing instruction.
    #[serde(rename = "systemPrompt", default)]
    #[allow(dead_code)]
    pub system_prompt: String,
    /// **Deprecated** (kept for serde back-compat). Was the old JSON output
    /// contract; replaced by the fixed XML contract now built in Rust.
    #[serde(rename = "systemPromptContract", default)]
    #[allow(dead_code)]
    pub system_prompt_contract: String,
}

/// One ranked suggestion returned per field. `similarity` is the cosine score
/// the embedding search assigned to the picked vocab candidate — present
/// (grounded in vector distance) for controlled-vocab fields, absent for
/// open-ended fields (never similarity-scored; the answer is taken verbatim
/// from the model's `<open_field>` reply). Serialized as `similarity`, omitted
/// from JSON entirely when `None` so open-field suggestions carry no key.
#[derive(Serialize)]
pub struct Suggestion {
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub similarity: Option<f64>,
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
const APP_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

/// Build the shared `reqwest::Client` with a browser-friendly request envelope:
/// a real `User-Agent` and a default `Accept: application/json`. Both call sites
/// (test_connection, do_completion) go through here so the envelope never drifts.
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

/// Collect every (column, value) pair from the record as strings. The record
/// only ever contains columns the user configured in the Artefact File tab
/// (the parser is config-strict — see `lib/spreadsheet.ts`), so every column
/// is meaningful and reaches the model verbatim. The Image column never arrives
/// here: the parser excludes it from `record` (its bytes travel a separate
/// fflate-extracted path into the image content block).
fn record_pairs(record: &Value) -> Vec<(String, String)> {
    let Some(obj) = record.as_object() else {
        return Vec::new();
    };
    obj.iter()
        .map(|(k, v)| {
            let val = v
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| v.to_string());
            (k.clone(), val)
        })
        .collect()
}

/// Render the artefact record as XML: `<artefact_file><Col>value</Col>…</artefact_file>`.
/// Column names are sanitized to valid XML tag names (letters/digits/`_`/`-`/`.`,
/// must start with a letter or `_`), since spreadsheet headers can contain
/// spaces and punctuation (e.g. "Curator's notes"). Collisions after sanitization
/// are disambiguated with a numeric suffix so no column's value is silently lost.
fn record_xml(record: &Value) -> String {
    let pairs = record_pairs(record);
    if pairs.is_empty() {
        return "<artefact_file></artefact_file>".to_string();
    }
    let mut used: HashMap<String, ()> = HashMap::new();
    let mut lines = Vec::new();
    for (col, val) in pairs {
        let tag = sanitize_xml_tag(&col, &mut used);
        lines.push(format!("  <{tag}>{}</{tag}>", xml_escape_text(&val)));
    }
    format!("<artefact_file>\n{}\n</artefact_file>", lines.join("\n"))
}

/// Map an arbitrary column name to a valid XML tag name (start letter/`_`;
/// subsequent chars letter/digit/`-`/`.`/`_`). Whitespace runs collapse to `_`;
/// other disallowed chars are dropped. Empty results fall back to `col`. Each
/// produced tag is checked against `used` and suffixed to avoid collisions.
fn sanitize_xml_tag(col: &str, used: &mut HashMap<String, ()>) -> String {
    let mut out = String::new();
    for (i, ch) in col.trim().chars().enumerate() {
        let valid = ch.is_alphanumeric() || matches!(ch, '_' | '-' | '.');
        if i == 0 {
            if ch.is_alphabetic() || ch == '_' {
                out.push(ch);
            } else if valid {
                out.push('_');
                out.push(ch);
            } else if ch.is_whitespace() {
                out.push('_');
            }
            // else: drop leading punctuation
        } else if valid {
            out.push(ch);
        } else if ch.is_whitespace() {
            out.push('_');
        }
        // else: drop disallowed chars
    }
    if out.is_empty() {
        out = "col".to_string();
    }
    // Disambiguate collisions.
    let mut candidate = out.clone();
    let mut n = 2;
    while used.contains_key(&candidate) {
        candidate = format!("{out}_{n}");
        n += 1;
    }
    used.insert(candidate.clone(), ());
    candidate
}

/// Escape text for inclusion as XML element content (`&`, `<`, `>`).
fn xml_escape_text(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Escape text for a double-quoted XML attribute value. Element-content
/// escapes plus `"` and `'` (the XML spec requires quotes escaped inside
/// attribute values; we only emit double-quoted attrs, but escape both for
/// safety). Used wherever user-controlled text is interpolated into `attr="…"`
/// — e.g. `<extraction field="{name}">` — so a name containing `"` can't break
/// out of the attribute and corrupt the prompt's structure.
fn xml_escape_attr(s: &str) -> String {
    xml_escape_text(s)
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Compose the unified vision-analysis prompt. Structure (joined by blank lines):
///   1. The user-editable persona + output-format preamble (the merged "System
///      Prompt" from ArtefactFileTab). This text *already* instructs the model
///      to read `<artefact_file>` and reply in XML.
///   2. Per-column guidance block (only non-empty prompts).
///   3. The Rust-appended field enumeration, led by one `<image_description>`
///      block then one `<extraction field="…">` per vocab field and one
///      `<open_field field="…">` per open field, with each field's non-empty
///      `prompt` injected inline. This cannot live in the editable text because
///      it depends on the user's live field config. The leading
///      `<image_description>` line is repeated here (it also appears in the
///      preamble's format template) because models treat this concrete, ordered
///      list as the authoritative per-call spec and otherwise drop the tag —
///      see `parse_unified_response`'s `<image_description> missing` warning.
///   4. The `<artefact_file>` record block.
///   5. A no-image note when applicable.
fn build_unified_prompt(
    persona_preamble: &str,
    columns: &[ArtefactColumnSpec],
    fields: &[FieldSpec],
    record: &Value,
    has_image: bool,
) -> String {
    let mut sections = Vec::new();
    let preamble = persona_preamble.trim();
    if !preamble.is_empty() {
        sections.push(preamble.to_string());
    }
    let guided: Vec<&ArtefactColumnSpec> = columns
        .iter()
        .filter(|c| !c.prompt.trim().is_empty())
        .collect();
    if !guided.is_empty() {
        let lines: Vec<String> = guided
            .iter()
            .map(|c| format!("- {}: {}", c.name, c.prompt.trim()))
            .collect();
        sections.push(format!(
            "Metadata columns and how to use them:\n{}",
            lines.join("\n")
        ));
    }
    // Rust-appended field enumeration (matches the preamble's XML schema).
    // Lead with `<image_description>` so the model includes it; it is the only
    // tag the preamble lists that the per-field loop below would otherwise omit,
    // and models follow this concrete list over the preamble's template.
    let mut enum_lines = vec![
        "<image_description> a rich, evidence-based description of the artefact </image_description>"
            .to_string(),
    ];
    for f in fields {
        let prompt = f.prompt.trim();
        let guidance = if prompt.is_empty() {
            String::new()
        } else {
            format!(" ({prompt})")
        };
        if f.field_type == "vocab" {
            enum_lines.push(format!(
                "<extraction field=\"{}\">{}</extraction>",
                xml_escape_attr(&f.name),
                guidance
            ));
        } else {
            enum_lines.push(format!(
                "<open_field field=\"{}\">{}</open_field>",
                xml_escape_attr(&f.name),
                guidance
            ));
        }
    }
    sections.push(format!(
        "Reply with one <image_description> block, then one block per field, in this order, using the field names exactly:\n{}",
        enum_lines.join("\n")
    ));
    sections.push(record_xml(record));
    if !has_image {
        sections.push(
            "No image is attached for this artefact — base your description on the metadata above and note that it is lower-confidence as a result.".to_string(),
        );
    }
    sections.join("\n\n")
}

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
fn parse_completion_content(fmt: ApiFormat, v: &Value) -> Result<String, String> {
    // OpenAI: choices[0].message.content. Anthropic: content[0].text.
    let content = match fmt {
        // OpenRouter (and some other providers) may return content as a parts array
        // [{type:"text",text:"..."}] rather than a plain string, so try both.
        ApiFormat::OpenAi => {
            let c = &v["choices"][0]["message"]["content"];
            c.as_str()
                .map(str::to_string)
                .or_else(|| {
                    c.as_array()?
                        .iter()
                        .filter_map(|p| p.get("text").and_then(Value::as_str))
                        .next()
                        .map(str::to_string)
                })
                .ok_or_else(|| "response missing choices[0].message.content".to_string())?
        }
        ApiFormat::Anthropic => v["content"][0]["text"]
            .as_str()
            .ok_or_else(|| "response missing content[0].text".to_string())?
            .to_string(),
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

async fn do_completion(
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

    // Surface the selected model for OpenRouter free-router debugging (the free
    // router picks a model dynamically; the response `model` field reveals which).
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

/// Strip a leading/trailing Markdown code fence (``` or ~~~, with optional
/// language tag) if present. The XML parsers tolerate fences so a model that
/// wraps its answer despite being told not to still parses cleanly.
fn strip_code_fence(s: &str) -> &str {
    let trimmed = s.trim();
    let close_fence = |open: &str| {
        if let Some(rest) = trimmed.strip_prefix(open) {
            // Skip an optional language tag on the opening line (e.g. ```xml).
            let after_tag = rest.find('\n').map(|n| &rest[n + 1..]).unwrap_or(rest);
            after_tag
                .trim_end()
                .strip_suffix(open)
                .map(str::trim)
                .unwrap_or(after_tag)
        } else {
            trimmed
        }
    };
    close_fence("```").trim_end()
}

/// The parsed result of vision analysis's unified XML response. Vocab fields'
/// `extractions` are embedded to build the candidate net; open fields'
/// `open_values` become the field's suggestion directly (no similarity).
/// Missing sections surface as warnings rather than errors. The
/// `<image_description>` is parsed by `trim_for_validation` directly from the
/// raw response when building validation's context, so it isn't carried here.
struct UnifiedParse {
    extractions: HashMap<String, String>,
    open_values: HashMap<String, String>,
    warnings: Vec<String>,
}

/// Find the substring of `haystack` between the first `<tag ...>` and its
/// matching `</tag>`, honoring the case-insensitive tag name. Attributes on the
/// open tag are allowed (e.g. `<extraction field="Material">`). Returns the
/// inner text (between the tags), trimmed. `None` if the tag pair isn't found.
fn extract_tag_block<'a>(haystack: &'a str, tag: &str) -> Option<&'a str> {
    let lower = haystack.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let start = lower.find(&open)?;
    // The open tag ends at the next '>'.
    let inner_start = lower[start..].find('>')? + start + 1;
    let close_start = lower[inner_start..]
        .find(&close.to_ascii_lowercase())
        .map(|p| inner_start + p)?;
    Some(haystack[inner_start..close_start].trim())
}

/// Read the value of an attribute on a tag's opening text. `tag_text` is the
/// full opening tag slice (e.g. `<extraction field="Material">`). Case-
/// insensitive attribute name match; returns the de-quoted value.
fn tag_attr(tag_text: &str, attr: &str) -> Option<String> {
    let lower = tag_text.to_ascii_lowercase();
    let needle = format!("{attr}=");
    let idx = lower.find(&needle)?;
    let after = &tag_text[idx + needle.len()..];
    let after_trim = after.trim_start();
    let quote = after_trim.chars().next()?;
    if quote == '"' || quote == '\'' {
        let rest = &after_trim[1..];
        let end = rest.find(quote)?;
        Some(rest[..end].to_string())
    } else {
        // Unquoted attribute — read until whitespace or '>'.
        let end = after_trim
            .find(|c: char| c.is_whitespace() || c == '>')
            .unwrap_or(after_trim.len());
        Some(after_trim[..end].to_string())
    }
}

/// Parse vision analysis's XML response. Tolerant of a code fence or
/// surrounding prose (the contract forbids them, but models add them anyway).
/// For each vocab field, records its `<extraction>` text (empty string if
/// absent or empty — the resolver treats both as "no candidates"); for each
/// open field, records its `<open_field>` text. Missing or empty sections
/// become warnings so a blank field in the UI is traceable, with distinct
/// wording: "missing" when the tag was never emitted (the model broke the
/// format) versus "empty" when the tag was emitted but blank (the model
/// correctly had nothing to say). A missing `<image_description>` is warned on
/// (a useful vision-analysis health signal) but its text isn't carried —
/// validation's context is built by `trim_for_validation` straight from the
/// raw response.
fn parse_unified_response(content: &str, fields: &[FieldSpec]) -> UnifiedParse {
    let body = strip_code_fence(content);
    let mut extractions: HashMap<String, String> = HashMap::new();
    let mut open_values: HashMap<String, String> = HashMap::new();
    let mut warnings = Vec::new();

    if extract_tag_block(body, "image_description").is_none() {
        warnings.push("<image_description> missing from response".to_string());
    }

    // Collect every <extraction field="…"> and <open_field field="…"> block,
    // then match by name to the requested fields. Models sometimes emit a field
    // twice or vary casing, so we build a name→text map first. The map keys
    // presence (absent key = tag missing) apart from emptiness (key present,
    // empty value) so the warnings below can distinguish the two.
    let extraction_map = collect_named_blocks(body, "extraction");
    let open_map = collect_named_blocks(body, "open_field");

    for f in fields {
        let key = f.name.to_ascii_lowercase();
        if f.field_type == "vocab" {
            let text = extraction_map.get(&key).cloned().unwrap_or_default();
            if text.is_empty() {
                warnings.push(format!(
                    "{}: <extraction> {} — no candidates will be searched",
                    f.name,
                    if extraction_map.contains_key(&key) {
                        "empty"
                    } else {
                        "missing"
                    }
                ));
            }
            extractions.insert(f.name.clone(), text);
        } else {
            let text = open_map.get(&key).cloned().unwrap_or_default();
            if text.is_empty() {
                warnings.push(format!(
                    "{}: <open_field> {}",
                    f.name,
                    if open_map.contains_key(&key) {
                        "empty"
                    } else {
                        "missing"
                    }
                ));
            }
            open_values.insert(f.name.clone(), text);
        }
    }
    UnifiedParse {
        extractions,
        open_values,
        warnings,
    }
}

/// True when the vision-analysis response contains none of the contract's XML
/// tags — i.e. the model didn't attempt the output format at all. The classic
/// cause is a wrong model behind a free/auto router (e.g. a moderation model
/// replying "User Safety: safe") or a non-instruct model. Deliberately distinct
/// from a partial-but-contract-shaped response (some tags present, some empty),
/// which the per-field warnings in `parse_unified_response` already cover —
/// this only fires when the response is structurally unrecognizable.
fn looks_like_unrecognized_response(content: &str) -> bool {
    let lower = content.to_ascii_lowercase();
    !lower.contains("<image_description")
        && !lower.contains("<extraction")
        && !lower.contains("<open_field")
}

/// Collect all `<tag field="Name">text</tag>` blocks into a lowercased-name →
/// text map. Tolerates repeated tags (last wins) and attribute casing. An empty
/// tag like `<extraction field="Place"></extraction>` is recorded with the
/// empty string as its value; an absent key means the tag was never emitted.
/// Callers distinguish the two via `contains_key` so "missing" (model broke
/// format) and "empty" (model correctly had nothing to say) warn differently.
fn collect_named_blocks(body: &str, tag: &str) -> HashMap<String, String> {
    let lower = body.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out: HashMap<String, String> = HashMap::new();
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find(&open) {
        let abs = search_from + rel;
        let open_end = match lower[abs..].find('>') {
            Some(p) => abs + p,
            None => break,
        };
        let open_text = &body[abs..=open_end];
        let inner_start = open_end + 1;
        let close_rel = match lower[inner_start..].find(&close) {
            Some(p) => inner_start + p,
            None => break,
        };
        let inner = body[inner_start..close_rel].trim().to_string();
        if let Some(name) = tag_attr(open_text, "field") {
            out.insert(name.to_ascii_lowercase(), inner);
        }
        search_from = close_rel + close.len();
    }
    out
}

/// Parse validation's XML response into field-name → list of picked term strings.
/// Each pick's `term` is returned verbatim; the **caller** stamps it with its
/// cosine from the net (the model does not report similarity). Terms not present
/// in that field's candidate set (case-insensitive, trimmed) are dropped as
/// hallucinations and warned — a controlled-vocab field may only ever receive
/// values that exist in its source.
fn parse_validation_response(
    content: &str,
    field_candidates: &HashMap<String, Vec<String>>,
) -> (HashMap<String, Vec<String>>, Vec<String>) {
    let body = strip_code_fence(content);
    let lower = body.to_ascii_lowercase();
    let open = "<validated";
    let close = "</validated>";
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    let mut warnings = Vec::new();
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find(open) {
        let abs = search_from + rel;
        let open_end = match lower[abs..].find('>') {
            Some(p) => abs + p,
            None => break,
        };
        let open_text = &body[abs..=open_end];
        let inner_start = open_end + 1;
        let close_rel = match lower[inner_start..].find(close) {
            Some(p) => inner_start + p,
            None => break,
        };
        let block = &body[inner_start..close_rel];
        let field_name = tag_attr(open_text, "field").unwrap_or_default();
        let picks = extract_picks(block);
        let allowed: Vec<String> = field_candidates
            .get(&field_name.to_ascii_lowercase())
            .cloned()
            .unwrap_or_default();
        let allowed_lower: Vec<String> = allowed
            .iter()
            .map(|t| t.trim().to_ascii_lowercase())
            .collect();
        let mut kept: Vec<String> = Vec::new();
        for pick in picks {
            if allowed_lower.contains(&pick.trim().to_ascii_lowercase()) {
                // Preserve the candidate's original casing from the net.
                let original = allowed
                    .iter()
                    .find(|a| a.trim().eq_ignore_ascii_case(&pick))
                    .cloned()
                    .unwrap_or(pick);
                kept.push(original);
            } else {
                warnings.push(format!(
                    "{field_name}: dropped hallucinated pick \"{pick}\" (not in candidate list)"
                ));
            }
        }
        out.insert(field_name.to_ascii_lowercase(), kept);
        search_from = close_rel + close.len();
    }
    (out, warnings)
}

/// Read every `<pick term="…" />` from a `<validated>` block's inner text.
/// Self-closing only (the contract). Term returned de-quoted, trimmed.
fn extract_picks(block: &str) -> Vec<String> {
    let lower = block.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find("<pick") {
        let abs = search_from + rel;
        let end = match lower[abs..].find("/>") {
            Some(p) => abs + p + 2,
            None => {
                // Tolerate a non-self-closing <pick term="…"></pick> as a fallback.
                match lower[abs..].find('>') {
                    Some(p) => abs + p + 1,
                    None => break,
                }
            }
        };
        let open_text = &block[abs..end];
        if let Some(term) = tag_attr(open_text, "term") {
            out.push(term.trim().to_string());
        }
        search_from = end;
    }
    out
}

/// Compose the validation prompt. For each vocab field: the field name,
/// its extracted text (from vision analysis), an optional per-field `prompt`
/// (e.g. user preferences), and a list of its candidate **terms only** — no
/// cosine, no thesaurus badge, to avoid biasing the model toward internal
/// scores. Ends with the fixed XML reply contract. Pure; built once per
/// catalogue call.
fn build_validation_prompt(
    shortlists: &[(usize, &FieldSpec, &str, &[NetCandidate])],
    shortlist_count: usize,
) -> String {
    let mut sections = Vec::new();
    for (_, field, extracted, candidates) in shortlists {
        let mut block = format!("[{}] extracted: \"{}\"", field.name, extracted);
        let prompt = field.prompt.trim();
        if !prompt.is_empty() {
            block.push_str(&format!("\nguidance: {prompt}"));
        }
        if candidates.is_empty() {
            block.push_str("\ncandidates: (none)");
        } else {
            let terms: Vec<String> = candidates.iter().map(|c| format!("- {}", c.term)).collect();
            block.push_str(&format!("\ncandidates:\n{}", terms.join("\n")));
        }
        sections.push(block);
    }
    let contract = format!(
        "Pick up to {shortlist_count} terms per field that best match the artefact and its extracted text. Pick terms VERBATIM from each field's candidate list — do not invent, reword, or merge terms. If none of a field's candidates fit the artefact, emit an empty <validated> block for it.\n\nReply ONLY with, one block per field in the order above:\n<validated field=\"{{Field Name}}\"><pick term=\"{{verbatim candidate term}}\" /></validated>"
    );
    sections.push(contract);
    sections.join("\n\n")
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

/// Default candidate count the embedding search returns per vocab field before
/// validation (the "net"). User-configurable via `Settings.vocabNetCount`. Kept
/// generous so validation has a wide net to reject from; the previous single-
/// description embedding's small fixed count (10) was a root cause of poor
/// matches — the right term was often outside the window.
const DEFAULT_VOCAB_NET_COUNT: usize = 20;
/// Default final picks per vocab field after validation. User-configurable via
/// `Settings.vocabShortlistCount`.
const DEFAULT_VOCAB_SHORTLIST_COUNT: usize = 3;
/// Whether validation runs by default. User-configurable via
/// `Settings.validationEnabled`. Note the frontend default is `false`
/// (`src/app/defaults.ts`); this constant is only the Rust fallback when the
/// frontend omits the flag.
const DEFAULT_VALIDATION_ENABLED: bool = true;

/// Resolve every controlled-vocabulary field via per-field embedding search.
///
/// Unlike the previous pipeline (which embedded the *single* global description
/// once and reused it for every field — the root cause of poor matches like
/// "u-shape" for a circular object), this embeds each vocab field's **own**
/// `<extraction>` text in one batched call and searches that field's LanceDB
/// tables with it. Results across sources/modalities are fused by **max cosine
/// similarity**, and the top `net_count` candidates are kept (with their cosine)
/// as the net for validation (or directly truncated to `shortlist_count` when
/// validation is off). No thesaurus tiebreak — candidate ranking is the
/// embedding's alone, and final selection is validation's.
///
/// Best-effort on the *search* leg (a missing LanceDB table leaves the field
/// with an empty net, surfaced as "no match"), but the two embedding calls are
/// hard failures: a failed `embed_texts` aborts the whole row (no candidates
/// possible), and — since embedding providers must be multimodal — a failed
/// `embed_image_with_retry` also aborts the row rather than silently degrading
/// to text-only. A field whose `<extraction>` was empty yields no candidates
/// and warns.
async fn resolve_vocab_fields(
    embedding_provider: &crate::embeddings::EmbeddingProvider,
    fields: &[FieldSpec],
    extractions: &HashMap<String, String>,
    image: Option<&ImageData>,
    net_count: usize,
) -> Result<Vec<ResolvedVocab>, String> {
    let mut out: Vec<ResolvedVocab> = Vec::new();
    // Collect the per-field extraction texts to embed in ONE batched call.
    // (i, field) for vocab fields whose extraction is non-empty.
    let to_embed: Vec<(usize, &FieldSpec, String)> = fields
        .iter()
        .enumerate()
        .filter(|(_, f)| f.field_type == "vocab" && !f.vocab_source_ids.is_empty())
        .filter_map(|(i, f)| {
            let text = extractions.get(&f.name).cloned().unwrap_or_default();
            if text.trim().is_empty() {
                // Empty extraction: record an empty net so the field surfaces as
                // "no match" with a clear reason, rather than silently dropping it.
                out.push(ResolvedVocab {
                    field_index: i,
                    candidates: Vec::new(),
                });
                None
            } else {
                Some((i, f, text))
            }
        })
        .collect();
    if to_embed.is_empty() {
        return Ok(out);
    }

    // One batched embedding of all field extractions. A failure here means no
    // vocab candidates are possible — propagate as a hard row failure.
    let texts: Vec<String> = to_embed.iter().map(|(_, _, t)| t.clone()).collect();
    let text_vectors = crate::embeddings::embed_texts(embedding_provider, &texts)
        .await
        .map_err(|e| format!("per-field extraction embedding failed: {e}"))?;
    if text_vectors.is_empty() {
        return Err("per-field extraction embedding returned no vectors".to_string());
    }

    // Image embedding is mandatory when an image is present (providers are
    // multimodal). A network error is retried once inside the helper; any
    // remaining failure hard-fails this row so the user sees the problem
    // instead of silently getting text-only retrieval.
    let image_vector = match image {
        Some(img) => Some(
            crate::embeddings::embed_image_with_retry(embedding_provider, img)
                .await
                .map_err(|e| format!("image embedding failed: {}", e.message()))?,
        ),
        None => None,
    };

    for ((i, field, _text), text_vector) in to_embed.iter().zip(text_vectors.iter()) {
        // Fused best cosine per candidate, keyed by lowercased term so the same
        // term surfacing from multiple sources/modalities merges at its highest
        // score.
        let mut fused: HashMap<String, NetCandidate> = HashMap::new();
        for source_id in &field.vocab_source_ids {
            if let Ok(hits) =
                crate::embeddings::search_similar(source_id, text_vector, net_count).await
            {
                fuse_by_max_cosine(&mut fused, &hits);
            }
            if let Some(iv) = &image_vector {
                if let Ok(hits) = crate::embeddings::search_similar(source_id, iv, net_count).await
                {
                    fuse_by_max_cosine(&mut fused, &hits);
                }
            }
        }
        let mut ranked: Vec<NetCandidate> = fused.into_values().collect();
        // Sort by cosine desc (stable on equal). No thesaurus tiebreak —
        // validation owns final selection, and the user's per-field prompt
        // guides it.
        ranked.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        ranked.truncate(net_count);
        out.push(ResolvedVocab {
            field_index: *i,
            candidates: ranked,
        });
    }
    Ok(out)
}

/// Fold one ranked candidate list into the running max-cosine map, keeping each
/// term's highest score.
fn fuse_by_max_cosine(
    fused: &mut HashMap<String, NetCandidate>,
    hits: &[crate::embeddings::CandidateTerm],
) {
    for hit in hits {
        let key = hit.term.to_lowercase();
        fused
            .entry(key)
            .and_modify(|existing| {
                if hit.score > existing.score {
                    existing.score = hit.score;
                }
            })
            .or_insert_with(|| NetCandidate {
                term: hit.term.clone(),
                score: hit.score,
            });
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn catalogue_artefact(
    app: AppHandle,
    cancel_registry: State<'_, CancelRegistry>,
    job_id: String,
    provider: Provider,
    fields: Vec<FieldSpec>,
    artefact: ArtefactInput,
    embedding_provider: Option<crate::embeddings::EmbeddingProvider>,
    // Candidates the embedding search returns per vocab field before
    // validation. Frontend sends `netCount`; Tauri maps camelCase → snake_case.
    // An `Option<T>` command param is optional by default (absent → `None`),
    // so no `#[serde(default)]` is needed (that attribute is only valid on
    // struct fields, not function parameters).
    net_count: Option<usize>,
    // Final picks per vocab field after validation (or cosine top-N when
    // validation is off). Frontend sends `shortlistCount`.
    shortlist_count: Option<usize>,
    // Whether validation runs. Frontend sends `validationEnabled`; Tauri maps
    // camelCase → snake_case for command params (see `net_count` above).
    validation_enabled: Option<bool>,
) -> Result<CatalogueResult, String> {
    let net_count = net_count.unwrap_or(DEFAULT_VOCAB_NET_COUNT).max(1);
    let shortlist_count = shortlist_count
        .unwrap_or(DEFAULT_VOCAB_SHORTLIST_COUNT)
        .clamp(1, net_count);
    let validation_enabled = validation_enabled.unwrap_or(DEFAULT_VALIDATION_ENABLED);

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

    // Register this call's cancel signal before starting any work so a
    // cancel that arrives the instant the pipeline begins can't race past the
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
        registry: &cancel_registry,
        job_id: job_id.clone(),
    };

    // The whole per-row pipeline races the cancel signal as one unit, so
    // Stop/Cancel works the same whether a row is mid-vision-analysis,
    // mid-embed, or mid-validation. Dropping the future on cancel aborts its
    // in-flight reqwest request (the client closes the connection on drop).
    //
    // Three steps feed one result:
    //   - Vision analysis: XML description + per-vocab-field <extraction> +
    //     per-open-field <open_field>.
    //   - Embedding: each vocab field's extraction → candidate net (cosine).
    //   - Validation (optional, threaded): vision picks top-N from each
    //     field's net; when off, cosine top-N is used directly.
    let app_for_pipeline = app.clone();
    let pipeline = async move {
        // --- Vision analysis: unified prompt (image attached here, once) ---
        // Reused verbatim as the first turn of the validation thread so the
        // model keeps the image, the persona, and the <artefact_file> record
        // in context while validating candidates.
        let unified_prompt = build_unified_prompt(
            &artefact.vision_system_prompt,
            &artefact.artefact_columns,
            &fields,
            &artefact.record,
            image.is_some(),
        );
        let turns1 = vec![Turn {
            role: TurnRole::User,
            text: unified_prompt.clone(),
            image: image.clone(),
        }];
        let (content1, _vision_group) =
            do_completion(&app_for_pipeline, &provider, "Vision Analysis", &turns1).await?;

        let parsed = parse_unified_response(&content1, &fields);

        // Fail loudly when vision analysis ignored the contract entirely. A 200
        // with no <image_description>/<extraction>/<open_field> is the signature
        // of a wrong model (free-router landing on a moderation model like
        // "User Safety: safe", or a non-instruct model). Surfacing it as a hard,
        // named error beats silent empty fields + vague per-field warnings, and
        // lets the renderer's fail-fast path stop the run instead of dragging
        // every remaining row through it.
        if looks_like_unrecognized_response(&content1) {
            return Err(format!(
                "Vision analysis returned an unrecognized response (no XML tags). \
                 The configured model {:?} may not be vision- or instruction-capable — \
                 check the active provider's model (avoid free/auto routers and \
                 moderation models). Response was: {:?}",
                provider.model,
                content1.chars().take(200).collect::<String>()
            ));
        }

        // --- Embedding: per-field extraction → candidate net ---
        // Only when there's at least one vocab field with a usable source AND an
        // embedding provider. Otherwise validation is pointless and is skipped.
        let has_vocab = fields
            .iter()
            .any(|f| f.field_type == "vocab" && !f.vocab_source_ids.is_empty());
        let resolved_vocab: Vec<ResolvedVocab> = if has_vocab {
            match embedding_provider.as_ref() {
                Some(ep) => {
                    resolve_vocab_fields(
                        ep,
                        &fields,
                        &parsed.extractions,
                        image.as_ref(),
                        net_count,
                    )
                    .await?
                }
                None => Vec::new(),
            }
        } else {
            Vec::new()
        };

        // --- Validation (optional), threaded & trimmed from vision analysis ---
        // The assistant turn replays a TRIMMED vision-analysis answer:
        // image_description + extractions only. The <open_field> answers are
        // irrelevant to vocab validation and would only add tokens. The image
        // is re-sent via the replayed vision-analysis user turn because
        // vision-grounded disambiguation is validation's purpose; this is the
        // bulk of the token cost and is a deliberate, one-line-reversible
        // decision.
        let mut vocab_suggestions: HashMap<String, Vec<Suggestion>> = HashMap::new();
        let mut vocab_warnings: Vec<String> = Vec::new();
        if validation_enabled && has_vocab && !resolved_vocab.is_empty() {
            // Build the per-field shortlist references for the prompt.
            let shortlist_refs: Vec<(usize, &FieldSpec, &str, &[NetCandidate])> = resolved_vocab
                .iter()
                .filter_map(|rv| {
                    let field = fields.get(rv.field_index)?;
                    let extracted = parsed
                        .extractions
                        .get(&field.name)
                        .map(String::as_str)
                        .unwrap_or("");
                    Some((rv.field_index, field, extracted, rv.candidates.as_slice()))
                })
                .collect();
            if !shortlist_refs.is_empty() {
                let validation_prompt = build_validation_prompt(&shortlist_refs, shortlist_count);
                let trimmed_assistant = trim_for_validation(&content1);
                let turns3 = vec![
                    Turn {
                        role: TurnRole::User,
                        text: unified_prompt,
                        image: image.clone(),
                    },
                    Turn {
                        role: TurnRole::Assistant,
                        text: trimmed_assistant,
                        image: None,
                    },
                    Turn {
                        role: TurnRole::User,
                        text: validation_prompt,
                        image: None,
                    },
                ];
                let (validation_content, _validation_group) =
                    do_completion(&app_for_pipeline, &provider, "Vocab Validation", &turns3)
                        .await?;

                // Map field name (lowercased) → candidate terms, for the
                // hallucination guard in the parser.
                let mut field_candidates: HashMap<String, Vec<String>> = HashMap::new();
                for (_, field, _, candidates) in &shortlist_refs {
                    field_candidates.insert(
                        field.name.to_ascii_lowercase(),
                        candidates.iter().map(|c| c.term.clone()).collect(),
                    );
                }
                let (picks_by_field, mut pick_warnings) =
                    parse_validation_response(&validation_content, &field_candidates);
                vocab_warnings.append(&mut pick_warnings);

                // Stamp each pick with its cosine from the net, truncate to the
                // shortlist count, in net order (so they stay cosine-ranked).
                let cosine_of = |field_lower: &str, term: &str| -> Option<f32> {
                    shortlist_refs.iter().find_map(|(_, f, _, cands)| {
                        if f.name.eq_ignore_ascii_case(field_lower) {
                            cands.iter().find_map(|c| {
                                c.term
                                    .trim()
                                    .eq_ignore_ascii_case(term.trim())
                                    .then_some(c.score)
                            })
                        } else {
                            None
                        }
                    })
                };
                for rv in &resolved_vocab {
                    let Some(field) = fields.get(rv.field_index) else {
                        continue;
                    };
                    let picks = picks_by_field
                        .get(&field.name.to_ascii_lowercase())
                        .cloned()
                        .unwrap_or_default();
                    let mut sugs: Vec<Suggestion> = picks
                        .into_iter()
                        .map(|term| {
                            let score = cosine_of(&field.name, &term).unwrap_or(0.0);
                            Suggestion {
                                value: term,
                                similarity: Some(score.clamp(0.0, 1.0) as f64),
                            }
                        })
                        .take(shortlist_count)
                        .collect();
                    if sugs.is_empty() {
                        vocab_warnings.push(format!(
                            "{}: no candidates matched after validation",
                            field.name
                        ));
                    }
                    // Keep net (cosine) order among the kept picks.
                    sugs.sort_by(|a, b| {
                        b.similarity
                            .unwrap_or(0.0)
                            .partial_cmp(&a.similarity.unwrap_or(0.0))
                            .unwrap_or(std::cmp::Ordering::Equal)
                    });
                    vocab_suggestions.insert(field.name.clone(), sugs);
                }
            }
        } else if has_vocab {
            // Validation disabled: use cosine top-N from each net directly.
            for rv in &resolved_vocab {
                if let Some(field) = fields.get(rv.field_index) {
                    let sugs: Vec<Suggestion> = rv
                        .candidates
                        .iter()
                        .take(shortlist_count)
                        .map(|c| Suggestion {
                            value: c.term.clone(),
                            similarity: Some(c.score.clamp(0.0, 1.0) as f64),
                        })
                        .collect();
                    vocab_suggestions.insert(field.name.clone(), sugs);
                }
            }
        }

        let mut all_warnings = parsed.warnings.clone();
        all_warnings.extend(vocab_warnings);
        // Merge: open fields (similarity absent) + vocab fields (cosine).
        let mut field_results = std::collections::BTreeMap::new();
        for f in &fields {
            if f.field_type == "vocab" {
                field_results.insert(
                    f.name.clone(),
                    vocab_suggestions.remove(&f.name).unwrap_or_default(),
                );
            } else {
                let val = parsed.open_values.get(&f.name).cloned().unwrap_or_default();
                let sugs = if val.is_empty() {
                    Vec::new()
                } else {
                    vec![Suggestion {
                        value: val,
                        similarity: None,
                    }]
                };
                field_results.insert(f.name.clone(), sugs);
            }
        }
        Ok::<_, String>((CatalogueResult { field_results }, all_warnings))
    };
    let (result, warnings) = tokio::select! {
        biased;
        _ = cancel_rx => return Err(CANCEL_ERROR.to_string()),
        result = pipeline => result?,
    };

    // Surface parse/validation warnings as a soft "done/ok" log entry rather
    // than failing the whole request, since other fields likely parsed fine.
    if !warnings.is_empty() {
        log_stage(
            &app,
            PipelineStageEvent {
                stage: "done",
                job_group: String::new(),
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
                    description: None,
                    error: None,
                }),
            },
        );
    }

    Ok(result)
}

/// Trim vision analysis's XML answer down to just the parts validation needs:
/// the `<image_description>` and every `<extraction>` block. `<open_field>`
/// answers are dropped (irrelevant to vocab validation). Falls back to the full
/// answer if parsing yields nothing, so validation always has *some* assistant
/// context.
fn trim_for_validation(content1: &str) -> String {
    let body = strip_code_fence(content1);
    let mut out = Vec::new();
    if let Some(desc) = extract_tag_block(body, "image_description") {
        out.push(format!("<image_description>{desc}</image_description>"));
    }
    let lower = body.to_ascii_lowercase();
    let open = "<extraction";
    let close = "</extraction>";
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find(open) {
        let abs = search_from + rel;
        let open_end = match lower[abs..].find('>') {
            Some(p) => abs + p,
            None => break,
        };
        let inner_start = open_end + 1;
        let close_rel = match lower[inner_start..].find(close) {
            Some(p) => inner_start + p,
            None => break,
        };
        out.push(body[abs..close_rel + close.len()].trim().to_string());
        search_from = close_rel + close.len();
    }
    if out.is_empty() {
        content1.to_string()
    } else {
        out.join("\n\n")
    }
}

/// Assemble the unified vision-analysis prompt exactly as `catalogue_artefact`
/// would send it as its first user turn, without making any network call. Used
/// by the Artefact File tab's prompt preview. The row's source values are
/// produced at parse time, so the record is shown as a placeholder; the image
/// attaches as a separate content block in real runs.
#[tauri::command]
pub fn build_vision_prompt_preview(
    columns: Vec<ArtefactColumnSpec>,
    fields: Vec<FieldSpec>,
    artefact: ArtefactInput,
) -> String {
    build_unified_prompt(
        &artefact.vision_system_prompt,
        &columns,
        &fields,
        &artefact.record,
        true,
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
                        .filter_map(|m| {
                            m.get("name")
                                .and_then(Value::as_str)
                                .map(strip_models_prefix)
                        })
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
pub(crate) fn strip_models_prefix(name: &str) -> String {
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
            vocab_source_ids: Vec::new(),
        }
    }

    fn vocab_field(name: &str) -> FieldSpec {
        FieldSpec {
            name: name.to_string(),
            field_type: "vocab".to_string(),
            prompt: String::new(),
            vocab_source_ids: Vec::new(),
        }
    }

    #[test]
    fn parse_unified_extracts_extractions_and_open_values() {
        let content = r#"<image_description>A bronze bowl.</image_description>
<extraction field="Material">bronze, patinated</extraction>
<extraction field="Shape">circular</extraction>
<open_field field="Date/Period">8th century CE</open_field>"#;
        let fields = vec![
            vocab_field("Material"),
            vocab_field("Shape"),
            open_field("Date/Period"),
        ];
        let parsed = parse_unified_response(content, &fields);
        // The description text isn't carried on the struct (see its doc
        // comment), but a present <image_description> must NOT warn.
        assert!(!parsed
            .warnings
            .iter()
            .any(|w| w.contains("image_description")));
        assert_eq!(
            parsed.extractions.get("Material").unwrap(),
            "bronze, patinated"
        );
        assert_eq!(parsed.extractions.get("Shape").unwrap(), "circular");
        assert_eq!(
            parsed.open_values.get("Date/Period").unwrap(),
            "8th century CE"
        );
        assert!(parsed.warnings.is_empty());
    }

    #[test]
    fn parse_unified_tolerates_code_fence_and_prose() {
        let content = "Here is my answer:\n```xml\n<image_description>x</image_description>\n<extraction field=\"Material\">iron</extraction>\n```\nDone.";
        let fields = vec![vocab_field("Material")];
        let parsed = parse_unified_response(content, &fields);
        assert_eq!(parsed.extractions.get("Material").unwrap(), "iron");
        assert!(parsed.warnings.is_empty());
    }

    #[test]
    fn parse_unified_warns_on_missing_sections() {
        // Only image_description present; Material (vocab) and Date (open) missing.
        let content = "<image_description>just a description</image_description>";
        let fields = vec![vocab_field("Material"), open_field("Date/Period")];
        let parsed = parse_unified_response(content, &fields);
        assert_eq!(parsed.extractions.get("Material").unwrap(), "");
        assert_eq!(parsed.open_values.get("Date/Period").unwrap(), "");
        // Two field warnings; the present image_description does NOT warn.
        assert_eq!(parsed.warnings.len(), 2);
        assert!(parsed.warnings.iter().any(|w| w.contains("Material")));
        assert!(parsed.warnings.iter().any(|w| w.contains("Date/Period")));
    }

    #[test]
    fn parse_unified_warns_on_missing_image_description() {
        // No <image_description> at all — the parser surfaces it as a health
        // warning even though the field isn't carried on the struct.
        let content = r#"<extraction field="Material">bronze</extraction>"#;
        let fields = vec![vocab_field("Material")];
        let parsed = parse_unified_response(content, &fields);
        assert!(parsed
            .warnings
            .iter()
            .any(|w| w.contains("image_description")));
    }

    #[test]
    fn parse_unified_warns_empty_distinct_from_missing_extraction() {
        // Material's tag is present but blank (the model correctly had nothing
        // to say); Place's tag is absent entirely (the model broke format).
        // Both record "" in `extractions`, but the warning wording differs.
        let content = r#"<image_description>A bangle.</image_description>
<extraction field="Material"></extraction>"#;
        let fields = vec![vocab_field("Material"), vocab_field("Place")];
        let parsed = parse_unified_response(content, &fields);
        assert_eq!(parsed.extractions.get("Material").unwrap(), "");
        assert_eq!(parsed.extractions.get("Place").unwrap(), "");
        assert!(parsed
            .warnings
            .iter()
            .any(|w| w.contains("Material: <extraction> empty") && !w.contains("missing")));
        assert!(parsed
            .warnings
            .iter()
            .any(|w| w.contains("Place: <extraction> missing") && !w.contains("empty")));
    }

    #[test]
    fn parse_unified_warns_empty_distinct_from_missing_open_field() {
        // Same distinction for the <open_field> path.
        let content = r#"<image_description>A bangle.</image_description>
<open_field field="Physical Description"></open_field>"#;
        let fields = vec![
            open_field("Physical Description"),
            open_field("Date/Period"),
        ];
        let parsed = parse_unified_response(content, &fields);
        assert_eq!(parsed.open_values.get("Physical Description").unwrap(), "");
        assert_eq!(parsed.open_values.get("Date/Period").unwrap(), "");
        assert!(parsed
            .warnings
            .iter()
            .any(|w| w.contains("Physical Description: <open_field> empty")
                && !w.contains("missing")));
        assert!(parsed
            .warnings
            .iter()
            .any(|w| w.contains("Date/Period: <open_field> missing") && !w.contains("empty")));
    }

    #[test]
    fn parse_unified_populated_field_emits_no_warning() {
        // A populated field produces no warning; only the absent/empty ones do.
        let content = r#"<image_description>A bangle.</image_description>
<extraction field="Material">ceramic</extraction>
<open_field field="Date/Period">19th century</open_field>"#;
        let fields = vec![vocab_field("Material"), open_field("Date/Period")];
        let parsed = parse_unified_response(content, &fields);
        assert!(parsed.warnings.is_empty());
    }

    #[test]
    fn unrecognized_response_false_for_full_contract() {
        let content = r#"<image_description>A bronze bangle.</image_description>
<extraction field="Material">bronze</extraction>
<open_field field="Date/Period">14th century</open_field>"#;
        assert!(!looks_like_unrecognized_response(content));
    }

    #[test]
    fn unrecognized_response_true_for_safety_model_output() {
        // The reported case: a moderation model replying with its native
        // verdict instead of the XML contract.
        assert!(looks_like_unrecognized_response("User Safety: safe"));
    }

    #[test]
    fn unrecognized_response_true_for_empty_content() {
        assert!(looks_like_unrecognized_response(""));
    }

    #[test]
    fn unrecognized_response_false_for_partial_but_shaped() {
        // Only one tag family present — partial, but still contract-shaped.
        // These must NOT be flagged here; the per-field warnings in
        // parse_unified_response already cover them.
        let content = r#"<extraction field="Material">bronze</extraction>"#;
        assert!(!looks_like_unrecognized_response(content));
    }

    #[test]
    fn parse_unified_handles_multiline_values_with_special_chars() {
        // Newlines, quotes, ampersands in an extraction value — the tag-walker
        // reads raw inner text between the tags, so these pass through as-is.
        let content = r#"<image_description>x</image_description>
<extraction field="Material">Line one
Line two with "quotes" & ampersand</extraction>"#;
        let fields = vec![vocab_field("Material")];
        let parsed = parse_unified_response(content, &fields);
        let material = parsed.extractions.get("Material").unwrap();
        assert!(material.contains("Line one"));
        assert!(material.contains("Line two"));
        assert!(material.contains("ampersand"));
    }

    #[test]
    fn parse_unified_is_case_insensitive_on_field_attr() {
        let content = r#"<extraction FIELD="Material">bronze</extraction>"#;
        let fields = vec![vocab_field("Material")];
        let parsed = parse_unified_response(content, &fields);
        assert_eq!(parsed.extractions.get("Material").unwrap(), "bronze");
    }

    #[test]
    fn parse_validation_drops_hallucinated_terms() {
        let content = r#"<validated field="Material">
<pick term="bronze" />
<pick term="unobtainium" />
</validated>"#;
        let mut candidates = HashMap::new();
        candidates.insert(
            "material".to_string(),
            vec!["bronze".to_string(), "iron".to_string()],
        );
        let (picks, warnings) = parse_validation_response(content, &candidates);
        let kept = picks.get("material").unwrap();
        assert_eq!(kept, &vec!["bronze".to_string()]);
        assert!(warnings
            .iter()
            .any(|w| w.contains("unobtainium") && w.contains("hallucinated")));
    }

    #[test]
    fn parse_validation_case_insensitive_term_match() {
        let content = r#"<validated field="Shape"><pick term="CIRCULAR" /></validated>"#;
        let mut candidates = HashMap::new();
        candidates.insert("shape".to_string(), vec!["circular".to_string()]);
        let (picks, warnings) = parse_validation_response(content, &candidates);
        // Original casing from the candidate list is preserved.
        assert_eq!(picks.get("shape").unwrap(), &vec!["circular".to_string()]);
        assert!(warnings.is_empty());
    }

    #[test]
    fn parse_validation_empty_block_means_no_match() {
        let content = r#"<validated field="Material"></validated>"#;
        let mut candidates = HashMap::new();
        candidates.insert("material".to_string(), vec!["bronze".to_string()]);
        let (picks, warnings) = parse_validation_response(content, &candidates);
        assert!(picks.get("material").unwrap().is_empty());
        assert!(warnings.is_empty()); // empty block is an explicit "none fit", not an error
    }

    #[test]
    fn parse_validation_tolerates_non_self_closing_pick() {
        let content = r#"<validated field="Material"><pick term="bronze"></pick></validated>"#;
        let mut candidates = HashMap::new();
        candidates.insert("material".to_string(), vec!["bronze".to_string()]);
        let (picks, _warnings) = parse_validation_response(content, &candidates);
        assert_eq!(picks.get("material").unwrap(), &vec!["bronze".to_string()]);
    }

    fn column(name: &str, prompt: &str) -> ArtefactColumnSpec {
        ArtefactColumnSpec {
            name: name.to_string(),
            prompt: prompt.to_string(),
        }
    }

    #[test]
    fn unified_prompt_omits_empty_prompt_columns_and_includes_record_xml() {
        let record = json!({ "Object Name": "Kris", "Material": "Iron" });
        let columns = vec![
            column("Object Name", ""),
            column("Material", "Use to confirm the primary material."),
        ];
        let fields = vec![vocab_field("Material")];
        let prompt = build_unified_prompt(
            "You are a museum cataloguer.",
            &columns,
            &fields,
            &record,
            true,
        );
        // The guided column's prompt line is present.
        assert!(prompt.contains("- Material: Use to confirm the primary material."));
        // The empty-prompt column is NOT listed as a guidance line.
        assert!(!prompt.contains("- Object Name:"));
        // The record is now XML, not the old JSON blob.
        assert!(prompt.contains("<artefact_file>"));
        assert!(prompt.contains("<Material>Iron</Material>"));
        assert!(prompt.contains("You are a museum cataloguer."));
        // Has an image, so the no-image framing note must NOT appear.
        assert!(!prompt.contains("No image is attached"));
    }

    #[test]
    fn unified_prompt_adds_no_image_note_when_image_absent() {
        let prompt = build_unified_prompt("instr", &[], &[], &json!({}), false);
        assert!(prompt.contains("No image is attached"));
        assert!(prompt.contains("lower-confidence"));
    }

    #[test]
    fn unified_prompt_appends_field_enumeration_with_inline_prompt() {
        let fields = vec![
            FieldSpec {
                name: "Date/Period".to_string(),
                field_type: "open".to_string(),
                prompt: "Translate into CE date format.".to_string(),
                vocab_source_ids: Vec::new(),
            },
            vocab_field("Material"),
        ];
        let prompt = build_unified_prompt("", &[], &fields, &json!({}), true);
        // Vocab fields emit <extraction>, open fields emit <open_field>.
        assert!(prompt.contains("<extraction field=\"Material\">"));
        assert!(prompt.contains("<open_field field=\"Date/Period\">"));
        // A non-empty field prompt is injected inline.
        assert!(prompt.contains("Translate into CE date format."));
    }

    #[test]
    fn unified_prompt_enumeration_leads_with_image_description() {
        // The concrete field enumeration — the list the model actually follows —
        // must lead with <image_description>, otherwise the tag is dropped from
        // every response. It must appear before the first per-field tag.
        let fields = vec![vocab_field("Material"), open_field("Date/Period")];
        let prompt = build_unified_prompt("", &[], &fields, &json!({}), true);
        let desc = prompt
            .find("<image_description>")
            .expect("enumeration must include <image_description>");
        let first_field = prompt
            .find("<extraction field=\"Material\">")
            .expect("field enumeration present");
        assert!(
            desc < first_field,
            "<image_description> must precede the first per-field tag"
        );
    }

    #[test]
    fn unified_prompt_field_enumeration_preserves_config_order() {
        let fields = vec![
            vocab_field("Material"),
            open_field("Description"),
            vocab_field("Shape"),
        ];
        let prompt = build_unified_prompt("", &[], &fields, &json!({}), true);
        let mat = prompt.find("<extraction field=\"Material\">").unwrap();
        let desc = prompt.find("<open_field field=\"Description\">").unwrap();
        let shape = prompt.find("<extraction field=\"Shape\">").unwrap();
        assert!(mat < desc && desc < shape);
    }

    #[test]
    fn xml_escape_attr_escapes_quotes_and_metacharacters() {
        // Element-content escapes (`& < >`) plus the two quote types an
        // attribute value requires. Normal text passes through untouched.
        assert_eq!(xml_escape_attr("normal"), "normal");
        assert_eq!(xml_escape_attr("a & b"), "a &amp; b");
        assert_eq!(xml_escape_attr("a < b > c"), "a &lt; b &gt; c");
        assert_eq!(xml_escape_attr(r#"say "hi""#), "say &quot;hi&quot;");
        assert_eq!(xml_escape_attr("it's"), "it&apos;s");
    }

    #[test]
    fn field_name_with_double_quote_cannot_break_out_of_attribute() {
        // A field name containing `"` must be escaped so it can't terminate
        // the `field="…"` attribute and inject a spurious tag into the
        // enumeration (prompt-structure corruption).
        let fields = vec![vocab_field(r#"Material"/>evil"#)];
        let prompt = build_unified_prompt("", &[], &fields, &json!({}), true);
        // The `"` in the name is escaped to &quot; inside the attribute.
        assert!(
            prompt.contains(r#"<extraction field="Material&quot;/&gt;evil">"#),
            "field name should be attribute-escaped, got: {prompt}"
        );
        // No early self-close + injected tag — the break-out sequence `"/>`
        // from the raw name must NOT appear verbatim.
        assert!(
            !prompt.contains(r#"Material"/>"#),
            "raw double-quote break-out leaked into prompt: {prompt}"
        );
        // Exactly one <extraction> line (no injected second tag).
        assert_eq!(
            prompt.matches("<extraction ").count(),
            1,
            "expected exactly one extraction tag, got: {prompt}"
        );
    }

    #[test]
    fn open_field_name_with_double_quote_cannot_break_out_of_attribute() {
        // Same guard for the <open_field> path.
        let fields = vec![open_field(r#"Date"/>x"#)];
        let prompt = build_unified_prompt("", &[], &fields, &json!({}), true);
        assert!(prompt.contains(r#"<open_field field="Date&quot;/&gt;x">"#));
        assert!(!prompt.contains(r#"Date"/>"#));
        assert_eq!(prompt.matches("<open_field ").count(), 1);
    }

    #[test]
    fn record_xml_sanitizes_column_names() {
        // Column names with spaces/punctuation/apostrophes → valid XML tags.
        let record = json!({
            "Object Name": "Bowl",
            "Curator's notes": "rare",
            "Date/Period": "Tang",
            "ID": "ID-VAL"
        });
        let xml = record_xml(&record);
        assert!(xml.contains("<artefact_file>"));
        // Every configured column reaches the model verbatim — including
        // ID-named columns (the old name-based filter was removed because the
        // parser is config-strict and silently dropping a user-configured
        // column was a bug).
        assert!(xml.contains(">ID-VAL<"));
        assert!(xml.contains(">Bowl<"));
        assert!(xml.contains(">rare<"));
        assert!(xml.contains(">Tang<"));
        // No raw space/apostrophe/slash inside a tag name (tags only contain
        // valid XML name chars).
        for tag in ["Object Name", "Curator's notes", "Date/Period"] {
            assert!(
                !xml.contains(&format!("<{tag}>")),
                "unsanitized tag leaked: {tag}"
            );
        }
    }

    #[test]
    fn record_xml_dedupes_collision() {
        // "A-B" and "A B" both sanitize toward "A_B" — the second gets a suffix
        // so neither value is lost.
        let record = json!({ "A-B": "first", "A B": "second" });
        let xml = record_xml(&record);
        assert!(xml.contains(">first<"));
        assert!(xml.contains(">second<"));
    }

    #[test]
    fn build_validation_prompt_lists_pure_terms_no_scores() {
        let fields = [vocab_field("Material")];
        let candidates = vec![
            NetCandidate {
                term: "bronze".to_string(),
                score: 0.9,
            },
            NetCandidate {
                term: "iron".to_string(),
                score: 0.7,
            },
        ];
        let extracted = "bronze, patinated";
        let refs: Vec<(usize, &FieldSpec, &str, &[NetCandidate])> =
            vec![(0, &fields[0], extracted, &candidates)];
        let prompt = build_validation_prompt(&refs, 3);
        // Terms present.
        assert!(prompt.contains("- bronze"));
        assert!(prompt.contains("- iron"));
        // Scores and thesaurus badges are NOT present (pure terms only).
        assert!(!prompt.contains("0.9"));
        assert!(!prompt.contains("[NHB]"));
        // The fixed XML reply contract is present.
        assert!(prompt.contains("<validated field="));
        assert!(prompt.contains("VERBATIM"));
    }

    #[test]
    fn build_validation_prompt_injects_field_guidance() {
        let fields = [FieldSpec {
            name: "Obj./Work type".to_string(),
            field_type: "vocab".to_string(),
            prompt: "Prefer the broadest applicable type.".to_string(),
            vocab_source_ids: Vec::new(),
        }];
        let candidates = vec![NetCandidate {
            term: "bowl".to_string(),
            score: 0.8,
        }];
        let refs: Vec<(usize, &FieldSpec, &str, &[NetCandidate])> =
            vec![(0, &fields[0], "a vessel", &candidates)];
        let prompt = build_validation_prompt(&refs, 3);
        assert!(prompt.contains("Prefer the broadest applicable type."));
    }

    #[test]
    fn trim_for_validation_drops_open_field_keeps_description_and_extractions() {
        let content1 = r#"<image_description>A bowl.</image_description>
<extraction field="Material">bronze</extraction>
<open_field field="Date/Period">8th c.</open_field>"#;
        let trimmed = trim_for_validation(content1);
        assert!(trimmed.contains("<image_description>A bowl.</image_description>"));
        assert!(trimmed.contains("<extraction field=\"Material\">bronze</extraction>"));
        // Open-field answers are irrelevant to validation and must be dropped.
        assert!(!trimmed.contains("8th c."));
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
