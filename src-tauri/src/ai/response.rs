//! Parsing the LLM's XML response contract into domain values: the unified
//! vision-analysis reply (`<image_description>` / `<extraction>` /
//! `<open_field>` blocks) and validation's `<validated><pick term="…" />`
//! reply, plus the fence-stripping and tag-walking primitives they share.

use std::collections::HashMap;

use super::types::FieldSpec;

/// Strip a leading/trailing Markdown code fence (``` or ~~~, with optional
/// language tag) if present. The XML parsers tolerate fences so a model that
/// wraps its answer despite being told not to still parses cleanly.
pub(crate) fn strip_code_fence(s: &str) -> &str {
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
pub(crate) struct UnifiedParse {
    pub(crate) extractions: HashMap<String, String>,
    pub(crate) open_values: HashMap<String, String>,
    pub(crate) warnings: Vec<String>,
}

/// Find the substring of `haystack` between the first `<tag ...>` and its
/// matching `</tag>`, honoring the case-insensitive tag name. Attributes on the
/// open tag are allowed (e.g. `<extraction field="Material">`). Returns the
/// inner text (between the tags), trimmed. `None` if the tag pair isn't found.
pub(crate) fn extract_tag_block<'a>(haystack: &'a str, tag: &str) -> Option<&'a str> {
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
pub(crate) fn parse_unified_response(content: &str, fields: &[FieldSpec]) -> UnifiedParse {
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
pub(crate) fn looks_like_unrecognized_response(content: &str) -> bool {
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
pub(crate) fn parse_validation_response(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::types::fixtures::{open_field, vocab_field};
    use std::collections::HashMap;

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
}
