import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import { columnLetterToIndex, parseArtefactFile, recordValueFor } from "./spreadsheet";
import { _DEF } from "../app/defaults";
import type { Settings } from "../app/types";

/** Minimal settings: only artefactFields is consulted by parseArtefactFile.
 *  Header-text identification (the default) for every field. */
function settings(fieldNames: string[]): Settings {
  return {
    ..._DEF(),
    artefactFields: fieldNames.map((name, i) => ({
      id: `af${i + 1}`,
      name,
      description: "",
      prompt: "",
      includeForAI: true,
      includeInExport: true,
      useColumnLetter: false,
      column: "",
    })),
  };
}

/** Settings with per-field Identify By bindings: a `column` + useColumnLetter
 *  (default true for this factory) reads positionally; useColumnLetter false
 *  with a stored letter exercises the ignored-binding path. */
function boundSettings(bindings: { name: string; column?: string; useColumnLetter?: boolean }[]): Settings {
  return {
    ..._DEF(),
    artefactFields: bindings.map((b, i) => ({
      id: `af${i + 1}`,
      name: b.name,
      description: "",
      prompt: "",
      includeForAI: true,
      includeInExport: true,
      useColumnLetter: b.useColumnLetter ?? true,
      column: b.column ?? "",
    })),
  };
}

/** Build an in-memory .xlsx from an array-of-arrays and return it as a File. */
async function xlsxFile(rows: unknown[][], filename = "test.xlsx"): Promise<File> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRows(rows);
  const buf = await wb.xlsx.writeBuffer();
  return new File([buf], filename);
}

describe("recordValueFor", () => {
  it("matches keys case-insensitively with whitespace runs collapsed; missing → empty string", () => {
    const record = { "Curator's\nObj. Type": "bronze", "ACCESSION  NO": "X.1" };
    expect(recordValueFor(record, "Curator's Obj. Type")).toBe("bronze");
    expect(recordValueFor(record, "accession no")).toBe("X.1");
    expect(recordValueFor(record, "Material")).toBe("");
  });
});

