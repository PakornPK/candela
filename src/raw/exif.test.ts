import { describe, it, expect } from 'vitest';
import { parseExifDateTime, cameraKeyFromExif, exifToRecordFields } from './exif';
import type { ExifIdentify } from './exif';
import { cameraCalibrationKey } from '../gpu/uniforms';

describe('parseExifDateTime', () => {
  it('parses LibRaw\'s colon-date EXIF string into local epoch ms', () => {
    // Date.parse returns NaN on this exact string (EXIF uses colons in the
    // date part, not ISO dashes) -- which is why this parser exists.
    expect(Number.isNaN(Date.parse('2023:04:16 21:18:27'))).toBe(true);
    const t = parseExifDateTime('2023:04:16 21:18:27');
    expect(t).not.toBeNull();
    // The local-time reading must round-trip to the same wall-clock digits.
    const d = new Date(t!);
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual(
      [2023, 4, 16, 21, 18, 27],
    );
  });

  it('agrees with a dashed-ISO Date.parse for the same wall-clock', () => {
    // Cross-check against the platform's own local-time parsing: the whole
    // point is that only the SEPARATOR differs from ISO.
    expect(parseExifDateTime('2023:04:16 21:18:27')).toBe(Date.parse('2023-04-16T21:18:27'));
  });

  it('accepts month/day boundaries', () => {
    expect(parseExifDateTime('2024:02:29 00:00:00')).toBe(Date.parse('2024-02-29T00:00:00')); // leap day
    expect(parseExifDateTime('2023:12:31 23:59:59')).toBe(Date.parse('2023-12-31T23:59:59'));
    expect(parseExifDateTime('2023:01:01 00:00:00')).toBe(Date.parse('2023-01-01T00:00:00'));
  });

  it('rejects the EXIF zero placeholder and empty string', () => {
    expect(parseExifDateTime('0000:00:00 00:00:00')).toBeNull();
    expect(parseExifDateTime('')).toBeNull();
  });

  it('rejects garbage and wrong shapes', () => {
    expect(parseExifDateTime('not a date')).toBeNull();
    expect(parseExifDateTime('2023-04-16 21:18:27')).toBeNull(); // dashes, not EXIF colons
    expect(parseExifDateTime('2023:04:16')).toBeNull(); // no time part
    expect(parseExifDateTime('2023:04:16 21:18')).toBeNull(); // no seconds
    expect(parseExifDateTime('2023:04:16 21:18:27.5')).toBeNull(); // trailing junk
    expect(parseExifDateTime('23:04:16 21:18:27')).toBeNull(); // 2-digit year
  });

  it('rejects out-of-range fields instead of Date\'s silent carry-over', () => {
    // new Date(2023, 13, 1) happily rolls to Jan 2024 -- a garbage month
    // must NOT sort into some real month's smart collection.
    expect(parseExifDateTime('2023:13:01 00:00:00')).toBeNull();
    expect(parseExifDateTime('2023:00:10 00:00:00')).toBeNull();
    expect(parseExifDateTime('2023:04:00 00:00:00')).toBeNull();
    expect(parseExifDateTime('2023:04:31 00:00:00')).toBeNull(); // Apr has 30 days
    expect(parseExifDateTime('2023:02:30 00:00:00')).toBeNull(); // Feb 30, non-leap
    expect(parseExifDateTime('2023:04:16 24:00:00')).toBeNull();
    expect(parseExifDateTime('2023:04:16 21:60:00')).toBeNull();
    expect(parseExifDateTime('2023:04:16 21:18:60')).toBeNull(); // leap second not in-camera EXIF
  });
});

describe('cameraKeyFromExif', () => {
  it('matches uniforms.ts cameraCalibrationKey for the Fuji X100V', () => {
    // The registry key (uniforms.ts WB_CALIBRATIONS) is exactly 'Fujifilm
    // X100V' -- catalog rows and the GPU calibration must agree on the
    // identity string or the per-camera readout calibration silently misses.
    expect(cameraKeyFromExif('Fujifilm', 'X100V')).toBe('Fujifilm X100V');
    expect(cameraKeyFromExif('Fujifilm', 'X100V')).toBe(cameraCalibrationKey('Fujifilm', 'X100V'));
  });

  it('collapses interior and trailing whitespace', () => {
    expect(cameraKeyFromExif('Fujifilm  ', ' X100V  ')).toBe('Fujifilm X100V');
    expect(cameraKeyFromExif('Canon', 'EOS   R5')).toBe('Canon EOS R5');
  });

  it('drops a duplicated make prefix from the model', () => {
    expect(cameraKeyFromExif('Nikon', 'NIKON Z 6')).toBe('NIKON Z 6');
    expect(cameraKeyFromExif('SONY', 'Sony A7 IV')).toBe('Sony A7 IV');
  });

  it('handles one-sided and empty inputs', () => {
    expect(cameraKeyFromExif('Fujifilm', '')).toBe('Fujifilm');
    expect(cameraKeyFromExif('', 'X100V')).toBe('X100V');
    expect(cameraKeyFromExif('', '')).toBeUndefined();
    expect(cameraKeyFromExif('   ', '  ')).toBeUndefined();
  });
});

describe('exifToRecordFields', () => {
  const base: ExifIdentify = {
    make: '',
    model: '',
    lens: '',
    datetimeOriginal: '',
    iso: 0,
    focalLength: 0,
    width: 0,
    height: 0,
    flip: 0,
  };

  it('omits every key for an all-empty struct (no junk for filters to match)', () => {
    expect(exifToRecordFields(base)).toEqual({});
    // Explicitly: no undefined-valued keys either -- Object.keys is empty,
    // so spreading into a stored row adds nothing.
    expect(Object.keys(exifToRecordFields(base))).toEqual([]);
  });

  it('passes through a full Fuji X100V record', () => {
    const fields = exifToRecordFields({
      ...base,
      make: 'Fujifilm',
      model: 'X100V',
      lens: 'Fujinon Lens',
      datetimeOriginal: '2026:08:22 12:28:19',
      iso: 320,
      focalLength: 23,
      width: 6246,
      height: 4170,
      flip: 6,
    });
    expect(fields.cameraModel).toBe('Fujifilm X100V');
    expect(fields.lensModel).toBe('Fujinon Lens');
    expect(fields.iso).toBe(320);
    expect(fields.focalLength).toBe(23);
    expect(fields.dateTaken).toBe(parseExifDateTime('2026:08:22 12:28:19'));
  });

  it('keeps the keys a file does report and drops the rest', () => {
    // A fixed-lens camera: no lens. A file whose EXIF date failed to parse:
    // no dateTaken. iso 0 = not reported -> key absent, never stored 0.
    const fields = exifToRecordFields({
      ...base,
      make: 'Fujifilm',
      model: 'X100V',
      datetimeOriginal: 'garbage',
      iso: 0,
      focalLength: 23,
    });
    expect(fields).toEqual({ cameraModel: 'Fujifilm X100V', focalLength: 23 });
    expect('lensModel' in fields).toBe(false);
    expect('iso' in fields).toBe(false);
    expect('dateTaken' in fields).toBe(false);
  });

  it('trims a whitespace-only lens away', () => {
    const fields = exifToRecordFields({ ...base, lens: '   ' });
    expect('lensModel' in fields).toBe(false);
  });
});
