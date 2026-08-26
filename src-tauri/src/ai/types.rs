//! Shared domain + provider-payload types for the AI module: the API-family
//! selector (with its per-format auth/endpoint knowledge), the provider/field/
//! artefact input records deserialized from the renderer, and the result
//! payload shapes returned to it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    pub(crate) fn auth(&self, api_key: &str) -> Vec<(&'static str, String)> {
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
    pub(crate) fn endpoints(&self, base: &str) -> (String, String) {
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

#[cfg(test)]
pub(crate) mod fixtures {
    use super::{ArtefactColumnSpec, FieldSpec};

    pub(crate) fn open_field(name: &str) -> FieldSpec {
        FieldSpec {
            name: name.to_string(),
            field_type: "open".to_string(),
            prompt: String::new(),
            vocab_source_ids: Vec::new(),
        }
    }

    pub(crate) fn vocab_field(name: &str) -> FieldSpec {
        FieldSpec {
            name: name.to_string(),
            field_type: "vocab".to_string(),
            prompt: String::new(),
            vocab_source_ids: Vec::new(),
        }
    }

    pub(crate) fn column(name: &str, prompt: &str) -> ArtefactColumnSpec {
        ArtefactColumnSpec {
            name: name.to_string(),
            prompt: prompt.to_string(),
        }
    }
}
