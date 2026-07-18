import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import { parseArtefactFile } from "./spreadsheet";
import { _DEF } from "../app/defaults";
import type { Settings } from "../app/types";

/** Minimal settings: only artefactFields is consulted by parseArtefactFile. */
function settings(fieldNames: string[]): Settings {
  return {
    ..._DEF(),
    artefactFields: fieldNames.map((name, i) => ({
      id: `af${i + 1}`,
      name,
      description: "",
      prompt: "",
      includeInExport: true,
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
    // Image column never enters the record; its bytes go to vision separately.
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
});
