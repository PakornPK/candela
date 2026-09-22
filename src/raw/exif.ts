// Pure EXIF-shaping helpers for the identify-at-import path. Deliberately
// DOM-free and wasm-free (src/raw/exif.test.ts runs them under plain vitest):
// decode.ts/identify() produces this struct, import.ts maps it onto the
// FileRecord fields the catalog readers already consume.

// Raw metadata as returned by wrapper.cpp's identify() -- the identify-only
// LibRaw pass (no Bayer unpack), mirroring the IdentifyResult struct there.
export interface ExifIdentify {
  make: string; // EXIF Make, LibRaw-normalized ("Fujifilm"); '' = not reported
  model: string; // EXIF Model ("X100V"); '' = not reported
  lens: string; // EXIF LensModel; '' when the file reports no lens (fixed-lens cameras)
  datetimeOriginal: string; // "YYYY:MM:DD HH:MM:SS" camera wall-clock; '' = not reported
  iso: number; // whole ISO; 0 = not reported
  focalLength: number; // mm; 0 = not reported
  width: number; // effective width (sensor margins cropped); 0 = not reported
  height: number; // effective height; 0 = not reported
  flip: number; // LibRaw sensor-orientation code 0..7 (see wrapper.cpp)
}

// Parses LibRaw's EXIF DateTimeOriginal, "YYYY:MM:DD HH:MM:SS", into epoch ms.
//
// Why not Date.parse: EXIF puts COLONS in the date part ("2026:08:22
// 12:28:19"), which Date.parse rejects (NaN) in V8 -- ISO 8601 demands
// dashes. The shape must be validated by hand, and that also lets us reject
// the camera's zeroed placeholder ("0000:00:00 00:00:00", common on files
// whose EXIF was stripped) which would otherwise parse as year 0 and pollute
// date-sorted smart collections.
//
// Timezone: EXIF DateTimeOriginal is the camera's LOCAL wall-clock with no
// zone info anywhere in the record, so the only faithful interpretation at
// display time is the viewer's own zone -- construct with new Date(y, m-1, ...)
// (the local-time overload) so the epoch round-trips to the same wall-clock
// digits in the viewer's TZ. A UTC reading would shift every photo by the
// viewer's offset. This matches what LibRaw's own get_timestamp() does
// (mktime = local). See wrapper.cpp's datetime_original comment for the
// time_t round-trip on the wasm side.
export function parseExifDateTime(s: string): number | null {
  // Strict: exactly "YYYY:MM:DD HH:MM:SS". A wrong shape (dashes, missing
  // seconds, trailing junk) returns null rather than a partial parse.
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d, hh, mm, ss] = m.slice(1).map(Number);
  // Reject the EXIF zero placeholder and obvious garbage (month 0, hour 25)
  // without trusting Date's silent carry-over (new Date(2026, 13, ...) would
  // happily roll into next year and sort a bad record into the wrong month).
  if (y < 1000 || mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59 || ss > 59) {
    return null;
  }
  // Round-trip check for day-overflow per month (Feb 30 must fail, not become
  // March 2): Date normalizes out-of-range days, so compare the fields back.
  const t = new Date(y, mo - 1, d, hh, mm, ss).getTime();
  if (Number.isNaN(t)) return null;
  const check = new Date(t);
  if (check.getFullYear() !== y || check.getMonth() !== mo - 1 || check.getDate() !== d) {
    return null;
  }
  return t;
}

// Normalized "Make Model" display/search key. Matches cameraCalibrationKey's
// convention in src/gpu/uniforms.ts (LibRaw title-cases the EXIF identity --
// "Fujifilm X100V", "Nikon D800"), so the catalog's cameraModel reads the
// same string the WB-calibration registry and search consume; it additionally
// collapses interior whitespace (some files carry "X100V   " or double
// spaces) and drops the make prefix when the model already repeats it
// ("FUJIFILM" + "FUJIFILM X100V" -> "Fujifilm X100V", not doubled).
export function cameraKeyFromExif(make: string, model: string): string | undefined {
  const collapse = (s: string) => s.trim().replace(/\s+/g, ' ');
  const m = collapse(make);
  const d = collapse(model);
  if (!m && !d) return undefined;
  if (!d) return m;
  if (!m) return d;
  // Duplicate prefix: model already starts with the make (case-insensitively
  // -- the point of dropping it is avoiding "NIKON NIKON Z 6"). Return the
  // model as-is; LibRaw already title-cases both fields upstream, so no
  // case rewriting here (it would corrupt a model that is correctly mixed).
  if (d.toLowerCase().startsWith(m.toLowerCase())) {
    return d;
  }
  return `${m} ${d}`;
}

// The ONE place the identify struct maps onto FileRecord field names, so
// import.ts can just spread the result. Every key whose value is empty/0
// (LibRaw's "not reported" sentinels) is OMITTED entirely: a stored
// `cameraModel: ''` matches smart-collection rules that use `?? ''` +
// includes(), and a stored `iso: 0` reads as "shot at ISO 0" -- absent keys
// mean "unknown" to every reader, which is the honest state.
export function exifToRecordFields(e: ExifIdentify): {
  cameraModel?: string;
  lensModel?: string;
  iso?: number;
  focalLength?: number;
  dateTaken?: number;
} {
  const fields: {
    cameraModel?: string;
    lensModel?: string;
    iso?: number;
    focalLength?: number;
    dateTaken?: number;
  } = {};

  const cameraModel = cameraKeyFromExif(e.make, e.model);
  if (cameraModel) fields.cameraModel = cameraModel;

  const lens = e.lens.trim();
  if (lens) fields.lensModel = lens;

  if (e.iso > 0) fields.iso = e.iso;
  if (e.focalLength > 0) fields.focalLength = e.focalLength;

  const dateTaken = parseExifDateTime(e.datetimeOriginal);
  if (dateTaken !== null) fields.dateTaken = dateTaken;

  return fields;
}