describe("parseArtefactFile", () => {
  it("assigns unique, non-empty uids and records every non-image column", async () => {
    const headers = ["Obj. Number", "Title", "Category"];
    const file = await xlsxFile([
      headers,
      ["A1", "Cup", "Ceramics"],
      ["", "Bowl", "Ceramics"],
      ["A1", "Plate", "Ceramics"],
    ]);

    const { rows } = await parseArtefactFile(file, settings(headers));

    expect(rows).toHaveLength(3);
    // record carries the source values verbatim, keyed by header casing.
    expect(rows[0].record).toEqual({ "Obj. Number": "A1", Title: "Cup", Category: "Ceramics" });
    expect(rows[1].record).toEqual({ Title: "Bowl", Category: "Ceramics" });
    expect(rows[2].record).toEqual({ "Obj. Number": "A1", Title: "Plate", Category: "Ceramics" });
    // uid is always populated and unique — the identity this row is keyed by.
    const uids = rows.map((r) => r.uid);
    uids.forEach((u) => expect(u).toBeTruthy());
    expect(new Set(uids).size).toBe(uids.length);
  });

  it("strips the Image column from the record but flags its row index", async () => {
    const headers = ["Object Name", "Image"];
    const file = await xlsxFile([
      headers,
      ["Cup", "(image present)"],
      ["Bowl", ""],
    ]);

    const { rows, imageRowIndices } = await parseArtefactFile(file, settings(headers));

    expect(rows).toHaveLength(2);
    // Image column never enters the record; its bytes go to artefact analysis separately.
    expect(rows[0].record).toEqual({ "Object Name": "Cup" });
    expect(rows[1].record).toEqual({ "Object Name": "Bowl" });
    // Only the first row had a visible Image cell value.
    expect(imageRowIndices).toEqual([0]);
  });

  it("skips fully-empty phantom rows and reports the sheet-row → data-row map", async () => {
    // Simulate the reported bug: 2 real rows + trailing/interleaved empty rows
    // that inflate ws.rowCount. Touching a far-down cell extends the sheet
    // dimension the same way stray formatting does in real workbooks.
    const headers = ["Object Name", "Title"];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRows([
      headers,
      ["Cup", "A"],
      ["Bowl", "B"],
    ]);
    // Touch a cell on sheet row 7 (data row 6) without giving it a value — this
    // bumps ws.rowCount past the real data, mirroring a stale <dimension>.
    ws.getCell("A7").value = null;
    const buf = await wb.xlsx.writeBuffer();
    const file = new File([buf], "phantom.xlsx");

    const { rows, sheetRowToDataRow } = await parseArtefactFile(file, settings(headers));

    // Only the 2 genuine rows survive — phantom rows 3..7 do not become rows.
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.record?.["Object Name"])).toEqual(["Cup", "Bowl"]);
    // sheetRowToDataRow is indexed by 1-based sheet row:
    //   1 (header) -> -1, 2 -> 0, 3 -> 1, 4..7 (empty) -> -1.
    expect(sheetRowToDataRow[1]).toBe(-1);
    expect(sheetRowToDataRow[2]).toBe(0);
    expect(sheetRowToDataRow[3]).toBe(1);
    expect(sheetRowToDataRow[4]).toBe(-1);
    expect(sheetRowToDataRow[7]).toBe(-1);
  });

  it("skips an interleaved empty row, keeping later rows attributed correctly", async () => {
    // 3 real data rows with an empty row in the middle (sheet row 3 empty).
    const headers = ["Object Name"];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRows([
      headers,
      ["Cup"],
      [null],
      ["Bowl"],
      ["Plate"],
    ]);
    const buf = await wb.xlsx.writeBuffer();
    const file = new File([buf], "interleaved.xlsx");

    const { rows, sheetRowToDataRow } = await parseArtefactFile(file, settings(headers));

    // The middle empty row is dropped; the later two still map to their data
    // indices, so an embedded image anchored at sheet row 5 attributes to the
    // 3rd data row (Plate), not a stale position. Index 0 is unused (1-based
    // sheet-row indexing); index 1 is the header.
    expect(rows.map((r) => r.record?.["Object Name"])).toEqual(["Cup", "Bowl", "Plate"]);
    expect(sheetRowToDataRow).toEqual([undefined, -1, 0, -1, 1, 2]);
  });

  it("matches headers despite interior whitespace differences (wrapped cells)", async () => {
    // Real-world case: the source system writes header text wrapped inside the
    // cell ("Object Name⏎Title") while the configured name is single-line.
    const file = await xlsxFile([
      ["Object Name\nTitle", "Creator"],
      ["Cup", "Lee"],
    ]);

    const { rows, missingColumns } = await parseArtefactFile(file, settings(["Object Name Title"]));

    expect(missingColumns).toEqual([]);
    expect(rows).toHaveLength(1);
    // Record keys stay the sheet's own header casing.
    expect(Object.keys(rows[0].record ?? {})).toContain("Object Name\nTitle");
    expect(Object.values(rows[0].record ?? {})).toContain("Cup");
  });

  it("flags repeated header names as column problems in both modes", async () => {
    const file = await xlsxFile([
      ["Material", "Material", "Title"],
      ["bronze", "clay", "Cup"],
    ]);

    const byName = await parseArtefactFile(file, settings(["Material", "Title"]));
    expect(byName.columnProblems).toEqual(["Duplicate column header: Material"]);

    const byLetter = await parseArtefactFile(file, boundSettings([
      { name: "Material", column: "A" },
      { name: "Title", column: "C" },
    ]));
    expect(byLetter.columnProblems).toEqual(["Duplicate column header: Material"]);
  });

  it("resolves rich-text header cells to their plain text", async () => {
    // Real-world case: headers whose tail is bold/red (e.g. "[NOT Published
    // info]") are stored as rich-text runs; String() of those cells used to
    // yield "[object Object]", breaking matching and inventing duplicates.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.getCell("A1").value = "Material";
    ws.getCell("B1").value = {
      richText: [
        { text: "Hist. Signi " },
        { text: "[NOT Published info]", font: { bold: true, color: { argb: "FFFF0000" } } },
      ],
    };
    ws.addRow(["bronze", "fine piece"]);
    const buf = await wb.xlsx.writeBuffer();
    const file = new File([buf], "rich.xlsx");

    const { rows, missingColumns, columnProblems } = await parseArtefactFile(
      file,
      settings(["Material", "Hist. Signi [NOT Published info]"]),
    );

    expect(missingColumns).toEqual([]);
    expect(columnProblems).toEqual([]);
    expect(rows[0].record).toEqual({ Material: "bronze", "Hist. Signi [NOT Published info]": "fine piece" });
  });
});

