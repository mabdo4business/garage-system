import { createHash } from "node:crypto";
import type { ImageType } from "../db/schema";

/**
 * Photo inspection without an image library: the type comes from the file's own signature (never
 * from the client's Content-Type), and width/height from its header. JPEG, PNG and WebP only (T-07).
 */
export interface ImageInfo {
  contentType: ImageType;
  width: number;
  height: number;
  sha256: string;
}

const MAX_SIDE = 65_535;

export function inspectImage(bytes: Uint8Array): ImageInfo | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = jpegSize(buffer) ?? pngSize(buffer) ?? webpSize(buffer);
  // Real photos are far below 65,535 px a side; anything larger is a forged header (and would not fit
  // the integer columns).
  if (!size || size.width <= 0 || size.height <= 0 || size.width > MAX_SIDE || size.height > MAX_SIDE)
    return null;
  return { ...size, sha256: createHash("sha256").update(buffer).digest("hex") };
}

type Sized = { contentType: ImageType; width: number; height: number };

function pngSize(b: Buffer): Sized | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || signature.some((byte, i) => b[i] !== byte)) return null;
  if (b.toString("ascii", 12, 16) !== "IHDR") return null;
  return { contentType: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegSize(b: Buffer): Sized | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) return null;
    const marker = b[offset + 1]!;
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    const length = b.readUInt16BE(offset + 2);
    // Start-of-frame markers carry the dimensions (C0–CF except DHT C4, JPG C8, DAC CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        contentType: "image/jpeg",
        height: b.readUInt16BE(offset + 5),
        width: b.readUInt16BE(offset + 7),
      };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function webpSize(b: Buffer): Sized | null {
  if (b.length < 30 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP")
    return null;
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    return {
      contentType: "image/webp",
      width: b.readUInt16LE(26) & 0x3fff,
      height: b.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    const bits = b.readUInt32LE(21);
    return { contentType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { contentType: "image/webp", width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}
