// Extract embedded image objects from a .xlsx file and attribute each to its
// data-row. A .xlsx is a zip; images live under xl/media/ and are anchored to
// cells via xl/drawings/*.xml + xl/worksheets/_rels/*.rels.
//
// The artefact "Image" column holds these embedded objects (not paths), so we
// must unpack the zip and resolve the drawing anchors. The raw bytes are then
// handed to Rust (images::extract_images) to write beside the binary.

import { unzipSync, strFromU8 } from "fflate";
import type { ExtractedImage } from "../app/types";
import { invoke } from "@tauri-apps/api/core";
import { pushLog } from "./logs";

interface ImageEntry {
  rowIndex: number;
  filename: string;
  bytes: Uint8Array;
}

/** Result of extraction: per-row image descriptors + what was sent to disk. */
export interface ExtractionResult {
  /** rowIndex (0-based data row) → file id used for convertFileSrc. */
  rowIndexToFileId: Map<number, string>;
}

/**
 * Extract images from a .xlsx file, attributing each to a data row index.
 * `imageRowIndices` is only a hint from visible Image cell values. Embedded
 * images often have no cell value, so drawing anchors are the source of truth.
 */
export async function extractImagesFromXlsx(
  file: File,
  imageRowIndices: number[],
  sessionId: string
): Promise<ExtractionResult> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(buf);
  } catch {
    return { rowIndexToFileId: new Map() };
  }

  // 1. Collect media files: xl/media/<name>
  const media: Record<string, Uint8Array> = {};
  for (const path of Object.keys(files)) {
    if (/^xl\/media\//i.test(path)) {
      media[path] = files[path];
    }
  }
  if (Object.keys(media).length === 0) {
    return { rowIndexToFileId: new Map() };
  }

  // 2. Map each drawing rel (rId → media path) and read anchors.
  //    xl/drawings/drawingN.xml references rels in xl/drawings/_rels/drawingN.rels
  const entries: ImageEntry[] = [];

  const drawingPaths = Object.keys(files).filter((p) => /^xl\/drawings\/drawing\d+\.xml$/i.test(p));
  // Build rId → media path for each drawing.
  const relsForDrawing: Record<string, Record<string, string>> = {};
  for (const dp of Object.keys(files)) {
    const m = /^xl\/drawings\/_rels\/(drawing\d+)\.xml\.rels$/i.exec(dp);
    if (!m) continue;
    const relsXml = strFromU8(files[dp]);
    const map: Record<string, string> = {};
    const re = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g;
    let rm: RegExpExecArray | null;
    while ((rm = re.exec(relsXml)) !== null) {
      const target = rm[2].replace(/\\/g, "/");
      // Target is relative to xl/drawings/, so media is ../media/<name>
      const mediaPath = target.startsWith("/") ? target.slice(1) : `xl/drawings/${target}`.replace("../", "");
      map[rm[1]] = mediaPath.replace(/^xl\/drawings\/media/, "xl/media");
    }
    relsForDrawing[m[1]] = map;
  }

  for (const dp of drawingPaths) {
    const dm = /^xl\/drawings\/(drawing\d+)\.xml$/i.exec(dp);
    if (!dm) continue;
    const rels = relsForDrawing[dm[1]] || {};
    const xml = strFromU8(files[dp]);

    // Each <xdr:twoCellAnchor> or <xdr:oneCellAnchor> carries an <xdr:from><xdr:col>..<xdr:row>
    // and a <xdr:pic> with <a:blip r:embed="rIdN"/>.
    const anchorRe = /<(?:xdr:)?(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[\s\S]*?<\/(?:xdr:)?(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)>/g;
    let am: RegExpExecArray | null;
    let drawIdx = 0;
    while ((am = anchorRe.exec(xml)) !== null) {
      const block = am[0];
      const fromMatch = /<(?:xdr:)?from>([\s\S]*?)<\/(?:xdr:)?from>/.exec(block);
      let row = -1;
      if (fromMatch) {
        const r = /<(?:xdr:)?row>(\d+)<\/(?:xdr:)?row>/.exec(fromMatch[1]);
        if (r) row = parseInt(r[1], 10);
      }
      const blip = /r:embed="([^"]+)"/.exec(block) || /r:link="([^"]+)"/.exec(block);
      const rId = blip ? blip[1] : null;
      const mediaPath = rId ? rels[rId] : null;
      if (mediaPath && media[mediaPath]) {
        entries.push({
          rowIndex: row >= 0 ? row - 1 : drawIdx, // -1 because sheet row 1 is the header
          filename: mediaPath.split("/").pop() || `image-${drawIdx}.png`,
          bytes: media[mediaPath],
        });
      }
      drawIdx++;
    }
  }

  if (entries.length === 0) {
    return { rowIndexToFileId: new Map() };
  }

  // 3. Attribute each drawing to the nearest requested image-row.
  //    If imageRowIndices is provided, snap each drawing to the closest data
  //    row index; otherwise use the drawing's own row.
  const rowIndexToFileId = new Map<number, string>();
  const toSend: { filename: string; bytes: number[] }[] = [];
  for (const e of entries) {
    let target = e.rowIndex;
    if (imageRowIndices.length) {
      // pick the closest requested row index
      let best = imageRowIndices[0];
      let bestDist = Math.abs(best - e.rowIndex);
      for (const ri of imageRowIndices) {
        const d = Math.abs(ri - e.rowIndex);
        if (d < bestDist) {
          bestDist = d;
          best = ri;
        }
      }
      target = best;
    }
    // de-dupe: keep the first image per target row
    if (rowIndexToFileId.has(target)) continue;
    const filename = `${target}_${e.filename}`;
    toSend.push({ filename, bytes: Array.from(e.bytes) });
    rowIndexToFileId.set(target, filename);
  }

  // 4. Hand bytes to Rust to write beside the binary.
  let written: ExtractedImage[] = [];
  try {
    written = await invoke<ExtractedImage[]>("extract_images", { sessionId, entries: toSend });
  } catch (e) {
    // extract_images failure leaves written empty; callers fall back to no
    // image. Surface the error so it's diagnosable in the Logs Viewer.
    pushLog({
      status: "fail",
      jobId: "extract",
      label: "Image write failed",
      detail: "Could not save extracted images to disk beside the app.",
      verbose: { error: String((e as Error)?.message || e) },
    });
  }

  // Map our filenames to the abs paths Rust returned (matched by id).
  const idToAbs = new Map(written.map((w) => [w.id, w.abs_path]));
  // Re-key the row map to the absolute path for convertFileSrc convenience.
  const out = new Map<number, string>();
  for (const [rowIdx, fname] of rowIndexToFileId) {
    const abs = idToAbs.get(fname);
    if (abs) out.set(rowIdx, abs);
  }
  return { rowIndexToFileId: out };
}
