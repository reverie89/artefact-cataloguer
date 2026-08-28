// Read embedded pixel dimensions out of PNG/JPEG byte payloads without a
// decoder. The export gives ExcelJS an explicit `ext` so images land visibly
// sized — ExcelJS never parses image headers, so the caller must supply the
// natural dimensions.

export interface Dimensions {
  width: number;
  height: number;
}

/** Fallback for payloads with no parseable header; keeps the anchor valid. */
const FALLBACK: Dimensions = { width: 200, height: 150 };

/** Largest edge (px) an embedded image may occupy on the exported sheet. */
const MAX_EDGE = 200;

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/** PNG: the IHDR chunk directly follows the 8-byte signature; width/height
 *  are big-endian uint32s at offsets 16/20. */
function pngDimensions(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 24 || be32(bytes, 0) !== 0x89504e47) return null;
  return { width: be32(bytes, 16), height: be32(bytes, 20) };
}

/** JPEG: walk the marker stream until a frame-header marker (SOF0–SOF15,
 *  excluding DHT/JPG/DAC) carries height/width as big-endian uint16s. */
function jpegDimensions(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    // Standalone markers (SOI, TEM, RSTn) carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = be16(bytes, i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: be16(bytes, i + 5), width: be16(bytes, i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** Natural dimensions of an image payload, sniffing the header format rather
 *  than trusting the filename extension; falls back when neither matches. */
export function imageDimensions(bytes: Uint8Array): Dimensions {
  return pngDimensions(bytes) ?? jpegDimensions(bytes) ?? FALLBACK;
}

/** Scale `w`×`h` to fit a `max` square, preserving aspect ratio; smaller
 *  images pass through unscaled (never upscaled). Returns integers ≥ 1 so
 *  the anchor extent is always valid. */
export function fitWithin(w: number, h: number, max: number = MAX_EDGE): Dimensions {
  if (w <= 0 || h <= 0) return { ...FALLBACK };
  const scale = Math.min(1, max / w, max / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** ExcelJS row heights are in points (1px = 0.75pt at 96dpi). */
export function rowHeightPoints(px: number): number {
  return Math.round(px * 0.75 * 10) / 10;
}

/** ExcelJS column widths are in character units (Calibri 11: pixel width ≈
 *  chars×7+5), so a `px`-wide image needs `(px − 5) / 7` characters. */
export function columnWidthChars(px: number): number {
  return Math.round(((px - 5) / 7) * 100) / 100;
}
