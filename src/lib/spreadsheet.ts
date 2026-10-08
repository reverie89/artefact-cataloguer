// Spreadsheet parsing via ExcelJS. Reads uploaded .xlsx artefact files into
// artefact rows. Vocabulary source files are parsed/streamed on the Rust side
// instead (src-tauri/src/vocab_files.rs) — they can be 15MB+/millions of rows,
// which client-side XLSX.js parsing (holding the whole file + a flat term
// array in memory) cannot scale to. See lib/vocab.ts for the staging calls.
//
// The artefact "Image" column holds an embedded image object; extracting its
// bytes is handled by images.ts (which unpacks the .xlsx zip + drawings).
// ExcelJS's image-read (getImages) is unreliable across file origins, so cell
// parsing stays here while image extraction keeps its own fflate path.
// Normal cell parsing cannot see embedded images, so any non-empty Image cell
// value is only a hint; drawing anchors remain the source of truth.

import ExcelJS from "exceljs";
import type { ArtefactField, ArtefactRow, Settings } from "../app/types";
import { gid } from "../app/defaults";

export interface ParsedArtefactFile {
  rows: ArtefactRow[];
  /** Row indices (0-based data rows) that carry an Image cell value hint. */
  imageRowIndices: number[];
  /** Names of required columns missing from the sheet, if any — in letter
   *  mode, names of fields with no usable column binding. */
  missingColumns: string[];
  /** Structural problems that make the file unusable regardless of mode:
   *  repeated header names, two fields bound to the same column letter. */
  columnProblems: string[];
  /** Columns dropped from the record, mapped name → reason. The Image column
   *  is excluded (its bytes go to artefact analysis separately) and fully-empty columns
   *  carry nothing for the panel or the model. */
  discardedColumns: Record<string, string>;
  /** Indexed by 1-based sheet row; value = 0-based data-row index, or -1 if the
   *  row was skipped as fully-empty. Used to attribute embedded images, whose
   *  anchors carry raw sheet rows, to the post-skip data array. Index 0 (the
   *  header row) is -1. */
  sheetRowToDataRow: number[];
}

/** Canonical name of the image role column, matched against configured field
 *  names (case-insensitive). This is the *only* role the parser still resolves
 *  — id/title/category used to be resolved here too, but with those structured
 *  fields dropped from `ArtefactRow`, the search filter and export both read
 *  `record` directly. */
const IMAGE_NAME_RE = /^images?$/;

/** Collapse an ExcelJS cell value to its display string. ExcelJS returns
 *  primitives for plain cells but a `{ text, richText, result, hyperlink }`
 *  object for rich cells; we want the visible text in every case. Numbers,
 *  booleans, and dates stringify naturally. */
function cellToString(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if ("text" in v) return String(v.text ?? "");
    if ("result" in v) return String(v.result ?? "");
    if ("hyperlink" in v) return String(v.hyperlink ?? "");
  }
  return String(v);
}

/** Excel column letters ("A", "Z", "AA"…) → 1-based column index; null when
 *  the text is not a plausible letter binding. */
