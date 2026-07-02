import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { parseArtefactFile } from "./spreadsheet";
import type { Settings } from "../app/types";

/** Minimal settings: only artefactFields is consulted by parseArtefactFile. */
function settings(fieldNames: string[]): Settings {
  return {
    systemPromptInstruction: "",
    systemPromptContractOverride: "",
    fields: [],
    vocabularyLists: [],
    providers: [],
    activeProvider: null,
    artefactFields: fieldNames.map((name, i) => ({
      id: `af${i + 1}`,
      name,
      required: ["Obj. Number", "Title", "Category"].includes(name),
      description: "",
    })),
  };
}

/** Build an in-memory .xlsx from an array-of-arrays and return it as a File. */
function xlsxFile(rows: unknown[][], filename = "test.xlsx"): File {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new File([buf], filename);
}

describe("parseArtefactFile", () => {
  it("assigns unique, non-empty uids while id reflects the Accession No cell", async () => {
    const headers = ["Obj. Number", "Title", "Category"];
    const file = xlsxFile([
      headers,
      ["A1", "Cup", "Ceramics"],
      ["", "Bowl", "Ceramics"], // empty Accession No — the collision case
      ["A1", "Plate", "Ceramics"], // duplicate Accession No
    ]);

    const { rows } = await parseArtefactFile(file, settings(headers));

    expect(rows).toHaveLength(3);
    // id faithfully carries the cell value (possibly empty or duplicated).
    expect(rows.map((r) => r.id)).toEqual(["A1", "", "A1"]);
    // uid is always populated and unique — the identity this row is keyed by.
    const uids = rows.map((r) => r.uid);
    uids.forEach((u) => expect(u).toBeTruthy());
    expect(new Set(uids).size).toBe(uids.length);
  });
});
