import { describe, expect, it } from "vitest";

import { columnWidthChars, fitWithin, imageDimensions, rowHeightPoints } from "./imageMeta";

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

/** Minimal-but-valid PNG header: signature + IHDR length/"IHDR" + dimensions. */
function png(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0x00, 0x00, 0x00, 0x0d, // IHDR data length
    0x49, 0x48, 0x44, 0x52, // "IHDR"
    ...be32(width),
    ...be32(height),
    0x08, 0x06, 0x00, 0x00, 0x00, // bit depth, colour type, etc.
  ]);
}

/** Minimal JPEG: SOI followed by a SOF0 frame header carrying dimensions. */
function jpeg(width: number, height: number, sofMarker = 0xc0): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0 segment to skip over
    0xff, sofMarker,
    0x00, 0x11, // segment length
    0x08, // sample precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x00, 0x00, // component count + sampling factors
  ]);
}

describe("imageDimensions", () => {
  it("reads PNG dimensions from the IHDR header", () => {
    expect(imageDimensions(png(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it("reads baseline JPEG dimensions from SOF0", () => {
    expect(imageDimensions(jpeg(1024, 768))).toEqual({ width: 1024, height: 768 });
  });

  it("reads progressive JPEG dimensions from SOF2", () => {
    expect(imageDimensions(jpeg(64, 32, 0xc2))).toEqual({ width: 64, height: 32 });
  });

  it("falls back to a sane default for unparseable payloads", () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3]))).toEqual({ width: 200, height: 150 });
  });
});

describe("fitWithin", () => {
  it("scales landscape images down to the max edge, preserving aspect", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 200, height: 150 });
    expect(fitWithin(300, 100)).toEqual({ width: 200, height: 67 });
  });

  it("scales portrait images down to the max edge, preserving aspect", () => {
    expect(fitWithin(600, 1200)).toEqual({ width: 100, height: 200 });
  });

  it("leaves small images unchanged (never upscales)", () => {
    expect(fitWithin(120, 90)).toEqual({ width: 120, height: 90 });
  });

  it("falls back to the default extent for zero/negative dimensions", () => {
    expect(fitWithin(0, 0)).toEqual({ width: 200, height: 150 });
  });
});

describe("rowHeightPoints", () => {
  it("converts pixels to ExcelJS points (1px = 0.75pt)", () => {
    expect(rowHeightPoints(200)).toBe(150);
    expect(rowHeightPoints(150)).toBe(112.5);
    expect(rowHeightPoints(20)).toBe(15);
  });
});

describe("columnWidthChars", () => {
  it("converts pixels to ExcelJS character units (px ≈ chars×7+5)", () => {
    expect(columnWidthChars(200)).toBeCloseTo(27.86, 2);
    expect(columnWidthChars(120)).toBeCloseTo(16.43, 2);
    expect(columnWidthChars(64)).toBeCloseTo(8.43, 2); // Excel's default width in px
  });
});
