import { describe, expect, it } from "vitest";

import { composeExportTable, csvSafeCell } from "./actions";
import { _DEF } from "./defaults";
import type { AiResults, ArtefactRow, FieldSelection, Settings } from "./types";

describe("csvSafeCell", () => {
  // OWASP CSV-formula-injection neutralization: a value whose first char is one
  // of the formula triggers gets a `'` prefix (Excel/LibreOffice/Sheets drop
  // the leading quote on display, treating the cell as text).
  const triggers = ["=", "+", "-", "@", "\t", "\r"];
  for (const trigger of triggers) {
    it(`prefixes a value starting with ${JSON.stringify(trigger)} with a single quote`, () => {
      const malicious = `${trigger}HYPERLINK("https://evil","click")`;
      const safe = csvSafeCell(malicious);
      expect(safe.startsWith("'")).toBe(true);
      // The payload is preserved verbatim after the quote (no content loss).
      expect(safe.slice(1)).toBe(malicious);
    });
  }

  it("prefixes the classic =cmd DDE payload", () => {
    expect(csvSafeCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
  });

  it("leaves normal values unchanged", () => {
    expect(csvSafeCell("bronze")).toBe("bronze");
    expect(csvSafeCell("Tang dynasty, 8th c. CE")).toBe("Tang dynasty, 8th c. CE");
    expect(csvSafeCell("a value with = inside")).toBe("a value with = inside");
    expect(csvSafeCell("plain text")).toBe("plain text");
  });

  it("does not prefix a value whose only special char is mid-string", () => {
    // Only a leading trigger is dangerous; mid-string `=`/`+`/`-`/`@` are inert.
    expect(csvSafeCell("price = 5")).toBe("price = 5");
    expect(csvSafeCell("a+b")).toBe("a+b");
    expect(csvSafeCell("a-b")).toBe("a-b");
    expect(csvSafeCell("name@example.com")).toBe("name@example.com");
  });

  it("handles empty and single-char strings", () => {
    expect(csvSafeCell("")).toBe("");
    expect(csvSafeCell("=")).toBe("'=");
    expect(csvSafeCell("a")).toBe("a");
  });
});

describe("composeExportTable", () => {
  // Build a minimal settings with one AF column (Material) and one catalogue
  // field (Place) so each test can flip flags and assert ordering without a
  // wall of fixture setup.
  function buildSettings(opts: { materialExport?: boolean; imageExport?: boolean } = {}): Settings {
    const s = _DEF();
    s.artefactFields = [
      { id: "af-m", name: "Material", description: "", prompt: "", includeInExport: opts.materialExport ?? true },
      { id: "af-i", name: "Image", description: "", prompt: "", includeInExport: opts.imageExport ?? true },
    ];
    s.fields = [{ id: "fp", name: "Place", type: "open", layout: "row", prompt: "", vocabSources: [] }];
    return s;
  }
  const rows: ArtefactRow[] = [
    { uid: "u1", status: "done", record: { Material: "bronze", Place: "ignored-in-record" } },
    { uid: "u2", status: "done", record: { material: "Ceramic" } }, // different casing key
    { uid: "u3", status: "queued", record: { Material: "gold" } }, // not done — excluded
  ];
  const aiResults: AiResults = {
    u1: { Place: [{ value: "Java" }] },
    u2: { Place: [{ value: "Bali" }] },
  };
  const fieldSelections: Record<string, FieldSelection> = {
    u1_fp: { source: "manual", value: "Jakarta", values: ["Jakarta"], listName: "", similarity: null },
  };

  it("returns null when zero AF columns are selected for export", () => {
    const table = composeExportTable(buildSettings({ materialExport: false, imageExport: false }), rows, aiResults, fieldSelections);
    expect(table).toBeNull();
  });

  it("emits AF columns before catalogue fields, in configured order", () => {
    const table = composeExportTable(buildSettings(), rows, aiResults, fieldSelections);
    expect(table).not.toBeNull();
    expect(table!.headers).toEqual(["Material", "Image", "Place"]);
  });

  it("reads AF values from the record with case-insensitive header lookup", () => {
    const table = composeExportTable(buildSettings(), rows, aiResults, fieldSelections)!;
    // Row u2's record key is lowercase "material"; it still resolves.
    expect(table.rows[0]).toEqual(["bronze", "", "Jakarta"]);
    expect(table.rows[1]).toEqual(["Ceramic", "", "Bali"]);
  });

  it("excludes only the AF columns toggled off (opt-out)", () => {
    const table = composeExportTable(buildSettings({ materialExport: false }), rows, aiResults, fieldSelections)!;
    expect(table.headers).toEqual(["Image", "Place"]);
    expect(table.rows[0]).toEqual(["", "Jakarta"]);
  });

  it("skips rows that are not done", () => {
    const table = composeExportTable(buildSettings(), rows, aiResults, fieldSelections)!;
    expect(table.rows).toHaveLength(2); // u3 (queued) excluded
  });

  it("identifies the image column by name for byte-embedding downstream", () => {
    expect(composeExportTable(buildSettings(), rows, aiResults, fieldSelections)!.imageColName).toBe("Image");
    expect(composeExportTable(buildSettings({ imageExport: false }), rows, aiResults, fieldSelections)!.imageColName).toBeNull();
  });

  it("falls back to empty string when a record value or AI suggestion is missing", () => {
    const sparseRows: ArtefactRow[] = [{ uid: "ux", status: "done", record: {} }];
    const table = composeExportTable(buildSettings(), sparseRows, {}, {})!;
    expect(table.rows[0]).toEqual(["", "", ""]);
  });
});
