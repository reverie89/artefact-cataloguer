//! Live, `#[ignore]`d end-to-end probe for the catalogue pipeline — run by
//! hand, never in CI. It executes the real `catalogue_artefact` command on a
//! mock app against the debug build's on-disk config: real chat/embedding
//! providers, real OS keychain, real LanceDB tables. Output: every `ac-logs`
//! stage event (prompt bodies with the production image redaction, raw model
//! responses), then a digest — the judge's parsed components, the scored
//! per-component candidate nets, and the final result.
//!
//! The on-disk settings are never written: the partition judge's preconditions
//! (`validationEnabled`, the Colour field's `maxComponents`) are flipped in the
//! in-memory copy only. API keys are rehydrated from the keychain through the
//! app's own `secrets` path and are never printed.
//!
//! Usage (the settings live beside the debug binary; the image path is yours):
//!
//! ```sh
//! AC_PROBE_IMAGE=/path/to/artefact-photo.png \
//!   cargo test --manifest-path src-tauri/Cargo.toml live_pipeline_probe \
//!   -- --ignored --nocapture
//! ```

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver};
use tauri::{Listener, Manager};

use crate::settings::StateBundle;

/// The debug build's live config — read read-only.
const DEBUG_SETTINGS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/target/debug/settings.json");

/// The vocab field the probe turns multi-component so the partition judge
/// fires. Headroom above the "at least 3 colours" expectation: the judge is
/// quota-free and the post-validation cut keeps the best picks.
const PROBE_MULTI_FIELD: &str = "Colour";
const PROBE_MULTI_FIELD_CAP: u32 = 5;

/// Load the debug settings read-only and rehydrate keys from the OS keychain.
/// Prompt normalization is skipped: the live file carries no double-escaped
/// prompt strings, so it would be a no-op.
fn load_debug_settings() -> StateBundle {
    let raw = std::fs::read_to_string(DEBUG_SETTINGS)
        .unwrap_or_else(|e| panic!("read {DEBUG_SETTINGS}: {e}"));
    let mut bundle: StateBundle =
        serde_json::from_str(&raw).expect("debug settings.json parses as StateBundle");
    crate::secrets::rehydrate(&mut bundle.settings);
    bundle
}

fn entry_by_id<'a>(
    entries: &'a [serde_json::Value],
    id: &str,
    what: &str,
) -> &'a serde_json::Value {
    entries
        .iter()
        .find(|e| e.get("id").and_then(serde_json::Value::as_str) == Some(id))
        .unwrap_or_else(|| panic!("{what}: no entry with id {id}"))
}

/// Assert a rehydrated key exists for `entry_id`. Presence only — the value is
/// never printed.
fn assert_key(entry: &serde_json::Value, entry_id: &str) {
    let present = entry["apiKey"]
        .as_str()
        .map(|k| !k.is_empty())
        .unwrap_or(false);
    assert!(
        present,
        "no OS-keychain key for {entry_id} — re-enter the key in the app's Providers tab, then rerun"
    );
    println!("[probe] keychain key for {entry_id}: present");
}