describe("parseArtefactFile with column bindings", () => {
  it("reads Column Letter fields positionally and Header Text fields by name", async () => {
    const file = await xlsxFile([
      ["Object Name", "Some Header B", "Title"],
      ["Cup", "ignored", "Lee"],
    ]);

    // Title is identified by Column Letter C; Object Name by Header Text.
    const { rows, missingColumns, columnProblems } = await parseArtefactFile(file, boundSettings([
      { name: "Title", column: "C" },
      { name: "Object Name", useColumnLetter: false },
    ]));

    expect(missingColumns).toEqual([]);
    expect(columnProblems).toEqual([]);
    // Letter fields are keyed by the configured name; header-text fields by
    // the sheet's own header; unbound columns keep their header text.
    expect(rows[0].record).toEqual({ Title: "Lee", "Object Name": "Cup", "Some Header B": "ignored" });
  });

  it("flags a Column Letter field with no letter assigned", async () => {
    const file = await xlsxFile([["Object Name"], ["Cup"]]);

    const { missingColumns, columnProblems } = await parseArtefactFile(file, boundSettings([
      { name: "Object Name", useColumnLetter: false },
      { name: "Unassigned", column: "" },
    ]));

    expect(missingColumns).toEqual([]);
    expect(columnProblems).toEqual(["No spreadsheet column assigned for: Unassigned"]);
  });

  it("ignores a stored letter when the field identifies by Header Text", async () => {
    // The letter would match ("B" header), but the field identifies by Header
    // Text — and no header carries its configured name, so it is missing.
    const file = await xlsxFile([
      ["B"],
      ["Lee"],
    ]);

    const { missingColumns, columnProblems } = await parseArtefactFile(file, boundSettings([
      { name: "Material", column: "A", useColumnLetter: false },
    ]));

    expect(missingColumns).toEqual(["Material"]);
    expect(columnProblems).toEqual([]);
  });

  it("excludes a bound image column from records but keeps the row hint", async () => {
    const file = await xlsxFile([
      ["Object Name", "Picture"],
      ["Cup", "(image present)"],
      ["Bowl", ""],
    ]);

    const { rows, imageRowIndices, discardedColumns } = await parseArtefactFile(file, boundSettings([
      { name: "Object Name", useColumnLetter: false },
      { name: "Image", column: "B" },
    ]));

    expect(rows[0].record).toEqual({ "Object Name": "Cup" });
    expect(imageRowIndices).toEqual([0]);
    expect(discardedColumns["Image"]).toBe("image bytes (sent to the AI separately)");
  });

  it("reports invalid, out-of-range, colliding, and overlapping bindings", async () => {
    const file = await xlsxFile([
      ["Object Name", "B"],
      ["Cup", "Lee"],
    ]);

    const { missingColumns, columnProblems } = await parseArtefactFile(file, boundSettings([
      { name: "Assigned", column: "B" },
      { name: "Invalid", column: "1A" },
      { name: "Out of range", column: "AB" },
      { name: "Collides", column: "b" },
      { name: "B", useColumnLetter: false }, // name-matches column B, already claimed
    ]));

    expect(missingColumns).toEqual([]);
    expect(columnProblems).toEqual([
      'Column "1A" is not a valid Excel column letter for: Invalid',
      'Column "AB" is outside the sheet for: Out of range',
      'Fields "Assigned" and "Collides" are both bound to column B',
      'Fields "Assigned" and "B" both resolve to the same column',
    ]);
  });
});

describe("columnLetterToIndex", () => {
  it("converts letters case-insensitively and rejects non-letters", () => {
    expect(columnLetterToIndex("A")).toBe(1);
    expect(columnLetterToIndex("c")).toBe(3);
    expect(columnLetterToIndex("Z")).toBe(26);
    expect(columnLetterToIndex("AA")).toBe(27);
    expect(columnLetterToIndex(" ZZ ")).toBe(702);
    expect(columnLetterToIndex("")).toBeNull();
    expect(columnLetterToIndex("1")).toBeNull();
    expect(columnLetterToIndex("A1")).toBeNull();
    expect(columnLetterToIndex("AAA")).toBeNull();
  });
});