export function columnLetterToIndex(letter: string): number | null {
  const s = letter.trim().toUpperCase();
  if (!/^[A-Z]{1,2}$/.test(s)) return null;
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** Parse a .xlsx artefact workbook into artefact rows. Columns are identified
 *  either by row-1 header text (`artefactColumnMode: "name"`) or positionally,
 *  by each configured field's bound Excel letter (`"letter"`). */
export async function parseArtefactFile(file: File, settings: Settings): Promise<ParsedArtefactFile> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  if (!ws) return { rows: [], imageRowIndices: [], missingColumns: [], columnProblems: [], discardedColumns: {}, sheetRowToDataRow: [] };

  // Header row — ExcelJS is 1-based; row 1 carries the configured column names.
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  for (let c = 1; c <= headerRow.cellCount; c++) {
    headers.push(String(headerRow.getCell(c).value ?? "").trim());
  }

  const afFields: ArtefactField[] = settings.artefactFields || [];

  // Header comparisons collapse whitespace runs (spaces, newlines, NBSP):
  // source headers wrap inside the cell ("Curator's\nObj. Type") while
  // configured names may be entered single-line.
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

  // A repeated header would silently corrupt the keyed record (the later
  // column overwrites the earlier one), so it is rejected in both modes.
  const columnProblems: string[] = [];
  const seenHeaders = new Map<string, string>();
  for (const h of headers) {
    if (!h) continue;
    const first = seenHeaders.get(norm(h));
    if (first !== undefined) columnProblems.push(`Duplicate column header: ${first}`);
    else seenHeaders.set(norm(h), h);
  }

  // Resolve what each column is keyed as in the record, and which column is
  // the image role. Name mode keys columns by their header (every configured
  // name must appear among them); letter mode keys bound columns by the
  // configured field name — the AI gate, export, and results search all look
  // records up by configured name — and unbound columns by their header.
  // Columns with no identifiable key (blank header, unbound) are skipped in
  // both modes.
  const missingColumns: string[] = [];
  // 1-based by column; index 0 unused. 0 imageColIndex = no image column.
  const colKeys: (string | null)[] = [];
  let imageColIndex = 0;
  if ((settings.artefactColumnMode ?? "name") === "letter") {
    const imageField = afFields.find((f) => IMAGE_NAME_RE.test(f.name.trim().toLowerCase()));
    const bound = new Map<number, string>();
    for (const f of afFields) {
      const idx = f.column ? columnLetterToIndex(f.column) : null;
      if (idx === null || idx > headers.length) {
        missingColumns.push(f.name);
        continue;
      }
      const other = bound.get(idx);
      if (other !== undefined) {
        columnProblems.push(`Fields "${other}" and "${f.name}" are both bound to column ${f.column.trim().toUpperCase()}`);
        continue;
      }
      bound.set(idx, f.name);
      colKeys[idx] = f.name;
      if (f === imageField) imageColIndex = idx;
    }
    for (let c = 1; c <= headers.length; c++) {
      if (!colKeys[c]) colKeys[c] = headers[c - 1] || null;
    }
  } else {
    // Every configured column is required; read strictly from config, no aliases.
    const present = headers.filter((h) => h.length > 0);
    for (const a of afFields) {
      if (!present.some((p) => norm(p) === norm(a.name))) missingColumns.push(a.name);
    }
    const imageName = afFields.find((f) => IMAGE_NAME_RE.test(f.name.trim().toLowerCase()))?.name;
    if (imageName) imageColIndex = headers.findIndex((h) => h && norm(h) === norm(imageName)) + 1;
    for (let c = 1; c <= headers.length; c++) {
      colKeys[c] = headers[c - 1] || null;
    }
  }
  const imageKey = imageColIndex > 0 ? colKeys[imageColIndex] : null;

  // Read data rows (row 2 onward) into array-of-objects keyed by the column's
  // record key. ExcelJS returns empty cells as null; we omit them from the
  // object so the record stays sparse, matching the previous SheetJS `defval: ""` behaviour
  // only for non-empty cells.
  //
  // ExcelJS's `ws.rowCount` tracks the last *touched* row (formatting, merged
  // ranges, stale <dimension>), not the last row with data, so the loop must
  // skip fully-empty rows — otherwise trailing/interleaved phantom rows
  // inflate `rows` with blank `record: {}` entries (a 2-data-row file would
  // emit e.g. 6 ArtefactRows). `sheetRowToDataRow` records the sheet-row →
  // data-row-index mapping so embedded images, whose drawing anchors carry raw
  // sheet rows, still attribute to the correct post-skip artefact (images.ts).
  const json: Record<string, string>[] = [];
  // Indexed by 1-based sheet row. Index 0 is unused; index 1 (header) is -1.
  // (Sparse — index 0 stays a hole — so consumers index by sheet row directly.)
  const sheetRowToDataRow: number[] = [];
  sheetRowToDataRow[1] = -1;
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const obj: Record<string, string> = {};
    for (let c = 1; c <= headers.length; c++) {
      const k = colKeys[c];
      if (!k) continue;
      const v = cellToString(row.getCell(c).value);
      if (v !== "") obj[k] = v;
    }
    if (Object.keys(obj).length === 0) {
      sheetRowToDataRow[r] = -1;
      continue;
    }
    sheetRowToDataRow[r] = json.length;
    json.push(obj);
  }

  const rows: ArtefactRow[] = [];
  const imageRowIndices: number[] = [];

  json.forEach((obj) => {
    // Record all non-image source columns for the source record panel (+ export).
    // The AI payload is bounded separately — to configured Include-for-AI
    // columns — at the catalogueArtefact boundary (lib/ai.ts recordForAI).
    const record: Record<string, string> = {};
    Object.entries(obj).forEach(([k, v]) => {
      if (k === imageKey) return;
      if (v !== "" && v != null) record[k] = String(v);
    });

    rows.push({
      uid: gid(),
      status: "queued",
      record,
    });

    // Flag rows whose Image column has a visible cell value. Embedded-only
    // images usually leave this blank; images.ts resolves those by anchor.
    if (imageKey && obj[imageKey] !== "" && obj[imageKey] != null) imageRowIndices.push(rows.length - 1);
  });

  // Columns dropped from the record: the Image column (bytes go to artefact analysis
  // separately) and any column with no non-empty values across every row.
  const discardedColumns: Record<string, string> = {};
  if (imageKey) discardedColumns[imageKey] = "image bytes (sent to the AI separately)";
  for (let c = 1; c <= headers.length; c++) {
    const label = colKeys[c];
    if (!label || label === imageKey) continue;
    const allEmpty = json.every((obj) => {
      const v = obj[label];
      return v === "" || v == null;
    });
    if (allEmpty) discardedColumns[label] = "empty across all rows";
  }

  return { rows, imageRowIndices, missingColumns, columnProblems, discardedColumns, sheetRowToDataRow };
}
