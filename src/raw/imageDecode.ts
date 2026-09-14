// Decodes standard image files (JPEG, PNG, TIFF, WebP, HEIC) using the
// browser's native createImageBitmap() API. Returns the same shape the
// raw pipeline expects (width, height, RGBA pixel data) so it can be
// uploaded to a GPU texture directly — no Bayer, no demosaic needed.

import type { CameraMeta } from './decode';

export interface DecodedImage {
  width: number;
  height: number;
  // RGBA pixel data, 8-bit per channel (Uint8ClampedArray from ImageBitmap).
  // Uploaded as rgba8unorm to the GPU, then converted to rgba16float in the
  // load path so the rest of the pipeline (tone, WB, etc.) works unchanged.
  imageData: ImageData;
  // Standard images have no raw metadata; provide neutral defaults so the
  // UI (camera info, WB readout) doesn't break.
  cameraMeta: CameraMeta;
  make: string;
  model: string;
}

export class ImageDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageDecodeError';
  }
}

// Extracts basic EXIF metadata from a JPEG file using a minimal parser.
// Returns neutral defaults for non-JPEG files or when EXIF is absent.
async function extractExifMetadata(fileBytes: ArrayBuffer): Promise<{ make: string; model: string; cameraMeta: CameraMeta }> {
  const neutral = { make: '', model: '', cameraMeta: { iso: 0, shutter: 0, aperture: 0, focal: 0 } };
  
  // Only parse JPEG EXIF (TIFF/PNG/WebP would need different parsers)
  const bytes = new Uint8Array(fileBytes);
  if (bytes.length < 12 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
    return neutral; // Not a JPEG
  }

  try {
    // Find APP1 (EXIF) marker
    let offset = 2;
    while (offset < bytes.length - 1) {
      if (bytes[offset] !== 0xFF) break;
      const marker = bytes[offset + 1];
      if (marker === 0xE1) { // APP1
        const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
        const exifStart = offset + 4;
        // Check for "Exif\0\0" header
        if (bytes[exifStart] === 0x45 && bytes[exifStart + 1] === 0x78 &&
            bytes[exifStart + 2] === 0x69 && bytes[exifStart + 3] === 0x66) {
          return parseExifData(bytes.slice(exifStart + 6, exifStart + length - 4));
        }
        break;
      }
      // Skip to next marker
      const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
      offset += 2 + segLen;
    }
  } catch {
    // EXIF parse failed — return neutral defaults
  }
  return neutral;
}

function parseExifData(exifBytes: Uint8Array): { make: string; model: string; cameraMeta: CameraMeta } {
  const result = { make: '', model: '', cameraMeta: { iso: 0, shutter: 0, aperture: 0, focal: 0 } };
  
  if (exifBytes.length < 8) return result;
  
  // Determine byte order (II = little-endian, MM = big-endian)
  const littleEndian = exifBytes[0] === 0x49 && exifBytes[1] === 0x49;
  const readU16 = littleEndian
    ? (offset: number) => exifBytes[offset] | (exifBytes[offset + 1] << 8)
    : (offset: number) => (exifBytes[offset] << 8) | exifBytes[offset + 1];
  const readU32 = littleEndian
    ? (offset: number) => exifBytes[offset] | (exifBytes[offset + 1] << 8) | (exifBytes[offset + 2] << 16) | (exifBytes[offset + 3] << 24)
    : (offset: number) => (exifBytes[offset] << 24) | (exifBytes[offset + 1] << 16) | (exifBytes[offset + 2] << 8) | exifBytes[offset + 3];
  
  // Check TIFF magic (42)
  if (readU16(2) !== 0x2A) return result;
  
  const ifd0Offset = readU32(4);
  if (ifd0Offset >= exifBytes.length) return result;
  
  // Parse IFD0 entries
  const numEntries = readU16(ifd0Offset);
  for (let i = 0; i < numEntries; i++) {
    const entryOffset = ifd0Offset + 2 + i * 12;
    if (entryOffset + 12 > exifBytes.length) break;
    
    const tag = readU16(entryOffset);
    const count = readU32(entryOffset + 4);
    const valueOffset = entryOffset + 8;
    
    // Tag 0x010F = Make, 0x0110 = Model
    if (tag === 0x010F || tag === 0x0110) {
      const strOffset = count > 4 ? readU32(valueOffset) : valueOffset;
      if (strOffset < exifBytes.length) {
        let str = '';
        for (let j = strOffset; j < exifBytes.length && exifBytes[j] !== 0; j++) {
          str += String.fromCharCode(exifBytes[j]);
        }
        if (tag === 0x010F) result.make = str.trim();
        else result.model = str.trim();
      }
    }
  }
  
  return result;
}

export async function decodeImage(fileBytes: ArrayBuffer): Promise<DecodedImage> {
  // Use createImageBitmap for native browser decoding (JPEG, PNG, WebP, etc.)
  // HEIC/HEIF support depends on the browser (Safari supports it natively;
  // Chrome 133+ on macOS also supports it). Unsupported formats will throw.
  let bitmap: ImageBitmap;
  try {
    const blob = new Blob([fileBytes]);
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    throw new ImageDecodeError(
      `Failed to decode image: ${err instanceof Error ? err.message : String(err)}. ` +
      `This format may not be supported by your browser.`
    );
  }

  // Draw to an offscreen canvas to get RGBA pixel data
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new ImageDecodeError('Failed to get 2D canvas context for image decoding');
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  
  // Extract EXIF metadata (best-effort; neutral defaults on failure)
  const { make, model, cameraMeta } = await extractExifMetadata(fileBytes);

  return {
    width: canvas.width,
    height: canvas.height,
    imageData,
    cameraMeta,
    make,
    model,
  };
}
