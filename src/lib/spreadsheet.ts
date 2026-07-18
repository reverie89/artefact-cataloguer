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
  /** Names of required columns missing from the sheet, if any. */
  missingColumns: string[];
  /** Columns dropped from the AI record, mapped name → reason. The Image column
   *  is excluded (its bytes go to vision separately) and fully-empty columns
   *  carry nothing for the model. */
  discardedColumns: Record<string, string>;
  /** Indexed by 1-based sheet row; value = 0-based data-row index, or -1 if the
   *  row was skipped as fully-empty. Used to attribute embedded images, whose
   *  anchors carry raw sheet rows, to the post-skip data array. Index 0 (the
   *  header row) is -1. */
  sheetRowToDataRow: number[];
}

/** Resolve the image role column name from the configured artefact fields. The
 *  image column is identified by matching a configured field's name
 *  (case-insensitive) against the canonical name. This is the *only* role the
 *  parser still resolves — id/title/category used to be resolved here too, but
 *  with those structured fields dropped from `ArtefactRow`, the search filter
 *  and export both read `record` directly. Returns the configured field name
 *  (or undefined if no field matches). */
export function roleFieldNames(afFields: ArtefactField[]): { image?: string } {
  const find = (re: RegExp) => afFields.find((f) => re.test(f.name.trim().toLowerCase()))?.name;
  return {
    image: find(/^images?$/),
  };
}

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

/** Parse a .xlsx artefact workbook into artefact rows. */
export async function parseArtefactFile(file: File, settings: Settings): Promise<ParsedArtefactFile> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  if (!ws) return { rows: [], imageRowIndices: [], missingColumns: [], discardedColumns: {}, sheetRowToDataRow: [] };

  // Header row — ExcelJS is 1-based; row 1 carries the configured column names.
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  for (let c = 1; c <= headerRow.cellCount; c++) {
    headers.push(String(headerRow.getCell(c).value ?? "").trim());
  }

  const afFields: ArtefactField[] = settings.artefactFields || [];
  const imageKey = roleFieldNames(afFields).image?.toLowerCase();

  // Every configured column is required; read strictly from config, no aliases.
  const required = afFields.map((a) => a.name);
  const present = headers.filter((h) => h.length > 0);
  const missingColumns = required.filter((r) => !present.some((p) => p.toLowerCase() === r.toLowerCase()));

  // Read data rows (row 2 onward) into array-of-objects keyed by the header.
  // ExcelJS returns empty cells as null; we omit them from the object so the
  // record stays sparse, matching the previous SheetJS `defval: ""` behaviour
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
      const h = headers[c - 1];
      if (!h) continue;
      const v = cellToString(row.getCell(c).value);
      if (v !== "") obj[h] = v;
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
    // Record all non-image source columns for the detail panel + AI payload.
    const record: Record<string, string> = {};
    Object.entries(obj).forEach(([k, v]) => {
      if (imageKey && k.toLowerCase() === imageKey) return;
      if (v !== "" && v != null) record[k] = String(v);
    });

    rows.push({
      uid: gid(),
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

  return { rows, imageRowIndices, missingColumns, discardedColumns, sheetRowToDataRow };
}