/// Mirror `lib/ai.ts` `vocabSourceIdsForRetrieval` + `embeddingModelStale`:
/// retrieval-ready = synced AND embedded with the active embedding model (a
/// foreign vector space would give junk cosines).
fn ready_source_ids(
    field: &serde_json::Value,
    sources: &[serde_json::Value],
    active_model: &str,
) -> Vec<String> {
    field["vocabSources"]
        .as_array()
        .map(|ids| {
            ids.iter()
                .filter_map(serde_json::Value::as_str)
                .filter(|sid| {
                    sources.iter().any(|s| {
                        s["id"].as_str() == Some(*sid)
                            && s["embedding"]["status"].as_str() == Some("synced")
                            && s["embedding"]["model"].as_str() == Some(active_model)
                    })
                })
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn print_event(ev: &serde_json::Value) {
    let stage = ev["stage"].as_str().unwrap_or("?");
    let label = ev["label"].as_str().unwrap_or("");
    let detail = ev["detail"].as_str().unwrap_or("");
    let rule = "────────────────────────────────────────";
    match stage {
        "postSent" => {
            println!("\n{rule} ▶ POST [{label}] {detail} {rule}");
            if let Some(body) = ev.pointer("/verbose/body") {
                println!("{}", serde_json::to_string_pretty(body).unwrap_or_default());
            }
        }
        "done" | "failed" => {
            println!("\n{rule} ◼ {stage} [{label}] {detail} {rule}");
            if let Some(desc) = ev.pointer("/verbose/description").and_then(|v| v.as_str()) {
                println!("{desc}");
            }
            if let Some(err) = ev.pointer("/verbose/error").and_then(|v| v.as_str()) {
                println!("[error] {err}");
            }
        }
        _ => {}
    }
}

/// Pair each completion's label (from its `postSent` event) with the terminal
/// event of the same `jobGroup`, whose `verbose.description` carries the raw
/// model response (or `verbose.error` on failure).
fn responses_by_label(events: &[serde_json::Value]) -> HashMap<String, String> {
    let mut labels: HashMap<String, String> = HashMap::new();
    let mut out = HashMap::new();
    for ev in events {
        let group = ev["jobGroup"].as_str().unwrap_or("").to_string();
        if group.is_empty() {
            continue;
        }
        match ev["stage"].as_str() {
            Some("postSent") => {
                if let Some(label) = ev["label"].as_str() {
                    labels.insert(group, label.to_string());
                }
            }
            Some("done") | Some("failed") => {
                let Some(label) = labels.get(&group) else {
                    continue;
                };
                if let Some(desc) = ev.pointer("/verbose/description").and_then(|v| v.as_str()) {
                    out.insert(label.clone(), desc.to_string());
                } else if let Some(err) = ev.pointer("/verbose/error").and_then(|v| v.as_str()) {
                    out.insert(label.clone(), format!("<error> {err}"));
                }
            }
            _ => {}
        }
    }
    out
}

fn drain(rx: &Receiver<serde_json::Value>) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    while let Ok(v) = rx.try_recv() {
        out.push(v);
    }
    out
}

/// Kernel-keyutils visibility report: walks every keyring this process can
/// reach (session / user-session / user / persistent) and prints only the
/// descriptions of `artefact-cataloguer` keys (never values), plus how many
/// unrelated keys each ring holds. Diagnoses "no OS-keychain key" failures:
/// the app's `linux-native` keyring backend stores keys in kernel memory —
/// the owning session's ring plus a per-UID persistent ring — so a key
/// entered in another login session (or on another machine) is invisible here.
#[test]
#[ignore = "diagnostic: reports visible keyutils keys; run with --ignored --nocapture"]
fn probe_keychain_visibility() {
    use linux_keyutils::{KeyRing, KeyRingIdentifier, LinkNode};

    fn walk(kr: KeyRing, path: String, depth: usize) {
        match kr.get_links(64) {
            Ok(links) => {
                let (mut ours, mut other) = (0usize, 0usize);
                for (i, node) in links.iter().enumerate() {
                    match node {
                        LinkNode::KeyRing(inner) if depth < 3 => {
                            walk(*inner, format!("{path}[{i}]"), depth + 1);
                        }
                        LinkNode::KeyRing(_) => {}
                        LinkNode::Key(key) => match key.metadata() {
                            Ok(meta) => {
                                // Metadata fields are private; Debug carries
                                // the description.
                                let text = format!("{meta:?}");
                                if text.contains("artefact-cataloguer") {
                                    ours += 1;
                                    println!("[keydiag]   {path} :: {text}");
                                } else {
                                    other += 1;
                                }
                            }
                            Err(_) => other += 1,
                        },
                    }
                }
                println!("[keydiag] {path}: {ours} app key(s), {other} unrelated");
            }
            Err(e) => println!("[keydiag] {path}: unreadable ({e})"),
        }
    }

    // The app's own lookup for every configured provider (presence only).
    let bundle = load_debug_settings();
    for arr in ["providers", "embeddingProviders"] {
        if let Some(list) = bundle.settings[arr].as_array() {
            for p in list {
                let id = p["id"].as_str().unwrap_or_default();
                let entry = if arr == "providers" {
                    crate::secrets::chat_entry_id(id)
                } else {
                    crate::secrets::embedding_entry_id(id)
                };
                println!(
                    "[keydiag] app lookup {entry}: {}",
                    if crate::secrets::get_key(&entry).is_some() {
                        "present"
                    } else {
                        "absent"
                    }
                );
            }
        }
    }

    for (name, id) in [
        ("session", KeyRingIdentifier::Session),
        ("user-session", KeyRingIdentifier::UserSession),
        ("user", KeyRingIdentifier::User),
    ] {
        if let Ok(kr) = KeyRing::from_special_id(id, false) {
            walk(kr, name.to_string(), 0);
        }
    }
    match KeyRing::get_persistent(KeyRingIdentifier::Session) {
        Ok(kr) => walk(kr, "persistent".to_string(), 0),
        Err(e) => println!("[keydiag] persistent: unreachable ({e})"),
    }
}

/// Resolve the chat provider the probe runs with: `AC_PROBE_PROVIDER` (id or
/// name) overrides the settings' active provider. The `openrouter/free`
/// default is a router that lands nondeterministically — different upstreams
/// per call, moderation models, upstream 429s — so a dedicated model from the
/// same live config is the controlled comparison.
fn resolve_chat_provider(s: &serde_json::Value) -> serde_json::Value {
    let providers = s["providers"].as_array().expect("providers array");
    let active_id = s["activeProvider"].as_str().expect("activeProvider set");
    let want = std::env::var("AC_PROBE_PROVIDER").ok();
    providers
        .iter()
        .find(|p| match &want {
            Some(w) => {
                p["id"].as_str() == Some(w.as_str()) || p["name"].as_str() == Some(w.as_str())
            }
            None => p["id"].as_str() == Some(active_id),
        })
        .unwrap_or_else(|| panic!("no provider matching AC_PROBE_PROVIDER={want:?}"))
        .clone()
}

/// One-shot installer for the live probe: reads `AC_PROBE_KEY` and stores it
/// through the app's own secrets path for the resolved chat provider and the
/// active embedding provider (both OpenRouter here, so one key covers both).
/// Values are never printed. This is what un-blocks the probe after a keyring
/// loss — settings carry no keys and the kernel keyutils rings don't migrate
/// across machines.
#[test]
#[ignore = "one-shot: installs AC_PROBE_KEY into the OS keychain; run with --ignored --nocapture"]
fn probe_install_key() {
    let key = std::env::var("AC_PROBE_KEY").expect("set AC_PROBE_KEY");
    assert!(!key.is_empty(), "AC_PROBE_KEY empty");
    let bundle = load_debug_settings();
    let chat_json = resolve_chat_provider(&bundle.settings);
    let chat_id = chat_json["id"].as_str().expect("chat provider id");
    let emb_id = bundle.settings["activeEmbeddingProvider"]
        .as_str()
        .expect("activeEmbeddingProvider set");
    crate::secrets::set_key(&crate::secrets::chat_entry_id(chat_id), &key)
        .expect("keychain write (chat)");
    crate::secrets::set_key(&crate::secrets::embedding_entry_id(emb_id), &key)
        .expect("keychain write (embedding)");
    println!("[probe] key installed for chat::{chat_id} and embedding::{emb_id}");
}

#[tokio::test]
#[ignore = "live end-to-end probe: real providers + keychain; set AC_PROBE_IMAGE and run with --ignored --nocapture"]
async fn live_pipeline_probe() {
    let bundle = load_debug_settings();
    let s = &bundle.settings;

    let provider_json = resolve_chat_provider(s);
    assert_key(
        &provider_json,
        &format!("chat::{}", provider_json["id"].as_str().unwrap_or("?")),
    );
    let provider: super::Provider = serde_json::from_value(provider_json).expect("provider shape");
    println!(
        "[probe] chat provider: {} ({}) model {}",
        provider.name, provider.base_url, provider.model
    );

    let emb_id = s["activeEmbeddingProvider"]
        .as_str()
        .expect("activeEmbeddingProvider set");
    let embs = s["embeddingProviders"]
        .as_array()
        .expect("embeddingProviders array");
    let emb_json = entry_by_id(embs, emb_id, "embeddingProviders").clone();
    assert_key(&emb_json, &format!("embedding::{emb_id}"));
    let emb: crate::embeddings::EmbeddingProvider =
        serde_json::from_value(emb_json).expect("embedding provider shape");
    println!(
        "[probe] embedding provider: {} model {}",
        emb.name, emb.model
    );

    let sources = s["vocabSources"].as_array().cloned().unwrap_or_default();
    let net_count = s["vocabNetCount"].as_u64().unwrap_or(20) as usize;
    let shortlist_count = s["vocabShortlistCount"].as_u64().unwrap_or(3) as usize;

    // Fields with retrieval-ready source ids (mirrors the frontend filter);
    // the probe field gets multi-component headroom so the judge fires.
    // AC_PROBE_MULTI_ALL=1 flips EVERY vocab field to that cap instead — the
    // judge-audit mode: partition + per-group validation data for all vocabs
    // (and the extraction enumeration clause in the stage-1 prompt).
    let multi_all = std::env::var("AC_PROBE_MULTI_ALL")
        .map(|v| v == "1")
        .unwrap_or(false);
    let mut fields: Vec<super::FieldSpec> = Vec::new();
    for f in s["fields"].as_array().expect("fields array") {
        let mut obj = serde_json::json!({
            "name": f["name"].as_str().unwrap_or_default(),
            "type": f["type"].as_str().unwrap_or_default(),
            "prompt": f["prompt"].as_str().unwrap_or_default(),
            "vocabSourceIds": ready_source_ids(f, &sources, &emb.model),
        });
        let is_multi_target = f["name"].as_str() == Some(PROBE_MULTI_FIELD)
            || (multi_all && f["type"].as_str() == Some("vocab"));
        if is_multi_target {
            obj["maxComponents"] = serde_json::json!(PROBE_MULTI_FIELD_CAP);
        } else {
            // A missing key hits FieldSpec's serde default; a `null` value
            // would fail u32 deserialization, so normalize it.
            obj["maxComponents"] = f
                .get("maxComponents")
                .filter(|v| v.is_u64())
                .cloned()
                .unwrap_or_else(|| serde_json::json!(1));
        }
        fields.push(serde_json::from_value(obj).expect("field shape"));
    }
    assert!(
        fields
            .iter()
            .any(|f| f.name == PROBE_MULTI_FIELD && f.max_components != 1),
        "{PROBE_MULTI_FIELD} field missing from settings or not flipped"
    );
    println!(
        "[probe] fields: {} — validation ON, {} maxComponents \
         {PROBE_MULTI_FIELD_CAP}, net {net_count}, shortlist {shortlist_count}",
        fields
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        if multi_all {
            "ALL vocab fields"
        } else {
            PROBE_MULTI_FIELD
        },
    );

    // Stage the probe image through the real scratch-dir validation.
    let src = PathBuf::from(
        std::env::var("AC_PROBE_IMAGE").expect("set AC_PROBE_IMAGE to the artefact photo path"),
    );
    let scratch = crate::images::temp_app_dir();
    std::fs::create_dir_all(&scratch).expect("create scratch dir");
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("png");
    let dest = scratch.join(format!("probe-artefact.{ext}"));
    std::fs::copy(&src, &dest).expect("stage probe image into scratch dir");
    println!(
        "[probe] image staged: {} ({} bytes)",
        dest.display(),
        std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0)
    );

    // Photo-only row: empty record; live persona + AI-included columns.
    let columns: Vec<serde_json::Value> = s["artefactFields"]
        .as_array()
        .map(|cols| {
            cols.iter()
                .filter(|c| c["includeForAI"].as_bool() == Some(true))
                .map(|c| {
                    serde_json::json!({
                        "name": c["name"].as_str().unwrap_or_default(),
                        "prompt": c["prompt"].as_str().unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let artefact: super::ArtefactInput = serde_json::from_value(serde_json::json!({
        "record": {},
        "imagePath": dest.to_string_lossy(),
        "artefactAnalysisSystemPrompt":
            s["artefactAnalysisSystemPromptInstruction"].as_str().unwrap_or("").trim(),
        "artefactColumns": columns,
    }))
    .expect("artefact shape");

    // Mock app: the command's logging emits `ac-logs` on this handle; the
    // listener prints each event live and captures it for the digest. Emission
    // is synchronous, so everything is in the channel once the call returns.
    let app = tauri::test::mock_app();
    app.manage(super::default_registry());
    let handle = app.handle().clone();
    let (tx, rx) = channel::<serde_json::Value>();
    handle.listen("ac-logs", move |event| {
        if let Ok(ev) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            print_event(&ev);
            let _ = tx.send(ev);
        }
    });

    let state = app.state::<super::CancelRegistry>();
    super::catalogue_artefact(
        handle,
        state,
        "probe-job".to_string(),
        provider,
        fields.clone(),
        artefact,
        Some(emb.clone()),
        Some(net_count),
        Some(shortlist_count),
        Some(true),
    )
    .await
    .map(|r| {
        println!("\n══════════════ final CatalogueResult ══════════════");
        println!("{}", serde_json::to_string_pretty(&r).unwrap_or_default());
    })
    .unwrap_or_else(|e| println!("\n══════════════ pipeline FAILED: {e} ══════════════"));

    // The pipeline's internal shortlists are not part of any log event, so
    // re-run the retrieval leg on the judge's own components to print the
    // scored candidate nets (same functions, same inputs).
    let events = drain(&rx);
    let responses = responses_by_label(&events);
    let (Some(analysis), Some(partition)) = (
        responses.get("Artefact Analysis"),
        responses.get("Component Partition"),
    ) else {
        println!("[probe] analysis/partition raw response missing — nothing to reparse");
        return;
    };

    let multi_specs: Vec<super::FieldSpec> = fields
        .iter()
        .filter(|f| f.field_type == "vocab" && f.max_components != 1)
        .cloned()
        .collect();
    let (comps, comp_warnings) = super::parse_partition_response(partition, &multi_specs);
    println!("\n══════════════ partition judge components ══════════════");
    for (field, list) in &comps {
        println!("  {field}:");
        if list.is_empty() {
            println!("    (none — extraction split fallback)");
        }
        for c in list {
            println!("    - {c}");
        }
    }
    println!("  parse warnings: {comp_warnings:?}");

    let parsed = super::parse_unified_response(analysis, &fields);
    println!("\n══════════════ artefact-analysis parse ══════════════");
    for (k, v) in &parsed.extractions {
        println!("  <extraction {k}>: {v}");
    }
    for (k, v) in &parsed.open_values {
        println!("  <open_field {k}>: {v}");
    }
    println!("  warnings: {:?}", parsed.warnings);

    let image = super::ImageData {
        bytes: std::fs::read(&dest).expect("probe image still staged"),
        mime: super::guess_mime(&dest.to_string_lossy()),
    };
    println!(
        "\n══════════════ per-component candidate nets (cosine, top {shortlist_count}) ══════════════"
    );
    match super::resolve_vocab_fields(
        &emb,
        &fields,
        &comps,
        &parsed.extractions,
        Some(&image),
        net_count,
        shortlist_count,
    )
    .await
    {
        Ok((resolved, warnings)) => {
            for rv in &resolved {
                println!("  [{}]", fields[rv.field_index].name);
                for g in &rv.groups {
                    println!("    component {:?}:", g.extraction);
                    for c in &g.candidates {
                        println!("      {:.4}  {}", c.score, c.term);
                    }
                }
            }
            println!("  resolver warnings: {warnings:?}");
        }
        Err(e) => println!("  resolver reprint failed: {e}"),
    }
}
