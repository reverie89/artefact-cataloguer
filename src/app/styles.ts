// Vocab/field display helpers. The styling helpers that used to live here
// (tabSty, lBtnSty, nfBtnSty, reqSty, parseBtnStyle) have been replaced by the
// global .ui-* classes in styles/ui.css — components now apply those classes
// directly instead of computing inline style objects.

import type { VocabTermEntry } from "../lib/vocab";
import type { CatalogueField, VocabSource } from "./types";

/** Resolve a vocab source's display name (falls back to "Untitled source"). */
export function displayName(vs: VocabSource): string {
  return vs.name || "Untitled source";
}

/** Look up a term's configured column (label/badge), falling back to the
 *  term itself when the column isn't in `entry.columns` — which is exactly
 *  what happens when the configured column *is* the ingestion column (it's
 *  excluded from `columns` since its value is already `entry.term`; see
 *  `ParsedRow.columns` in src-tauri/src/vocab_files.rs). `null` (no column
 *  configured) resolves to `null`, not the term — callers decide their own
 *  "no column configured" fallback. */
function resolveColumn(entry: VocabTermEntry, fieldName: string | null): string | null {
  if (!fieldName) return null;
  return entry.columns[fieldName] ?? entry.term;
}

/** Flatten a vocab field's sources into [{term, label, badge, listName}] for
 *  the manual term-pick dropdown, reading each source's full term list from
 *  `termCache` (populated on demand by `ensureVocabTermsLoaded` — see
 *  app/actions.ts — via the Rust `list_vocab_terms` command). `label`/`badge`
 *  resolve the source's configured `labelField`/`badgeField` per term —
 *  `label` falls back to the bare term when unset, `badge` is `null` when
 *  unset (no badge shown). A source not yet cached (never synced, or fetch
 *  still in flight) simply contributes nothing yet. */
export function vterms(
  field: CatalogueField,
  sources: VocabSource[],
  termCache: Record<string, VocabTermEntry[]>
): { term: string; label: string; badge: string | null; listName: string }[] {
  const out: { term: string; label: string; badge: string | null; listName: string }[] = [];
  for (const sid of field.vocabSources || []) {
    const vs = sources.find((v) => v.id === sid);
    if (!vs) continue;
    const nm = displayName(vs);
    for (const entry of termCache[sid] || []) {
      const label = resolveColumn(entry, vs.labelField) ?? entry.term;
      const badge = resolveColumn(entry, vs.badgeField);
      out.push({ term: entry.term, label, badge, listName: nm });
    }
  }
  return out;
}
