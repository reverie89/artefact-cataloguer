//! Cataloguing via the active AI provider, run from Rust so API keys never
//! reach the renderer and CORS is a non-issue.
//!
//! `catalogue_artefact` catalogues one artefact in a **three-step XML pipeline**
//! (validation optional, user-toggleable):
//!
//!   - **Artefact analysis (unified prompt)** — image + the artefact record as
//!     `<artefact_file>` XML + the persona/output-format preamble. The model
//!     replies in a fixed XML contract: one `<image_description>`, one
//!     `<extraction field="…">` per controlled-vocab field (field-specific text
//!     used to search that field's vocab source), and one `<open_field
//!     field="…">` per open-ended field (the free-text answer, used directly).
//!   - **Partition (validation on, multi-component fields)** — one focused
//!     vision call names each field's distinct components under per-field
//!     component definitions (substances for Material, silhouettes for Shape,
//!     …) so a field can't be split by part. Quota-free: the prompt never
//!     carries `max_components`; the artefact record is included because a
//!     cataloguer reads the row's metadata first. Failure falls back to
//!     splitting the field's extraction on semicolons.
//!   - **Embedding step** — every component text is embedded in one batched
//!     call and searched against its field's LanceDB source(s) alongside the
//!     artefact image; per component, hits fuse by max cosine and the top
//!     `shortlist_count` become that component's candidate group. Per-component
//!     embedding is the structural fix for the flat near-duplicate pile the
//!     previous single-vector search produced.
//!   - **Validation (threaded from artefact analysis, optional)** — one
//!     batched call presenting every component group's candidate **terms**
//!     (no scores, no vectors). The vision model picks at most one term per
//!     group, verbatim, and may skip groups that don't fit or duplicate
//!     another. Rust then collapses same-kind picks (a variety of another
//!     picked term — `oak (wood)` beside `wood (plant material)` — is dropped,
//!     logged), cuts each field's picks to its `max_components` best by
//!     cosine (logged), and a ≥`NEAR_DUP_THRESHOLD` embedding gate merges
//!     near-synonym picks (logged). When validation is disabled, each group's
//!     top cosine candidate is the pick, then the same collapse + cut + gate.
//!
//! Open-ended fields are filled directly from artefact analysis (`similarity`
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

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Runtime, State};
use tokio::sync::oneshot;

// Items consumed by sibling modules (`embeddings`, `lib.rs`) are re-exported
// here so external paths like `crate::ai::http_client` stay valid.
pub(crate) use completion::ImageData;
pub(crate) use transport::{
    embeddings_root, fetch_advertised_embedding_models, fetch_advertised_models, http_client,
    response_text_checked, trim_trailing_slash,
};
pub use types::{
    ApiFormat, ArtefactColumnSpec, ArtefactInput, CatalogueResult, ConnectionTest, FieldSpec,
    Provider, Suggestion,
};
pub(crate) use types::{ComponentNet, NetCandidate, ResolvedVocab};

use completion::{do_completion, Turn, TurnRole};
use logging::{emit_catalogue_progress, log_stage, PipelineStageEvent, VerbosePayload};
use prompt::{build_partition_prompt, build_unified_prompt, build_validation_prompt};
use response::{
    extract_tag_block, looks_like_unrecognized_response, parse_partition_response,
    parse_unified_response, parse_validation_response, strip_code_fence,
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
/// "u-shape" for a circular object), this embeds **each distinct component**
/// text in one batched call and searches that field's LanceDB tables with it.
/// Results across sources/modalities are fused by **max cosine similarity**,
/// and the top `shortlist_count` candidates per component become its candidate
/// group. No thesaurus tiebreak — candidate ranking is the embedding's alone,
/// and final selection is validation's (then the post-validation cap + gate).
///
/// Component sources: the judge's partition (`components`) when it produced a
/// list for the field, else the field's `<extraction>` split on semicolons
/// (`split_components`; single-component fields never split). Near-identical
/// components (mutual cosine ≥ `NEAR_DUP_THRESHOLD`) are merged before
/// searching, first kept. Best-effort on the *search* leg (a missing LanceDB
/// table leaves the field with an empty group, surfaced as "no match"), but
/// the two embedding calls are hard failures: a failed `embed_texts` aborts
/// the whole row (no candidates possible), and — since embedding providers
/// must be multimodal — a failed `embed_image_with_retry` also aborts the row
/// rather than silently degrading to text-only. A field with no usable
/// components yields no groups and warns downstream.
async fn resolve_vocab_fields(
    embedding_provider: &crate::embeddings::EmbeddingProvider,
    fields: &[FieldSpec],
    components: &HashMap<String, Vec<String>>,
    extractions: &HashMap<String, String>,
    image: Option<&ImageData>,
    net_count: usize,
    shortlist_count: usize,
) -> Result<(Vec<ResolvedVocab>, Vec<String>), String> {
    let mut warnings: Vec<String> = Vec::new();
    let mut out: Vec<ResolvedVocab> = Vec::new();
    // Collect the per-field component texts to embed in ONE batched call.
    // (i, field, components) for vocab fields with sources; fields with no
    // usable components record empty groups so they surface as "no match".
    let to_embed: Vec<(usize, &FieldSpec, Vec<String>)> = fields
        .iter()
        .enumerate()
        .filter(|(_, f)| f.field_type == "vocab" && !f.vocab_source_ids.is_empty())
        .filter_map(|(i, f)| {
            let comps = match components.get(&f.name) {
                Some(list) if !list.is_empty() => list.clone(),
                _ => {
                    let extraction = extractions.get(&f.name).cloned().unwrap_or_default();
                    split_components(f, &extraction)
                }
            };
            let comps: Vec<String> = comps.into_iter().filter(|c| !c.trim().is_empty()).collect();
            if comps.is_empty() {
                out.push(ResolvedVocab {
                    field_index: i,
                    groups: Vec::new(),
                });
                None
            } else {
                Some((i, f, comps))
            }
        })
        .collect();
    if to_embed.is_empty() {
        return Ok((out, warnings));
    }

    // One batched embedding of all component texts. A failure here means no
    // vocab candidates are possible — propagate as a hard row failure.
    let texts: Vec<String> = to_embed
        .iter()
        .flat_map(|(_, _, c)| c.iter().cloned())
        .collect();
    let text_vectors = crate::embeddings::embed_texts(embedding_provider, &texts)
        .await
        .map_err(|e| format!("per-component embedding failed: {e}"))?;
    if text_vectors.is_empty() {
        return Err("per-component embedding returned no vectors".to_string());
    }

    // Image embedding is mandatory when an image is present (providers are
    // multimodal). A network error is retried once inside the helper; any
    // remaining failure hard-fails this row so the user sees the problem
    // instead of silently getting text-only retrieval.
    let image_vector = match image {
        Some(img) => Some(
            crate::embeddings::embed_image_with_retry(embedding_provider, img)
                .await
                .map_err(|e| {
                    format!(
                        "image embedding failed: {} — the active embedding model must accept \
                         image input; pick a multimodal embedding model",
                        e.message()
                    )
                })?,
        ),
        None => None,
    };

    // Walk the flattened component vectors in embedding order, merging
    // near-identical components (first kept) and searching each survivor.
    let mut group_lists: Vec<Vec<ComponentNet>> = to_embed
        .iter()
        .map(|(_, _, comps)| Vec::with_capacity(comps.len()))
        .collect();
    let mut flat = 0usize;
    for (ti, (_, field, comps)) in to_embed.iter().enumerate() {
        // Embedding-space merge: two judge components that are the same text
        // in vector space are one component; keep the first.
        let mut kept: Vec<(usize, &[f32])> = Vec::new();
        for (ci, vector) in text_vectors.iter().skip(flat).take(comps.len()).enumerate() {
            if kept
                .iter()
                .any(|(_, kv)| cosine_sim(kv, vector) >= NEAR_DUP_THRESHOLD)
            {
                warnings.push(format!(
                    "{}: merged near-identical component \"{}\" into an earlier one",
                    field.name, comps[ci]
                ));
                continue;
            }
            kept.push((ci, vector));
        }
        for (ci, vector) in &kept {
            // Fused best cosine per candidate, keyed by lowercased term so the
            // same term surfacing from multiple sources/modalities merges at
            // its highest score.
            let mut fused: HashMap<String, NetCandidate> = HashMap::new();
            for source_id in &field.vocab_source_ids {
                if let Ok(hits) =
                    crate::embeddings::search_similar(source_id, vector, net_count).await
                {
                    fuse_by_max_cosine(&mut fused, &hits);
                }
                if let Some(iv) = &image_vector {
                    if let Ok(hits) =
                        crate::embeddings::search_similar(source_id, iv, net_count).await
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
            ranked.truncate(shortlist_count);
            group_lists[ti].push(ComponentNet {
                extraction: comps[*ci].clone(),
                candidates: ranked,
            });
        }
        flat += comps.len();
    }
    for ((i, _, _), groups) in to_embed.iter().zip(group_lists) {
        out.push(ResolvedVocab {
            field_index: *i,
            groups,
        });
    }
    Ok((out, warnings))
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
                vector: hit.vector.clone(),
            });
    }
}

