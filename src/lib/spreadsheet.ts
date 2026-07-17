// Spreadsheet parsing via SheetJS. Reads uploaded .xlsx artefact files into
// artefact rows. Vocabulary source files are parsed/streamed on the Rust side
// instead (src-tauri/src/vocab_files.rs) — they can be 15MB+/millions of rows,
// which client-side XLSX.js parsing (holding the whole file + a flat term
// array in memory) cannot scale to. See lib/vocab.ts for the staging calls.
//
// The artefact "Image" column holds an embedded image object; extracting its
// bytes is handled by images.ts (which unpacks the .xlsx zip + drawings).
// Normal cell parsing cannot see embedded images, so any non-empty Image cell
// value is only a hint; drawing anchors remain the source of truth.

import * as XLSX from "xlsx";
import type { ArtefactField, ArtefactRow, Settings } from "../app/types";
import { gid } from "../app/defaults";

export interface ParsedArtefactFile {
  rows: ArtefactRow[];
  /** Row indices (0-based data rows) that carry an Image cell value hint. */
  imageRowIndices: number[];
  /** Names of required columns missing from the sheet, if any. */
  missingColumns: string[];
  /** Columns dropped from the AI record, mapped name → reason. The Image column
   *  is excluded (its bytes go to vision separately) and fully-empty columns
   *  carry nothing for the model. */
  discardedColumns: Record<string, string>;
}

/**
 * Resolve the role column names from the configured artefact fields. The id,
 * title, category and image columns are identified by matching a configured
 * field's name (case-insensitive) against each role's canonical name. This is
 * the *only* place the parser knows which column fills which structured slot —
 * everything else comes from `settings.artefactFields`. Returns the configured
 * field name (or undefined if no field matches that role).
 */
export function roleFieldNames(afFields: ArtefactField[]): { id?: string; title?: string; category?: string; image?: string } {
  const find = (re: RegExp) => afFields.find((f) => re.test(f.name.trim().toLowerCase()))?.name;
  return {
    // "Obj. Number" is the app default; "Accession No/Number" is still recognised
    // because existing museum spreadsheets/configs use that standard term.
    id: find(/^(accession\s*|obj(ect)?\.?\s*)(no|number)\.?$/),
    title: find(/^title$/),
    category: find(/^categor(y|ies)$/),
    image: find(/^images?$/),
  };
}

/** Parse a .xlsx artefact workbook into artefact rows. */
export async function parseArtefactFile(file: File, settings: Settings): Promise<ParsedArtefactFile> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const firstSheet = wb.SheetNames[0];
  const ws = wb.Sheets[firstSheet];

  // Array-of-objects with header row as keys.
  const json: Record<string, unknown>[] = XLSX.utils.sheet_to_json(ws, { defval: "" });

  const afFields: ArtefactField[] = settings.artefactFields || [];
  const roles = roleFieldNames(afFields);
  const imageKey = roles.image ? roles.image.toLowerCase() : undefined;

  // Every configured column is required; read strictly from config, no aliases.
  const required = afFields.map((a) => a.name);
  const present = json.length ? Object.keys(json[0]) : [];
  const missingColumns = required.filter((r) => !present.some((p) => p.toLowerCase() === r.toLowerCase()));

  const rows: ArtefactRow[] = [];
  const imageRowIndices: number[] = [];

  json.forEach((obj) => {
    const get = (name: string | undefined) => {
      if (!name) return "";
      const key = Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());
      return key ? String(obj[key] ?? "") : "";
    };

    // Record all non-image source columns for the detail panel + AI payload.
    const record: Record<string, string> = {};
    Object.entries(obj).forEach(([k, v]) => {
      if (imageKey && k.toLowerCase() === imageKey) return;
      if (v !== "" && v != null) record[k] = String(v);
    });

    rows.push({
      uid: gid(),
      id: get(roles.id),
      title: get(roles.title),
      category: get(roles.category),
      status: "queued",
      record,
    });

    // Flag rows whose Image column has a visible cell value. Embedded-only
    // images usually leave this blank; images.ts resolves those by anchor.
    if (imageKey) {
      const k = Object.keys(obj).find((ck) => ck.toLowerCase() === imageKey);
      if (k && obj[k] !== "" && obj[k] != null) imageRowIndices.push(rows.length - 1);
    }
  });

  // Columns dropped from the AI record: the Image column (bytes go to vision
  // separately) and any header with no non-empty values across every row.
  const discardedColumns: Record<string, string> = {};
  if (imageKey) {
    const imgCol = present.find((p) => p.toLowerCase() === imageKey);
    if (imgCol) discardedColumns[imgCol] = "image bytes (sent to vision separately)";
  }
  for (const col of present) {
    if (discardedColumns[col]) continue;
    const allEmpty = json.every((obj) => {
      const v = obj[col];
      return v === "" || v == null;
    });
    if (allEmpty) discardedColumns[col] = "empty across all rows";
  }

  return { rows, imageRowIndices, missingColumns, discardedColumns };
}
