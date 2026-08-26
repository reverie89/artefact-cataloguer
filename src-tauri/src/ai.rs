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
//!
//! Layout: [`types`] holds the shared domain/provider payload types,
//! [`transport`] the HTTP client envelope, [`logging`] the Logs Viewer
//! redaction + stage events, [`prompt`] prompt construction, [`completion`]
//! the chat-completions round trip, [`response`] the LLM XML-contract parsers.
//! The Tauri commands, cancellation state, and this module's docs stay here as
//! the facade over them.

mod completion;
mod logging;
mod prompt;
mod response;
mod transport;
mod types;

use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, State};
use tokio::sync::oneshot;

// Items consumed by sibling modules (`embeddings`, `lib.rs`) are re-exported
// here so external paths like `crate::ai::http_client` stay valid.
pub(crate) use completion::ImageData;
pub(crate) use transport::{http_client, strip_models_prefix, trim_trailing_slash};
pub use types::{
    ApiFormat, ArtefactColumnSpec, ArtefactInput, CatalogueResult, ConnectionTest, FieldSpec,
    Provider, Suggestion,
};
pub(crate) use types::{NetCandidate, ResolvedVocab};

use completion::{do_completion, Turn, TurnRole};
use logging::{log_stage, PipelineStageEvent, VerbosePayload};
use prompt::{build_unified_prompt, build_validation_prompt};
use response::{
    extract_tag_block, looks_like_unrecognized_response, parse_unified_response,
    parse_validation_response, strip_code_fence,
};

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
}
