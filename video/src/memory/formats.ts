// The three Meta placements of the smart-memory ad (issue #130). Each format has a safe area: the band where
// the text and the key action stay. The picture lays out in a square that fills the width of the safe area, or
// its height when that is less, centred on it. Units of that square: 1080 across (src/lettering.ts).
export const FORMATS = {
  // The master: the largest feed placement on Instagram and Facebook. No overlay covers it.
  '4x5': { width: 1080, height: 1350, safeTop: 0, safeBottom: 1350 },
  '1x1': { width: 1080, height: 1080, safeTop: 0, safeBottom: 1080 },
  // Reels and Stories: the app's buttons and captions cover the top 14 % and the bottom 35 %.
  '9x16': { width: 1080, height: 1920, safeTop: Math.round(0.14 * 1920), safeBottom: Math.round(0.65 * 1920) },
} as const;
export type FormatId = keyof typeof FORMATS;
export const FORMAT_IDS = Object.keys(FORMATS) as FormatId[];
export const isFormat = (value: string): value is FormatId => value in FORMATS;

// The square of the layout in pixels of the frame: its centre height and its side.
export type Area = { y: number; size: number };
export function areaOf(width: number, height: number): Area {
  const format = Object.values(FORMATS).find((entry) => entry.width === width && entry.height === height);
  if (format === undefined) throw new RangeError(`no format of ${width} × ${height}`);
  return { y: (format.safeTop + format.safeBottom) / 2, size: Math.min(width, format.safeBottom - format.safeTop) };
}

// Meta asks for text of at least 6 % of the frame height: the least font size in units of the square.
export const minTextSize = (height: number, area: Area): number => (0.06 * height * 1080) / area.size;