/// The catalogue pipeline's stage sequence for one run, in execution order —
/// each predicate copied verbatim from the corresponding gate in
/// `catalogue_artefact` (partition: the `validation_enabled && !multi_specs`
/// block; retrieval: the `has_vocab` + provider match; validation: the
/// validation block, which additionally requires a non-empty candidate set at
/// runtime — the one case where the last stage can be skipped and the counter
/// stops one short while the row completes). Drives the `n/m` stage counter
/// the renderer shows beside the row's processing dot.
fn stage_plan(
    fields: &[FieldSpec],
    has_embedding: bool,
    validation_enabled: bool,
) -> Vec<&'static str> {
    let has_vocab = fields
        .iter()
        .any(|f| f.field_type == "vocab" && !f.vocab_source_ids.is_empty());
    let has_multi = fields
        .iter()
        .any(|f| f.field_type == "vocab" && f.max_components != 1);
    let mut stages = vec!["analysis"];
    if validation_enabled && has_multi {
        stages.push("partition");
    }
    if has_vocab && has_embedding {
        stages.push("retrieval");
    }
    if validation_enabled && has_vocab && has_embedding {
        stages.push("validation");
    }
    stages
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn catalogue_artefact<R: Runtime>(
    app: AppHandle<R>,
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
    // Stop/Cancel works the same whether a row is mid-artefact-analysis,
    // mid-embed, or mid-validation. Dropping the future on cancel aborts its
    // in-flight reqwest request (the client closes the connection on drop).
    //
    // Four steps feed one result:
    //   - Artefact analysis: XML description + per-vocab-field <extraction> +
    //     per-open-field <open_field>.
    //   - Partition (optional): the judge names each multi-component field's
    //     distinct components; fallback = the extraction split on semicolons.
    //   - Embedding: each component text → its own candidate group (cosine).
    //   - Validation (optional, threaded): vision picks ≤1 term per group;
    //     then the same-kind collapse, the max_components cut, and the
    //     near-duplicate gate. When off, each group's top cosine is the pick,
    //     then the same collapse + cut + gate.
    let app_for_pipeline = app.clone();
    let total_steps = stage_plan(&fields, embedding_provider.is_some(), validation_enabled).len();
    let job_id_for_events = job_id.clone();
    let pipeline = async move {
        let mut step = 1usize;
        emit_catalogue_progress(&app_for_pipeline, &job_id_for_events, step, total_steps);
        // --- Artefact analysis: unified prompt (image attached here, once) ---
        // Reused verbatim as the first turn of the validation thread so the
        // model keeps the image, the persona, and the <artefact_file> record
        // in context while validating candidates.
        let unified_prompt = build_unified_prompt(
            &artefact.artefact_analysis_system_prompt,
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
        let (content1, _analysis_group) = do_completion(
            &app_for_pipeline,
            &provider,
            "Artefact Analysis",
            &job_id_for_events,
            &turns1,
        )
        .await?;

        let parsed = parse_unified_response(&content1, &fields);

        // Fail loudly when artefact analysis ignored the contract entirely. A 200
        // with no <image_description>/<extraction>/<open_field> is the signature
        // of a wrong model (free-router landing on a moderation model like
        // "User Safety: safe", or a non-instruct model). Surfacing it as a hard,
        // named error beats silent empty fields + vague per-field warnings, and
        // lets the renderer's fail-fast path stop the run instead of dragging
        // every remaining row through it.
        if looks_like_unrecognized_response(&content1) {
            return Err(format!(
                "Artefact analysis returned an unrecognized response (no XML tags). \
                 The configured model {:?} may not be vision- or instruction-capable — \
                 check the active provider's model (avoid free/auto routers and \
                 moderation models). Response was: {:?}",
                provider.model,
                content1.chars().take(200).collect::<String>()
            ));
        }

        // --- Partition (validation on, multi-component fields) ---
        // One focused vision call names each multi-component field's distinct
        // components. Quota-free by construction: the prompt builder never
        // sees `max_components`, so the model can't pad to a number it wasn't
        // shown — the post-validation cut enforces the cap instead. Any
        // failure (or a field the judge didn't answer) falls back to the
        // extraction's semicolon split, with a warning for traceability.
        let multi_specs: Vec<FieldSpec> = fields
            .iter()
            .filter(|f| f.field_type == "vocab" && f.max_components != 1)
            .cloned()
            .collect();
        let mut components_by_field: HashMap<String, Vec<String>> = HashMap::new();
        let mut partition_warnings: Vec<String> = Vec::new();
        if validation_enabled && !multi_specs.is_empty() {
            step += 1;
            emit_catalogue_progress(&app_for_pipeline, &job_id_for_events, step, total_steps);
            let partition_prompt = build_partition_prompt(&multi_specs, &artefact.record);
            let turns2 = vec![Turn {
                role: TurnRole::User,
                text: partition_prompt,
                image: image.clone(),
            }];
            match do_completion(
                &app_for_pipeline,
                &provider,
                "Component Partition",
                &job_id_for_events,
                &turns2,
            )
            .await
            {
                Ok((partition_content, _partition_group)) => {
                    let (comps, mut warns) =
                        parse_partition_response(&partition_content, &multi_specs);
                    partition_warnings.append(&mut warns);
                    components_by_field = comps;
                }
                Err(e) => partition_warnings.push(format!(
                    "Component partition failed: {e} — falling back to the extraction split"
                )),
            }
        }

        // --- Embedding: per-component text → candidate group ---
        // Only when there's at least one vocab field with a usable source AND an
        // embedding provider. Otherwise validation is pointless and is skipped.
        let has_vocab = fields
            .iter()
            .any(|f| f.field_type == "vocab" && !f.vocab_source_ids.is_empty());
        let (resolved_vocab, resolve_warnings): (Vec<ResolvedVocab>, Vec<String>) = if has_vocab {
            match embedding_provider.as_ref() {
                Some(ep) => {
                    step += 1;
                    emit_catalogue_progress(
                        &app_for_pipeline,
                        &job_id_for_events,
                        step,
                        total_steps,
                    );
                    resolve_vocab_fields(
                        ep,
                        &fields,
                        &components_by_field,
                        &parsed.extractions,
                        image.as_ref(),
                        net_count,
                        shortlist_count,
                    )
                    .await?
                }
                None => (Vec::new(), Vec::new()),
            }
        } else {
            (Vec::new(), Vec::new())
        };

        // --- Validation (optional), threaded & trimmed from artefact analysis ---
        // The assistant turn replays a TRIMMED artefact-analysis answer:
        // image_description + extractions only. The <open_field> answers are
        // irrelevant to vocab validation and would only add tokens. The image
        // is re-sent via the replayed artefact-analysis user turn because
        // vision-grounded disambiguation is validation's purpose; this is the
        // bulk of the token cost and is a deliberate, one-line-reversible
        // decision.
        let mut vocab_suggestions: HashMap<String, Vec<Suggestion>> = HashMap::new();
        let mut vocab_warnings: Vec<String> = Vec::new();
        if validation_enabled && has_vocab && !resolved_vocab.is_empty() {
            // Build the per-field group references for the prompt. No cap
            // here: the perceiver sees every component group the judge (or
            // the fallback split) produced — the max_components cut applies
            // to its validated picks afterwards.
            let shortlist_refs: Vec<(usize, &FieldSpec, &str, &[ComponentNet])> = resolved_vocab
                .iter()
                .filter_map(|rv| {
                    let field = fields.get(rv.field_index)?;
                    let extracted = parsed
                        .extractions
                        .get(&field.name)
                        .map(String::as_str)
                        .unwrap_or("");
                    Some((rv.field_index, field, extracted, rv.groups.as_slice()))
                })
                .collect();
            if !shortlist_refs.is_empty() {
                step += 1;
                emit_catalogue_progress(&app_for_pipeline, &job_id_for_events, step, total_steps);
                let validation_prompt = build_validation_prompt(&shortlist_refs);
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
                let (validation_content, _validation_group) = do_completion(
                    &app_for_pipeline,
                    &provider,
                    "Vocab Validation",
                    &job_id_for_events,
                    &turns3,
                )
                .await?;

                // Map field name (lowercased) → candidate terms, for the
                // hallucination guard in the parser.
                let mut field_candidates: HashMap<String, Vec<String>> = HashMap::new();
                for (_, field, _, groups) in &shortlist_refs {
                    field_candidates.insert(
                        field.name.to_ascii_lowercase(),
                        groups
                            .iter()
                            .flat_map(|g| g.candidates.iter().map(|c| c.term.clone()))
                            .collect(),
                    );
                }
                let (picks_by_field, mut pick_warnings) =
                    parse_validation_response(&validation_content, &field_candidates);
                vocab_warnings.append(&mut pick_warnings);

                // Map each pick to its component group (the first group
                // containing the term; a term surfacing in two groups can
                // only be picked once), one winner per group — the higher
                // cosine wins when the model picks twice from one group.
                // Then the post-validation cut (`max_components`, logged) and
                // the near-duplicate gate (logged) produce the record.
                for rv in &resolved_vocab {
                    let Some(field) = fields.get(rv.field_index) else {
                        continue;
                    };
                    let picks = picks_by_field
                        .get(&field.name.to_ascii_lowercase())
                        .cloned()
                        .unwrap_or_default();
                    let winners = assign_group_winners(&rv.groups, &picks);
                    // Winner term → the kind (group phrase) it was assigned to.
                    let winner_kinds: HashMap<String, String> = winners
                        .iter()
                        .enumerate()
                        .filter_map(|(gi, w)| {
                            w.as_ref().map(|c| {
                                (
                                    c.term.to_ascii_lowercase(),
                                    rv.groups[gi].extraction.clone(),
                                )
                            })
                        })
                        .collect();
                    let picked: Vec<NetCandidate> = winners.iter().flatten().cloned().collect();
                    let (mut picked, fold) =
                        merge_kind_specializations(picked, &field.name, &mut vocab_warnings);
                    picked = cap_validated_picks(
                        picked,
                        field.max_components,
                        &field.name,
                        &mut vocab_warnings,
                    );
                    picked = dedupe_near_duplicates(picked, &field.name, &mut vocab_warnings);
                    // Kinds shown = kinds recorded (see `resolved_group_kinds`).
                    let recorded: HashSet<String> =
                        picked.iter().map(|c| c.term.to_ascii_lowercase()).collect();
                    let group_kinds =
                        resolved_group_kinds(&winners, &rv.groups, &winner_kinds, &fold, &recorded);
                    let cand_kinds = candidate_kinds(
                        &picked,
                        &rv.groups,
                        &group_kinds,
                        &winner_kinds,
                        &recorded,
                    );
                    let sugs = suggestions_with_alternates(picked, &rv.groups, &cand_kinds);
                    if sugs.is_empty() {
                        vocab_warnings.push(format!(
                            "{}: no candidates matched after validation",
                            field.name
                        ));
                    }
                    vocab_suggestions.insert(field.name.clone(), sugs);
                }
            }
        } else if has_vocab {
            // Validation disabled: no perceiver at pick time — each group's
            // top cosine candidate is the pick, then the same post-validation
            // cut + near-duplicate gate.
            for rv in &resolved_vocab {
                if let Some(field) = fields.get(rv.field_index) {
                    // Winner term → the kind (group phrase) it was assigned to.
                    let winners: Vec<Option<NetCandidate>> = rv
                        .groups
                        .iter()
                        .map(|g| g.candidates.first().cloned())
                        .collect();
                    let winner_kinds: HashMap<String, String> = winners
                        .iter()
                        .enumerate()
                        .filter_map(|(gi, w)| {
                            w.as_ref().map(|c| {
                                (
                                    c.term.to_ascii_lowercase(),
                                    rv.groups[gi].extraction.clone(),
                                )
                            })
                        })
                        .collect();
                    let picked: Vec<NetCandidate> = winners.iter().flatten().cloned().collect();
                    let (picked, fold) =
                        merge_kind_specializations(picked, &field.name, &mut vocab_warnings);
                    let mut picked = cap_validated_picks(
                        picked,
                        field.max_components,
                        &field.name,
                        &mut vocab_warnings,
                    );
                    picked = dedupe_near_duplicates(picked, &field.name, &mut vocab_warnings);
                    // Same kinds-shown-equals-kinds-recorded rule as the
                    // validation branch above.
                    let recorded: HashSet<String> =
                        picked.iter().map(|c| c.term.to_ascii_lowercase()).collect();
                    let group_kinds =
                        resolved_group_kinds(&winners, &rv.groups, &winner_kinds, &fold, &recorded);
                    let cand_kinds = candidate_kinds(
                        &picked,
                        &rv.groups,
                        &group_kinds,
                        &winner_kinds,
                        &recorded,
                    );
                    let sugs = suggestions_with_alternates(picked, &rv.groups, &cand_kinds);
                    vocab_suggestions.insert(field.name.clone(), sugs);
                }
            }
        }

        let mut all_warnings = parsed.warnings.clone();
        all_warnings.extend(partition_warnings);
        all_warnings.extend(resolve_warnings);
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
                        picked: true,
                        kind: None,
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
                row_id: Some(job_id.clone()),
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

/// Mutual-cosine threshold for the embedding-space merges: two components (or
/// two picked terms) at or above this are near-synonyms in the thesaurus's own
/// vector space. Conservative by design — it merges "hand weaving"/"weaving",
/// not red/crimson (that judgment belongs to the perceiver and the user's
/// per-field prompt).
const NEAR_DUP_THRESHOLD: f32 = 0.90;

/// Cosine similarity between two embeddings. Dissimilar-length or empty
/// inputs score 0.0 (never a false "duplicate").
fn cosine_sim(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let (mut dot, mut na, mut nb) = (0.0f32, 0.0f32, 0.0f32);
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom == 0.0 {
        0.0
    } else {
        dot / denom
    }
}

/// Split a vocab field's extraction into per-component retrieval texts. This
/// is the *fallback* partitioner (validation off, or the judge failed): the
/// extraction guidance asks for semicolon-separated components, so the split
/// mirrors that. Single-component fields (max_components 1) never split. A
/// text with no usable split yields the whole extraction as one component;
/// an empty extraction yields one empty component (the resolver skips it).
fn split_components(field: &FieldSpec, extraction: &str) -> Vec<String> {
    let trimmed = extraction.trim();
    if field.max_components == 1 {
        return vec![trimmed.to_string()];
    }
    let parts: Vec<String> = extraction
        .split(';')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        vec![trimmed.to_string()]
    } else {
        parts
    }
}

/// Post-validation cut: the perceiver saw every component group; this keeps
/// the field's best N validated picks by cosine (N=0 → no cap) and logs each
/// dropped pick so the cut is auditable.
fn cap_validated_picks(
    picks: Vec<NetCandidate>,
    max_components: u32,
    field_name: &str,
    warnings: &mut Vec<String>,
) -> Vec<NetCandidate> {
    if max_components == 0 || picks.len() <= max_components as usize {
        return picks;
    }
    let mut sorted = picks;
    sorted.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let dropped: Vec<String> = sorted[max_components as usize..]
        .iter()
        .map(|c| format!("\"{}\"", c.term))
        .collect();
    warnings.push(format!(
        "{field_name}: kept best {} of {} validated picks — dropped: {}",
        max_components,
        sorted.len(),
        dropped.join(", ")
    ));
    sorted.truncate(max_components as usize);
    sorted
}

/// Near-duplicate gate: greedy pass in cosine-desc order; a pick whose
/// embedding sits at ≥ `NEAR_DUP_THRESHOLD` to an already-kept pick is a
/// near-synonym in the thesaurus's own space and is dropped with a warning.
/// Picks with an empty vector (unreadable column) are always kept — the gate
/// never guesses.
fn dedupe_near_duplicates(
    picks: Vec<NetCandidate>,
    field_name: &str,
    warnings: &mut Vec<String>,
) -> Vec<NetCandidate> {
    let mut sorted = picks;
    sorted.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut kept: Vec<NetCandidate> = Vec::new();
    for cand in sorted {
        let dup = kept.iter().any(|k| {
            !k.vector.is_empty()
                && !cand.vector.is_empty()
                && cosine_sim(&k.vector, &cand.vector) >= NEAR_DUP_THRESHOLD
        });
        if dup {
            warnings.push(format!(
                "{field_name}: dropped near-duplicate pick \"{}\" (≥ {NEAR_DUP_THRESHOLD} cosine to a kept term)",
                cand.term
            ));
        } else {
            kept.push(cand);
        }
    }
    kept
}

/// Map validated picks onto the component groups they came from: each pick is
/// assigned to the group where **its cosine is highest**, not the first group
/// that merely lists the term — a low-ranked mention in an earlier group's net
/// must not starve the group where the term was the top hit (observed live: a
/// brown component's 0.61 top hit was swallowed by the black group, where the
/// same term sat at 0.34, and brown silently vanished from the record). One
/// winner per group; several picks landing in one group keep the higher
/// cosine. Greedy per pick — a pick may still displace a group's own top term
/// when it outscores it, but the verbatim-pick contract makes such
/// degenerate collisions rare, so no assignment solver (YAGNI).
fn assign_group_winners(groups: &[ComponentNet], picks: &[String]) -> Vec<Option<NetCandidate>> {
    let mut winners: Vec<Option<NetCandidate>> = vec![None; groups.len()];
    for pick in picks {
        let mut best: Option<(usize, NetCandidate)> = None;
        for (gi, g) in groups.iter().enumerate() {
            if let Some(c) = g
                .candidates
                .iter()
                .find(|c| c.term.trim().eq_ignore_ascii_case(pick.trim()))
            {
                let better = match &best {
                    Some((_, b)) => c.score > b.score,
                    None => true,
                };
                if better {
                    best = Some((gi, c.clone()));
                }
            }
        }
        if let Some((gi, c)) = best {
            match &winners[gi] {
                Some(w) if w.score >= c.score => {}
                _ => winners[gi] = Some(c),
            }
        }
    }
    winners
}

/// Same-kind collapse over the vocabulary's own parent qualifiers: a pick
/// whose parenthetical qualifier names another pick's head term is a *variety*
/// of it ("oak (wood)" beside a picked "wood (plant material)") and is dropped
/// in favour of the generic — "record at their basic level", no cosine needed.
/// Runs before the `max_components` cut so the cut counts true kinds. Picks
/// whose qualifier matches nothing picked ("black-and-white (colors)",
/// "engraving (printing process)") are untouched, as are variety groups whose
/// generic term was never picked (the collapse never invents a record entry).
/// Deterministic; each drop is logged. Returns the kept picks plus the fold
/// map (lowercased dropped term → lowercased surviving term) so the caller can
/// shade the dropped pick's whole kind group under the survivor.
fn merge_kind_specializations(
    picks: Vec<NetCandidate>,
    field_name: &str,
    warnings: &mut Vec<String>,
) -> (Vec<NetCandidate>, HashMap<String, String>) {
    // (head, Some(qualifier)) per pick, lowercased: "oak (wood)" → ("oak", "wood").
    let parsed: Vec<(String, Option<String>)> = picks
        .iter()
        .map(|c| match c.term.find(" (") {
            Some(idx) => (
                c.term[..idx].trim().to_ascii_lowercase(),
                Some(
                    c.term[idx + 2..]
                        .trim_end_matches(')')
                        .trim()
                        .to_ascii_lowercase(),
                ),
            ),
            None => (c.term.trim().to_ascii_lowercase(), None),
        })
        .collect();
    let mut kept = Vec::with_capacity(picks.len());
    let mut fold: HashMap<String, String> = HashMap::new();
    for (i, cand) in picks.iter().enumerate() {
        let generic = parsed[i].1.as_ref().and_then(|qualifier| {
            parsed
                .iter()
                .enumerate()
                .find(|(j, (head, _))| *j != i && head == qualifier)
                .map(|(j, _)| picks[j].term.clone())
        });
        match generic {
            Some(generic) => {
                fold.insert(cand.term.to_ascii_lowercase(), generic.to_ascii_lowercase());
                warnings.push(format!(
                    "{field_name}: dropped \"{}\" — a variety of picked \"{generic}\"",
                    cand.term
                ));
            }
            None => kept.push(cand.clone()),
        }
    }
    (kept, fold)
}

/// Kind phrase per component group after recording — the "kinds shown =
/// kinds recorded" rule. A group whose winner survived keeps its own phrase;
/// a group folded by the same-kind collapse shades under the survivor's kind
/// (its alternates are that kind's varieties); a group dropped by the
/// `max_components` cut or the near-duplicate gate — or with no winner — is
/// not a kind and contributes nothing. With nothing recorded at all, every
/// group keeps its own phrase: the dropdown is a pure choice list.
fn resolved_group_kinds(
    winners: &[Option<NetCandidate>],
    groups: &[ComponentNet],
    winner_kinds: &HashMap<String, String>,
    fold: &HashMap<String, String>,
    recorded: &HashSet<String>,
) -> Vec<Option<String>> {
    if recorded.is_empty() {
        return groups.iter().map(|g| Some(g.extraction.clone())).collect();
    }
    winners
        .iter()
        .map(|w| {
            let w = w.as_ref()?;
            let t = w.term.to_ascii_lowercase();
            if recorded.contains(&t) {
                return winner_kinds.get(&t).cloned();
            }
            let survivor = fold.get(&t)?;
            winner_kinds.get(survivor).cloned()
        })
        .collect()
}

/// Candidate term → kind for [`suggestions_with_alternates`]: recorded picks
/// keep their assigned kind authoritatively; non-orphan groups contribute
/// their remaining candidates; orphan groups (per [`resolved_group_kinds`])
/// contribute nothing, so no phantom kind can render.
fn candidate_kinds(
    picked: &[NetCandidate],
    groups: &[ComponentNet],
    group_kinds: &[Option<String>],
    winner_kinds: &HashMap<String, String>,
    recorded: &HashSet<String>,
) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = picked
        .iter()
        .filter_map(|c| {
            winner_kinds
                .get(&c.term.to_ascii_lowercase())
                .map(|k| (c.term.to_ascii_lowercase(), k.clone()))
        })
        .collect();
    for (g, kind) in groups.iter().zip(group_kinds) {
        let Some(kind) = kind else { continue };
        for c in &g.candidates {
            let lc = c.term.to_ascii_lowercase();
            if recorded.contains(&lc) || map.contains_key(&lc) {
                continue;
            }
            map.insert(lc, kind.clone());
        }
    }
    map
}

/// Build the field's suggestion list: the recorded picks (`picked: true`,
/// cosine-desc — the review row pre-selects them, and `sugs[0]` is always the
/// winner even when validation overrode the top cosine), then each kind's
/// remaining shortlisted candidates as swap choices (`picked: false`).
/// Alternates are bounded by the user's Vocab shortlist count — each group's
/// candidates are already truncated to it in `resolve_vocab_fields` — keep
/// their own cosine, and are deduped across groups at the max cosine. The
/// gates and the `max_components` cut keep governing the *record* only: a
/// variety dropped by the same-kind collapse still shows up as an alternate
/// choice ("wood, rattan, hardwood" on a 1-distinct-component field). Every
/// suggestion carries its kind (the group's own phrase, via the term→kind map
/// for picks, the group itself for alternates) for the dropdown's shading.
fn suggestions_with_alternates(
    picked: Vec<NetCandidate>,
    groups: &[ComponentNet],
    kinds: &HashMap<String, String>,
) -> Vec<Suggestion> {
    let mut picks: Vec<&NetCandidate> = picked.iter().collect();
    picks.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut out: Vec<Suggestion> = picks
        .iter()
        .map(|c| Suggestion {
            value: c.term.clone(),
            similarity: Some(c.score.clamp(0.0, 1.0) as f64),
            picked: true,
            kind: kinds.get(&c.term.to_ascii_lowercase()).cloned(),
        })
        .collect();
    // Alternates across all kinds, keyed case-insensitively (matching the
    // pick assignment), deduped at the max cosine, excluding recorded terms.
    // The kinds map covers only groups with a surviving recorded pick — a
    // group orphaned by the collapse, the cut, or the gate contributes no
    // candidates, so no phantom kind can render.
    let mut alternates: HashMap<String, Suggestion> = HashMap::new();
    for g in groups {
        for c in &g.candidates {
            if picked
                .iter()
                .any(|p| p.term.trim().eq_ignore_ascii_case(c.term.trim()))
            {
                continue;
            }
            let Some(kind) = kinds.get(&c.term.to_ascii_lowercase()) else {
                continue;
            };
            let score = c.score.clamp(0.0, 1.0) as f64;
            match alternates.get_mut(&c.term.to_ascii_lowercase()) {
                Some(existing) => {
                    if score > existing.similarity.unwrap_or(0.0) {
                        existing.similarity = Some(score);
                    }
                }
                None => {
                    alternates.insert(
                        c.term.to_ascii_lowercase(),
                        Suggestion {
                            value: c.term.clone(),
                            similarity: Some(score),
                            picked: false,
                            kind: Some(kind.clone()),
                        },
                    );
                }
            }
        }
    }
    let mut alternates: Vec<Suggestion> = alternates.into_values().collect();
    alternates.sort_by(|a, b| {
        b.similarity
            .unwrap_or(0.0)
            .partial_cmp(&a.similarity.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out.extend(alternates);
    out
}

/// Trim artefact analysis's XML answer down to just the parts validation needs:
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

/// Assemble the unified artefact-analysis prompt exactly as `catalogue_artefact`
/// would send it as its first user turn, without making any network call. Used
/// by the Artefact File tab's prompt preview. The row's source values are
/// produced at parse time, so the record is shown as a placeholder; the image
/// attaches as a separate content block in real runs.
#[tauri::command]
pub fn build_artefact_analysis_prompt_preview(
    columns: Vec<ArtefactColumnSpec>,
    fields: Vec<FieldSpec>,
    artefact: ArtefactInput,
) -> String {
    build_unified_prompt(
        &artefact.artefact_analysis_system_prompt,
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
    let (_completions, models_url) = provider.api_format.endpoints(&base);

    let client = http_client(Duration::from_secs(20))?;
    let auth = provider.api_format.auth(&provider.api_key);
    let models = fetch_advertised_models(
        &client,
        &models_url,
        &auth,
        provider.api_format == ApiFormat::Gemini,
        false,
    )
    .await?;

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

// Live, ignored-by-default end-to-end probe (see `ai_probe.rs`).
#[cfg(test)]
mod ai_probe;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::types::fixtures::vocab_field;

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

    /// Test pick: term + score, empty vector (the gate skips empty vectors).
    fn pick(term: &str, score: f32) -> NetCandidate {
        NetCandidate {
            term: term.to_string(),
            score,
            vector: Vec::new(),
        }
    }

    #[test]
    fn split_components_follows_the_field_mode() {
        let mut f = vocab_field("Material");
        // 1 = single: never split.
        f.max_components = 1;
        assert_eq!(
            split_components(&f, "jute body; synthetic lining"),
            vec!["jute body; synthetic lining"]
        );
        // Multi fields split on semicolons, trimming and dropping empties.
        f.max_components = 0;
        assert_eq!(
            split_components(&f, " jute body ; ; lining "),
            vec!["jute body", "lining"]
        );
        // No semicolons → the whole extraction is one component.
        assert_eq!(split_components(&f, "jute body"), vec!["jute body"]);
        // Empty extraction → one empty component (the resolver skips it).
        assert_eq!(split_components(&f, "  "), vec![""]);
    }

    #[test]
    fn cap_validated_picks_keeps_the_strongest_n_and_warns() {
        let mut warnings = Vec::new();
        let picks = vec![
            pick("a", 0.5),
            pick("b", 0.9),
            pick("c", 0.7),
            pick("d", 0.4),
        ];
        let kept = cap_validated_picks(picks, 3, "Material", &mut warnings);
        assert_eq!(
            kept.iter().map(|c| c.term.as_str()).collect::<Vec<_>>(),
            ["b", "c", "a"]
        );
        assert!(warnings
            .iter()
            .any(|w| w.contains("kept best 3 of 4") && w.contains("\"d\"")));

        // Under the cap: untouched, no warning.
        let mut warnings = Vec::new();
        let kept = cap_validated_picks(vec![pick("a", 0.5)], 3, "Material", &mut warnings);
        assert_eq!(kept.len(), 1);
        assert!(warnings.is_empty());

        // 0 = no cap.
        let mut warnings = Vec::new();
        let picks = vec![pick("a", 0.5), pick("b", 0.9)];
        let kept = cap_validated_picks(picks, 0, "Material", &mut warnings);
        assert_eq!(kept.len(), 2);
        assert!(warnings.is_empty());
    }

    #[test]
    fn near_duplicate_gate_merges_synonyms_and_keeps_distinct_picks() {
        let mut warnings = Vec::new();
        // "weaving" and "hand weaving" are near-synonyms in vector space;
        // "jute" is orthogonal to both.
        let picks = vec![
            NetCandidate {
                term: "hand weaving".to_string(),
                score: 0.8,
                vector: vec![1.0, 0.05],
            },
            NetCandidate {
                term: "weaving".to_string(),
                score: 0.9,
                vector: vec![1.0, 0.0],
            },
            NetCandidate {
                term: "jute".to_string(),
                score: 0.5,
                vector: vec![0.0, 1.0],
            },
        ];
        let kept = dedupe_near_duplicates(picks, "Technique", &mut warnings);
        assert_eq!(
            kept.iter().map(|c| c.term.as_str()).collect::<Vec<_>>(),
            ["weaving", "jute"]
        );
        assert!(warnings
            .iter()
            .any(|w| w.contains("hand weaving") && w.contains("near-duplicate")));
    }

    /// Test component group: extraction text + its shortlisted candidates.
    fn net(extraction: &str, candidates: Vec<NetCandidate>) -> ComponentNet {
        ComponentNet {
            extraction: extraction.to_string(),
            candidates,
        }
    }

    #[test]
    fn assign_group_winners_sends_each_pick_to_its_best_group() {
        // Live case: "brown (color)" is the TOP hit of the brown group (0.6065)
        // but also sits low in the black group's net (0.3356). First-group-wins
        // starved the brown group; best-group keeps both winners.
        let groups = vec![
            net(
                "black",
                vec![pick("black (color)", 0.5252), pick("brown (color)", 0.3356)],
            ),
            net(
                "brown",
                vec![pick("brown (color)", 0.6065), pick("beige (color)", 0.3185)],
            ),
        ];
        let winners = assign_group_winners(
            &groups,
            &["black (color)".to_string(), "brown (color)".to_string()],
        );
        assert_eq!(winners[0].as_ref().unwrap().term, "black (color)");
        assert_eq!(winners[0].as_ref().unwrap().score, 0.5252);
        assert_eq!(winners[1].as_ref().unwrap().term, "brown (color)");
        assert_eq!(winners[1].as_ref().unwrap().score, 0.6065);
    }

    #[test]
    fn assign_group_winners_skips_unknown_picks_and_keeps_the_higher_competitor() {
        let groups = vec![net(
            "shape",
            vec![pick("rectangular", 0.6449), pick("square (shape)", 0.4185)],
        )];
        let winners = assign_group_winners(
            &groups,
            &[
                "not-in-net".to_string(),
                "square (shape)".to_string(),
                "rectangular".to_string(),
            ],
        );
        // "rectangular" outscored "square (shape)" for the single group's slot.
        assert_eq!(winners[0].as_ref().unwrap().term, "rectangular");
    }

    #[test]
    fn assign_group_winners_without_picks_yields_all_none() {
        let groups = vec![net("a", vec![pick("x", 0.5)])];
        assert!(assign_group_winners(&groups, &[])
            .iter()
            .all(|w| w.is_none()));
    }

    #[test]
    fn merge_kind_specializations_drops_varieties_of_a_picked_generic() {
        // The live wood-varieties failure: five same-kind Material picks from
        // part-level components. Only the generic + the distinct kind survive.
        let picks = vec![
            pick("wood (plant material)", 0.609),
            pick("oak (wood)", 0.513),
            pick("olive (wood)", 0.496),
            pick("rosewood (wood)", 0.480),
            pick("pear (wood)", 0.470),
            pick("palm fiber", 0.440),
        ];
        let mut warnings = Vec::new();
        let (kept, fold) = merge_kind_specializations(picks, "Material", &mut warnings);
        assert_eq!(
            kept.iter().map(|c| c.term.as_str()).collect::<Vec<_>>(),
            ["wood (plant material)", "palm fiber"]
        );
        assert_eq!(warnings.len(), 4);
        assert!(warnings[0].contains("Material: dropped \"oak (wood)\""));
        assert!(warnings[0].contains("a variety of picked \"wood (plant material)\""));
        // The fold map drives the orphan-group re-shading: every dropped
        // variety maps to the generic it collapsed into.
        assert_eq!(fold.len(), 4);
        assert_eq!(
            fold.get("oak (wood)").map(String::as_str),
            Some("wood (plant material)")
        );
    }

    #[test]
    fn merge_kind_specializations_leaves_distinct_kinds_and_unmatched_qualifiers() {
        let picks = vec![
            pick("metal", 0.675),
            pick("wood (plant material)", 0.609),
            pick("textile materials", 0.451),
            // Qualifier "colors" matches no picked head term → untouched.
            pick("black-and-white (colors)", 0.448),
        ];
        let mut warnings = Vec::new();
        let (kept, fold) = merge_kind_specializations(picks, "Material", &mut warnings);
        assert_eq!(kept.len(), 4);
        assert!(warnings.is_empty());
        assert!(fold.is_empty());
    }

    #[test]
    fn merge_kind_specializations_needs_the_generic_picked() {
        // Varieties whose generic term was never picked stay: the collapse
        // never invents a record entry.
        let picks = vec![pick("oak (wood)", 0.513), pick("olive (wood)", 0.496)];
        let mut warnings = Vec::new();
        let (kept, fold) = merge_kind_specializations(picks, "Material", &mut warnings);
        assert_eq!(kept.len(), 2);
        assert!(warnings.is_empty());
        assert!(fold.is_empty());
    }

    #[test]
    fn suggestions_with_alternates_offer_the_shortlist_per_kind() {
        // Single-kind field (maxComponents = 1 case): the validated winner
        // comes FIRST even though an alternate carries a higher cosine
        // (validation override), then the group's remaining shortlisted
        // candidates as unpicked alternates, cosine-desc. Every suggestion
        // carries its kind for the dropdown's shading.
        let groups = vec![net(
            "wood; rattan",
            vec![
                pick("hardwood", 0.62),
                pick("wood (plant material)", 0.609),
                pick("rattan", 0.563),
                pick("oak (wood)", 0.513),
                pick("olive (wood)", 0.496),
            ],
        )];
        let kinds = HashMap::from([
            ("hardwood".to_string(), "wood; rattan".to_string()),
            (
                "wood (plant material)".to_string(),
                "wood; rattan".to_string(),
            ),
            ("rattan".to_string(), "wood; rattan".to_string()),
            ("oak (wood)".to_string(), "wood; rattan".to_string()),
            ("olive (wood)".to_string(), "wood; rattan".to_string()),
        ]);
        let sugs = suggestions_with_alternates(
            vec![pick("wood (plant material)", 0.609)],
            &groups,
            &kinds,
        );
        assert_eq!(sugs[0].value, "wood (plant material)");
        assert!(sugs[0].picked);
        assert_eq!(sugs[0].kind.as_deref(), Some("wood; rattan"));
        assert_eq!(
            sugs[1..]
                .iter()
                .map(|s| (s.value.as_str(), s.picked, s.kind.as_deref()))
                .collect::<Vec<_>>(),
            [
                ("hardwood", false, Some("wood; rattan")),
                ("rattan", false, Some("wood; rattan")),
                ("oak (wood)", false, Some("wood; rattan")),
                ("olive (wood)", false, Some("wood; rattan")),
            ]
        );
    }

    #[test]
    fn suggestions_with_alternates_mark_multi_picks_and_dedupe_cross_group() {
        // Multi-kind field: one recorded pick per kind (cosine-desc among
        // picks), and a term that surfaces in two groups' nets is neither
        // duplicated nor offered as an alternate of itself — it keeps the
        // kind it was recorded under, never an alternate group's kind.
        let groups = vec![
            net(
                "wood",
                vec![
                    pick("wood (plant material)", 0.609),
                    pick("oak (wood)", 0.513),
                ],
            ),
            net(
                "rattan",
                vec![pick("rattan", 0.563), pick("wood (plant material)", 0.336)],
            ),
        ];
        let kinds = HashMap::from([
            ("wood (plant material)".to_string(), "wood".to_string()),
            ("oak (wood)".to_string(), "wood".to_string()),
            ("rattan".to_string(), "rattan".to_string()),
        ]);
        let sugs = suggestions_with_alternates(
            vec![pick("rattan", 0.563), pick("wood (plant material)", 0.609)],
            &groups,
            &kinds,
        );
        let picked: Vec<(&str, Option<&str>)> = sugs
            .iter()
            .filter(|s| s.picked)
            .map(|s| (s.value.as_str(), s.kind.as_deref()))
            .collect();
        assert_eq!(
            picked,
            vec![
                ("wood (plant material)", Some("wood")),
                ("rattan", Some("rattan")),
            ]
        );
        let alternates: Vec<(&str, Option<&str>)> = sugs
            .iter()
            .filter(|s| !s.picked)
            .map(|s| (s.value.as_str(), s.kind.as_deref()))
            .collect();
        assert_eq!(alternates, vec![("oak (wood)", Some("wood"))]);
    }

    #[test]
    fn suggestions_with_alternates_with_no_picks_yields_alternates_only() {
        // Validation matched nothing (empty record path): the shortlist is
        // still offered as choices — nothing is auto-recorded either way.
        let groups = vec![net("wood", vec![pick("wood (plant material)", 0.609)])];
        let kinds = HashMap::from([("wood (plant material)".to_string(), "wood".to_string())]);
        let sugs = suggestions_with_alternates(Vec::new(), &groups, &kinds);
        assert_eq!(sugs.len(), 1);
        assert!(!sugs[0].picked);
        assert_eq!(sugs[0].value, "wood (plant material)");
        assert_eq!(sugs[0].kind.as_deref(), Some("wood"));
    }

    #[test]
    fn resolved_group_kinds_folds_a_collapsed_group_under_the_survivor() {
        // Judge named three kinds; the same-kind collapse folded "oak" into
        // "wood" — the recorded kinds are wood and rattan, so the oak group's
        // shade follows the survivor and no third kind can render.
        let winners = vec![
            Some(pick("wood (plant material)", 0.609)),
            Some(pick("oak (wood)", 0.55)),
            Some(pick("rattan", 0.563)),
        ];
        let groups = vec![
            net("wood", vec![pick("wood (plant material)", 0.609)]),
            net("oak", vec![pick("oak (wood)", 0.55), pick("ash", 0.4)]),
            net("rattan", vec![pick("rattan", 0.563)]),
        ];
        let winner_kinds = HashMap::from([
            ("wood (plant material)".to_string(), "wood".to_string()),
            ("oak (wood)".to_string(), "oak".to_string()),
            ("rattan".to_string(), "rattan".to_string()),
        ]);
        let fold = HashMap::from([(
            "oak (wood)".to_string(),
            "wood (plant material)".to_string(),
        )]);
        let recorded: HashSet<String> =
            ["wood (plant material)".to_string(), "rattan".to_string()].into();
        let kinds = resolved_group_kinds(&winners, &groups, &winner_kinds, &fold, &recorded);
        assert_eq!(
            kinds.iter().map(|k| k.as_deref()).collect::<Vec<_>>(),
            [Some("wood"), Some("wood"), Some("rattan")]
        );
    }

    #[test]
    fn resolved_group_kinds_drops_groups_orphaned_by_the_cap_or_gate() {
        // Cap 2 with three groups: the third group's pick was cut, so it is
        // not a kind — it contributes no shade and no candidates.
        let winners = vec![
            Some(pick("a1", 0.7)),
            Some(pick("b1", 0.6)),
            Some(pick("c1", 0.5)),
        ];
        let groups = vec![
            net("a", vec![pick("a1", 0.7)]),
            net("b", vec![pick("b1", 0.6)]),
            net("c", vec![pick("c1", 0.5)]),
        ];
        let winner_kinds = HashMap::from([
            ("a1".to_string(), "a".to_string()),
            ("b1".to_string(), "b".to_string()),
            ("c1".to_string(), "c".to_string()),
        ]);
        let recorded: HashSet<String> = ["a1".to_string(), "b1".to_string()].into();
        let kinds =
            resolved_group_kinds(&winners, &groups, &winner_kinds, &HashMap::new(), &recorded);
        assert_eq!(
            kinds.iter().map(|k| k.as_deref()).collect::<Vec<_>>(),
            [Some("a"), Some("b"), None]
        );
    }

    #[test]
    fn resolved_group_kinds_with_nothing_recorded_keeps_every_kind() {
        // Pure choice list: nothing recorded, every group offers its own
        // shortlist under its own phrase.
        let groups = vec![
            net("a", vec![pick("a1", 0.7)]),
            net("b", vec![pick("b1", 0.6)]),
        ];
        let kinds = resolved_group_kinds(
            &[],
            &groups,
            &HashMap::new(),
            &HashMap::new(),
            &HashSet::new(),
        );
        assert_eq!(
            kinds.iter().map(|k| k.as_deref()).collect::<Vec<_>>(),
            [Some("a"), Some("b")]
        );
    }

    #[test]
    fn candidate_kinds_skips_orphan_groups_and_recorded_terms() {
        // The cap-orphan "c" group contributes nothing even though its
        // candidates exist; the recorded pick keeps its assigned kind.
        let picked = vec![pick("a1", 0.7), pick("b1", 0.6)];
        let groups = vec![
            net("a", vec![pick("a1", 0.7), pick("a2", 0.4)]),
            net("b", vec![pick("b1", 0.6)]),
            net("c", vec![pick("c1", 0.5), pick("c2", 0.3)]),
        ];
        let group_kinds = vec![Some("a".to_string()), Some("b".to_string()), None];
        let winner_kinds = HashMap::from([
            ("a1".to_string(), "a".to_string()),
            ("b1".to_string(), "b".to_string()),
            ("c1".to_string(), "c".to_string()),
        ]);
        let recorded: HashSet<String> = ["a1".to_string(), "b1".to_string()].into();
        let kinds = candidate_kinds(&picked, &groups, &group_kinds, &winner_kinds, &recorded);
        assert_eq!(kinds.len(), 3); // a1, b1 (recorded) + a2 (alternate)
        assert_eq!(kinds.get("a2").map(String::as_str), Some("a"));
        assert!(!kinds.contains_key("c1") && !kinds.contains_key("c2"));
    }

    #[test]
    fn stage_plan_mirrors_the_pipeline_gates() {
        use crate::ai::types::fixtures::open_field;
        let sourced = |name: &str| {
            let mut f = vocab_field(name);
            f.vocab_source_ids = vec!["src".to_string()];
            f
        };
        let multi = |name: &str| {
            let mut f = sourced(name);
            f.max_components = 3;
            f
        };

        // Open fields only: analysis alone.
        assert_eq!(
            stage_plan(&[open_field("Name")], false, false),
            ["analysis"]
        );
        // A vocab field without synced sources is invisible to the plan.
        assert_eq!(
            stage_plan(&[vocab_field("Colour")], true, true),
            ["analysis"]
        );
        // Vocab + embeddings, validation off: analysis + retrieval.
        assert_eq!(
            stage_plan(&[sourced("Material")], true, false),
            ["analysis", "retrieval"]
        );
        // Validation on but no embedding provider: partition still runs for
        // multi-component fields; retrieval/validation cannot.
        let mut unsourced_multi = vocab_field("Object Type");
        unsourced_multi.max_components = 3;
        assert_eq!(
            stage_plan(&[unsourced_multi], false, true),
            ["analysis", "partition"]
        );
        // Everything on: all four stages in execution order.
        assert_eq!(
            stage_plan(&[open_field("Name"), multi("Object Type")], true, true),
            ["analysis", "partition", "retrieval", "validation"]
        );
    }
}
