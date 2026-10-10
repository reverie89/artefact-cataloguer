//! Prompt construction for the LLM calls: the unified artefact-analysis
//! prompt (persona preamble, per-column guidance, XML field enumeration,
//! `<artefact_file>` record), the partition judge's prompt (per-field distinct
//! components, quota-free), and the validation prompt (per-component candidate
//! groups + the fixed `<validated>` reply contract), plus the record→XML
//! rendering and escaping helpers they build on.

use serde_json::Value;
use std::collections::HashMap;

use super::types::{ArtefactColumnSpec, ComponentNet, FieldSpec};

/// Collect every (column, value) pair from the record as strings. The record
/// is config-strict by the time it arrives: the frontend wrapper (`lib/ai.ts`
/// `recordForAI`) filters it down to the Artefact File columns with Include
/// for AI on, so every column here is meaningful and reaches the model
/// verbatim. The Image column never arrives here: the parser excludes it from
/// `record` (its bytes travel a separate fflate-extracted path into the image
/// content block).
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

/// Fixed instruction appended to multi-component vocab fields' extraction
/// guidance (see `build_unified_prompt`). The extraction is the retrieval
/// text, so enumerating every distinct component (e.g. several materials) is
/// what lets per-component retrieval surface a candidate for each. This is
/// also the fallback partitioning wording: when the judge is unavailable
/// (validation off / partition failure), the extraction text itself is split
/// on these semicolons.
const COMPONENT_ENUMERATION_CLAUSE: &str = "List every distinct component that applies, separated by semicolons — components differ in kind (a different material, part, colour, or aspect), never in specificity alone; several may apply.";

