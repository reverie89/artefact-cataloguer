// Vocab/field display helpers. The styling helpers that used to live here
// (tabSty, lBtnSty, nfBtnSty, reqSty, parseBtnStyle) have been replaced by the
// global .ui-* classes in styles/ui.css — components now apply those classes
// directly instead of computing inline style objects.

import { _VT } from "./defaults";
import type { CatalogueField, VocabList } from "./types";

/** Resolve a vocab list's display name (falls back to filename stem). */
export function displayName(vl: VocabList): string {
  return vl.name || vl.filename.replace(/\.[^.]+$/, "");
}

/** One resolved vocab source: the list it came from plus its flattened terms
 *  (built-in defaults fill in when a list has no uploaded termData). */
interface ResolvedVocabSource {
  list: VocabList;
  terms: string[];
}

/** Walk a field's vocabSources, joining each id to its list and flattening the
 *  terms. Single owner of the vocabSources→termData traversal shared by the AI
 *  prompt builder (`allowedTerms`) and the display helper (`vterms`). */
export function resolveVocabSources(field: CatalogueField, lists: VocabList[]): ResolvedVocabSource[] {
  const out: ResolvedVocabSource[] = [];
  for (const sid of field.vocabSources || []) {
    const vl = lists.find((v) => v.id === sid);
    if (!vl) continue;
    out.push({ list: vl, terms: vl.termData || _VT[sid] || [] });
  }
  return out;
}

/** Flatten a vocab field's sources into [{term, listName}]. */
export function vterms(field: CatalogueField, lists: VocabList[]): { term: string; listName: string }[] {
  const out: { term: string; listName: string }[] = [];
  for (const { list, terms } of resolveVocabSources(field, lists)) {
    const nm = displayName(list);
    for (const t of terms) out.push({ term: t, listName: nm });
  }
  return out;
}
