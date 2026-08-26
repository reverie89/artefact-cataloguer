//! Prompt construction for the two LLM calls: the unified vision-analysis
//! prompt (persona preamble, per-column guidance, XML field enumeration,
//! `<artefact_file>` record) and the validation prompt (pure candidate terms +
//! the fixed `<validated>` reply contract), plus the record→XML rendering and
//! escaping helpers they build on.

use serde_json::Value;
use std::collections::HashMap;

use super::types::{ArtefactColumnSpec, FieldSpec, NetCandidate};

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

/// Compose the validation prompt. For each vocab field: the field name,
/// its extracted text (from vision analysis), an optional per-field `prompt`
/// (e.g. user preferences), and a list of its candidate **terms only** — no
/// cosine, no thesaurus badge, to avoid biasing the model toward internal
/// scores. Ends with the fixed XML reply contract. Pure; built once per
/// catalogue call.
pub(crate) fn build_validation_prompt(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::types::fixtures::{column, open_field, vocab_field};
    use crate::ai::types::{FieldSpec, NetCandidate};
    use serde_json::json;

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
}