/// Compose the unified artefact-analysis prompt. Structure (joined by blank lines):
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
pub(crate) fn build_unified_prompt(
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
        let mut content = prompt.to_string();
        if f.field_type == "vocab" && f.max_components != 1 {
            if !content.is_empty() {
                content.push(' ');
            }
            content.push_str(COMPONENT_ENUMERATION_CLAUSE);
        }
        let guidance = if content.is_empty() {
            String::new()
        } else {
            format!("({content})")
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

/// Per-field pick rule rendered into the validation prompt. Multi-component
/// fields pick at most one term per component group (the structural cap lives
/// in Rust: groups outnumber the field's `max_components` only before the
/// post-validation cut); the perceiver is also allowed to collapse groups it
/// judges to be the same aspect.
fn selection_line(field: &FieldSpec) -> String {
    if field.max_components == 1 {
        "single — pick only the top one term".to_string()
    } else {
        "multiple — pick at most one term per component group: the top match for each distinct component. If two groups describe the same aspect of the artefact (e.g. two greys of one background), pick for one and skip the other; a group with no fitting candidate is simply skipped".to_string()
    }
}

/// Compose the validation prompt. For each vocab field: the field's extracted
/// text (from artefact analysis), an optional per-field `prompt` (user
/// preferences), its selection rule, and its per-component candidate groups —
/// each group is one distinct component with its own shortlisted candidate
/// **terms only** (no cosine, no thesaurus, no vectors, to avoid biasing the
/// model toward internal scores). A single-component field renders today's
/// flat candidate block; multi-component fields render one labelled block per
/// component. Ends with the fixed XML reply contract. Pure; built once per
/// catalogue call.
pub(crate) fn build_validation_prompt(
    shortlists: &[(usize, &FieldSpec, &str, &[ComponentNet])],
) -> String {
    let mut sections = Vec::new();
    for (_, field, extracted, groups) in shortlists {
        let mut block = format!("[{}] extracted: \"{}\"", field.name, extracted);
        let prompt = field.prompt.trim();
        if !prompt.is_empty() {
            block.push_str(&format!("\nguidance: {prompt}"));
        }
        block.push_str(&format!("\nselection: {}", selection_line(field)));
        let render = |g: &ComponentNet| {
            if g.candidates.is_empty() {
                format!("\ncomponent \"{}\" candidates: (none)", g.extraction)
            } else {
                let terms: Vec<String> = g
                    .candidates
                    .iter()
                    .map(|c| format!("- {}", c.term))
                    .collect();
                format!(
                    "\ncomponent \"{}\" candidates:\n{}",
                    g.extraction,
                    terms.join("\n")
                )
            }
        };
        if groups.len() > 1 {
            for g in groups.iter() {
                block.push_str(&render(g));
            }
        } else {
            // Single-component field: today's flat rendering (no group label).
            match groups.first() {
                Some(g) if !g.candidates.is_empty() => {
                    let terms: Vec<String> = g
                        .candidates
                        .iter()
                        .map(|c| format!("- {}", c.term))
                        .collect();
                    block.push_str(&format!("\ncandidates:\n{}", terms.join("\n")));
                }
                _ => block.push_str("\ncandidates: (none)"),
            }
        }
        sections.push(block);
    }
    let contract = "Pick terms VERBATIM from each field's candidate list — do not invent, reword, or merge terms. Pick at most one term per component group, honoring each field's selection line (single fields get exactly one pick, the top one). Skipping a group is correct when nothing in it fits, or when another group of the same field already covers that kind — different terms can still be one kind (oak and olive are both woods; crimson is a red): pick for the group that fits best and skip the rest — fewer picks than groups is correct, never pad. If none of a field's candidates fit the artefact, emit an empty <validated> block for it.\n\nReply ONLY with, one block per field in the order above:\n<validated field=\"{Field Name}\"><pick term=\"{verbatim candidate term}\" /></validated>";
    sections.push(contract.to_string());
    sections.join("\n\n")
}

/// Per-field definition of what "one distinct component" means, so the judge
/// cannot split a field by *part*. Observed live: an all-wood artefact came
/// back as oak/olive/rosewood/pear because each part became a component and
/// each part's net retrieved a different wood variety. Matched by
/// case-insensitive substring over the seed field names (checked in this
/// order, so compound names resolve to their first match); user-created
/// fields fall back to the generic clause.
fn partition_field_clause(field_name: &str) -> &'static str {
    let lower = field_name.to_ascii_lowercase();
    if lower.contains("material") {
        "a component is a distinct substance the artefact is made of — parts are not materials, and varieties of one substance are one component (oak, olive and rosewood are all wood): an artefact built entirely of wood has exactly one material component"
    } else if lower.contains("colour") || lower.contains("color") {
        "a component is a distinct colour family visible on the artefact (red and crimson are one; two greys of one background are one)"
    } else if lower.contains("shape") {
        "a component is a distinct overall form or silhouette (rectangular and rectangular cuboid are one)"
    } else if lower.contains("technique") {
        "a component is a distinct making process used on the artefact"
    } else if lower.contains("place") {
        "a component is a distinct place the artefact originates from; name none when there is no evidence"
    } else if lower.contains("type") || lower.contains("work") {
        "a component is a distinct object kind the artefact is (a multi-part installation is one work type)"
    } else {
        "a component is one genuinely distinct kind of thing for this field — never a variety of the same kind"
    }
}

/// Compose the partition judge's prompt: one focused vision call naming the
/// distinct components of the artefact for every multi-component vocab field.
/// Deliberately quota-free — the builder does not receive `maxComponents`; the
/// caller caps the parsed components in Rust, so the model can never pad to a
/// number it was never shown. The artefact record is included because a human
/// cataloguer reads the row's metadata before deciding what is distinct.
pub(crate) fn build_partition_prompt(fields: &[FieldSpec], record: &Value) -> String {
    let mut sections = Vec::new();
    sections.push(
        "You are a museum cataloguing assistant. Look at the artefact image and its metadata record, then name the distinct components the artefact has for each field listed below. A component is one genuinely distinct kind of thing — never a variety of the same kind (red and crimson are one colour; rectangular and rectangular cuboid are one shape). List the most salient component first, and name as many as are really there — often there is only one. Use short descriptive phrases (e.g. \"jute body\", \"synthetic lining\")."
            .to_string(),
    );
    let lines: Vec<String> = fields
        .iter()
        .map(|f| {
            let mut line = format!("- {} — {}.", f.name, partition_field_clause(&f.name));
            let prompt = f.prompt.trim();
            if !prompt.is_empty() {
                line.push_str(&format!(" (guidance: {prompt})"));
            }
            line
        })
        .collect();
    sections.push(format!(
        "For each field below, list its distinct components:\n{}",
        lines.join("\n")
    ));
    sections.push(record_xml(record));
    sections.push(
        "Reply ONLY with, one block per field in the order above:\n<components field=\"{Field Name}\"><component>{distinct component}</component></components>"
            .to_string(),
    );
    sections.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::types::fixtures::{column, open_field, vocab_field};
    use crate::ai::types::{ComponentNet, FieldSpec, NetCandidate};
    use serde_json::json;

    /// Test candidate: term + score, empty vector (the gate needs vectors;
    /// prompt rendering must not).
    fn cand(term: &str, score: f32) -> NetCandidate {
        NetCandidate {
            term: term.to_string(),
            score,
            vector: Vec::new(),
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
                max_components: 1,
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
        let groups = vec![ComponentNet {
            extraction: "bronze, patinated".to_string(),
            candidates: vec![cand("bronze", 0.9), cand("iron", 0.7)],
        }];
        let extracted = "bronze, patinated";
        let refs: Vec<(usize, &FieldSpec, &str, &[ComponentNet])> =
            vec![(0, &fields[0], extracted, &groups)];
        let prompt = build_validation_prompt(&refs);
        // Terms present.
        assert!(prompt.contains("- bronze"));
        assert!(prompt.contains("- iron"));
        // Scores, vectors, and thesaurus badges are NOT present (pure terms only).
        assert!(!prompt.contains("0.9"));
        assert!(!prompt.contains("[NHB]"));
        // The fixed XML reply contract is present.
        assert!(prompt.contains("<validated field="));
        assert!(prompt.contains("VERBATIM"));
        // The same-kind cross-group skip rule names the failure it prevents.
        assert!(prompt.contains("oak and olive are both woods"));
        // Single-component fields keep the flat candidate rendering.
        assert!(!prompt.contains("component \""));
    }

    #[test]
    fn build_validation_prompt_injects_field_guidance() {
        let fields = [FieldSpec {
            name: "Obj./Work type".to_string(),
            field_type: "vocab".to_string(),
            prompt: "Prefer the broadest applicable type.".to_string(),
            vocab_source_ids: Vec::new(),
            max_components: 1,
        }];
        let groups = vec![ComponentNet {
            extraction: "a vessel".to_string(),
            candidates: vec![cand("bowl", 0.8)],
        }];
        let refs: Vec<(usize, &FieldSpec, &str, &[ComponentNet])> =
            vec![(0, &fields[0], "a vessel", &groups)];
        let prompt = build_validation_prompt(&refs);
        assert!(prompt.contains("Prefer the broadest applicable type."));
    }

    #[test]
    fn unified_prompt_multi_component_vocab_field_enumerates_components() {
        let mut multi = vocab_field("Material");
        multi.max_components = 3;
        let prompt = build_unified_prompt("", &[], &[multi], &json!({}), true);
        assert!(prompt.contains("List every distinct component that applies"));
        // Single-component fields stay untouched.
        let single = build_unified_prompt("", &[], &[vocab_field("Shape")], &json!({}), true);
        assert!(!single.contains("List every distinct component"));
    }

    #[test]
    fn unified_prompt_multi_component_clause_composes_with_user_prompt() {
        let mut f = vocab_field("Material");
        f.max_components = 0;
        f.prompt = "Focus on metals.".to_string();
        let prompt = build_unified_prompt("", &[], &[f], &json!({}), true);
        assert!(prompt.contains(
            "(Focus on metals. List every distinct component that applies, separated by semicolons — components differ in kind (a different material, part, colour, or aspect), never in specificity alone; several may apply.)"
        ));
    }

    #[test]
    fn validation_prompt_states_per_field_selection_rule() {
        let mut multi = vocab_field("Material");
        multi.max_components = 3;
        let fields = [vocab_field("Shape"), multi];
        let single_groups = vec![ComponentNet {
            extraction: "a bowl".to_string(),
            candidates: vec![cand("cylindrical", 0.8)],
        }];
        let multi_groups = vec![
            ComponentNet {
                extraction: "jute body".to_string(),
                candidates: vec![cand("jute", 0.9), cand("hemp", 0.7)],
            },
            ComponentNet {
                extraction: "synthetic lining".to_string(),
                candidates: vec![cand("nylon", 0.6)],
            },
        ];
        let refs: Vec<(usize, &FieldSpec, &str, &[ComponentNet])> = vec![
            (0, &fields[0], "a bowl", &single_groups),
            (1, &fields[1], "jute bag with lining", &multi_groups),
        ];
        let prompt = build_validation_prompt(&refs);
        assert!(prompt.contains("selection: single — pick only the top one term"));
        assert!(prompt.contains("selection: multiple — pick at most one term per component group"));
        assert!(prompt.contains("pick for one and skip the other"));
        // Multi-component fields render labelled per-component groups; the
        // single-component field keeps the flat block.
        assert!(prompt.contains("component \"jute body\" candidates:"));
        assert!(prompt.contains("component \"synthetic lining\" candidates:"));
        assert!(prompt.contains("never pad"));
        // Quota-free: the cap lives in Rust, so no cap number reaches the prompt.
        assert!(!prompt.contains("(at most 3"));
    }

    #[test]
    fn partition_prompt_lists_fields_guidance_record_and_contract() {
        let mut colour = vocab_field("Colour");
        colour.prompt = "Record at their basic level.".to_string();
        let shape = vocab_field("Shape");
        let prompt = build_partition_prompt(&[colour, shape], &json!({"Object Name": "Bowl"}));
        // Per-field component definitions pin what "distinct" means per field…
        assert!(prompt.contains(
            "- Colour — a component is a distinct colour family visible on the artefact (red and crimson are one; two greys of one background are one). (guidance: Record at their basic level.)"
        ));
        assert!(prompt.contains(
            "- Shape — a component is a distinct overall form or silhouette (rectangular and rectangular cuboid are one)."
        ));
        // The artefact record reaches the judge (a cataloguer reads the row first).
        assert!(prompt.contains("<artefact_file>"));
        assert!(prompt.contains(">Bowl<"));
        // …and the material clause forbids part-splitting and variety-splitting.
        let material = vocab_field("Material");
        let prompt = build_partition_prompt(&[material], &json!({}));
        assert!(prompt.contains("parts are not materials"));
        assert!(prompt.contains("exactly one material component"));
        // The reply contract and the kind-vs-specificity rule are present.
        assert!(prompt.contains("<components field="));
        assert!(prompt.contains("never a variety of the same kind"));
        // Quota-free: the builder takes no cap, so no cap language can appear.
        assert!(!prompt.contains("at most 3"));
    }

    #[test]
    fn partition_prompt_falls_back_to_generic_clause_for_unknown_fields() {
        let custom = vocab_field("Curatorial category");
        let prompt = build_partition_prompt(&[custom], &json!({}));
        assert!(prompt.contains(
            "- Curatorial category — a component is one genuinely distinct kind of thing for this field — never a variety of the same kind."
        ));
    }
}
