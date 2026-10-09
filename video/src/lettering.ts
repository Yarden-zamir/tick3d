// The lettering of every video: plain words, stickers and the end card with the official store badges, drawn on
// a 2D canvas that three.js shows as a texture. Layout units are pixels of the 1080 × 1080 centre square, origin
// in its middle, y down. The times of the words are sixteenths of the beat grid (src/grid.ts).
import { spring } from 'remotion';
import type { Badge } from '../creative/beats.ts';
import { FPS, S16_FRAMES, frameOf, since } from './grid.ts';
import type { Rgba, Theme, Token } from './themes.ts';

// Video pixels per CSS pixel: the video draws the game as a phone screen at 2x does.
export const PX = 2;
const FONT = '"Bricolage Grotesque"';
const BORDER = 3 * PX;
const SHADOW = 4 * PX;
const SQUARE = 1080;
// The URL suffix against the wordmark: a little over half, so it reads on a phone in landscape too.
const SUFFIX = 0.55;

const css = ({ r, g, b, a }: Rgba) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)} / ${a})`;

export type Word = { text: string; at: number; badge?: Badge; note?: string };
// A plain word: `--surface` letters with a thick `--line` outline and a hard shadow. A sticker: the "3d" of
// the wordmark, a `--line` box in a token color with `--on-color` letters, tilted by `tilt` degrees (-5 as in the
// wordmark). A look with `pulse` bumps on every beat.
export type Look = { y: number; size: number; sticker?: Token; tilt?: number; pulse?: boolean };

// The beat of the 136 BPM grid: a bump of 1 on every beat (4 sixteenths), back to about 0 by the next one.
export const BEAT_PULSE = 0.06;
export const beatBump = (frame: number) => Math.exp(-2.5 * (((since(frame, 0) % 4) + 4) % 4));

// The drop-in of a word group: 0 before its sixteenth, then a spring with a small overshoot, settled in 1 sixteenth.
const dropIn = (frame: number, at: number) =>
  frame < frameOf(at) ? 0 : spring({ frame: frame - frameOf(at), fps: FPS, config: { damping: 11, stiffness: 320, mass: 0.6 }, durationInFrames: Math.ceil(S16_FRAMES) + 1 });

function plainWord(ctx: CanvasRenderingContext2D, text: string, size: number, theme: Theme): void {
  ctx.font = `800 ${size}px ${FONT}`;
  ctx.letterSpacing = '-0.03em';
  ctx.lineJoin = 'round';
  ctx.lineWidth = BORDER * 2;
  ctx.strokeStyle = css(theme.shadow);
  ctx.fillStyle = css(theme.shadow);
  ctx.strokeText(text, SHADOW, SHADOW);
  ctx.fillText(text, SHADOW, SHADOW);
  ctx.strokeStyle = css(theme.line);
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = css(theme.surface);
  ctx.fillText(text, 0, 0);
}

function roundedBox(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 8 * PX);
}

// The sticker of `.brand h1 span` in src/style.css, centred on the origin. Returns its width.
export function sticker(ctx: CanvasRenderingContext2D, text: string, size: number, fill: Token, theme: Theme, letterSpacing = '-0.03em', tilt = -5): number {
  ctx.font = `800 ${size}px ${FONT}`;
  ctx.letterSpacing = letterSpacing;
  const width = ctx.measureText(text).width + size * 0.28;
  const height = size * 1.04;
  ctx.save();
  ctx.rotate((tilt * Math.PI) / 180);
  roundedBox(ctx, -width / 2 + SHADOW, -height / 2 + SHADOW, width, height);
  ctx.fillStyle = css(theme.shadow);
  ctx.fill();
  roundedBox(ctx, -width / 2, -height / 2, width, height);
  ctx.fillStyle = css(theme[fill]);
  ctx.fill();
  ctx.lineWidth = BORDER;
  ctx.strokeStyle = css(theme.line);
  ctx.stroke();
  ctx.fillStyle = css(theme['on-color']);
  ctx.fillText(text, 0, size * 0.02);
  ctx.restore();
  return width;
}

// The width of a word group in `look`, as wordAt draws it at rest.
export function wordWidth(ctx: CanvasRenderingContext2D, text: string, look: Look): number {
  ctx.font = `800 ${look.size}px ${FONT}`;
  ctx.letterSpacing = '-0.03em';
  const width = ctx.measureText(text).width;
  return look.sticker === undefined ? width : width + look.size * 0.28;
}

// `leave`: the sixteenth where the word starts to shrink and fade out, over 1 sixteenth. `x`: the centre, 0 by default.
export function wordAt(ctx: CanvasRenderingContext2D, frame: number, word: Word, look: Look, theme: Theme, leave?: number, x = 0): void {
  const p = dropIn(frame, word.at);
  const out = leave === undefined ? 0 : Math.min(1, Math.max(0, since(frame, leave)));
  if (p <= 0 || out >= 1) return;
  ctx.save();
  ctx.globalAlpha = 1 - out;
  ctx.translate(x, look.y - (1 - p) * 160);
  const beat = look.pulse === true ? 1 + BEAT_PULSE * beatBump(frame) : 1;
  ctx.scale((1 + (1 - p) * 0.5) * (1 - 0.25 * out) * beat, (1 + (1 - p) * 0.5) * (1 - 0.25 * out) * beat);
  if (look.sticker === undefined) plainWord(ctx, word.text, look.size, theme);
  else sticker(ctx, word.text, look.size, look.sticker, theme, '-0.03em', look.tilt);
  ctx.restore();
}

// The call to action under the address: a small `--o` sticker. The official store badges sit in a row under it.
const CALL_TO_ACTION: Look = { y: 360, size: 62, sticker: 'o', tilt: -3 };
// The badge rules of Apple and Google: the artwork as provided, not tilted or animated; clear space of a quarter of
// the badge height; the App Store badge first; the Google Play badge at least as tall as the others; a credit line.
const BADGE_Y = 452;
const BADGE_HEIGHT = 64;
const BADGE_GAP = 40;
// The note on a badge (for example "soon"): a small `--x` pill on the top right corner of the badge, outlined in
// `--surface` so it stands off the black badge. It pops in 1 beat after the badge. The maintainers chose to put it on
// the badge, inside Apple's clear space (#119).
const NOTE_SIZE = 22;
export const NOTE_DELAY = 4;
const LEGAL_SIZE = 14;
const LEGAL_Y = 512;

// The badge artwork, loaded before the first frame (Spot.tsx), and the part of each file that is the badge.
export type BadgeArt = Readonly<Record<Badge, HTMLImageElement>>;
const BADGE_ART: Readonly<Record<Badge, { file: string; crop: readonly [number, number, number, number] }>> = {
  // Apple's "Download on the App Store" SVG, 119.66 × 40.
  'app-store': { file: 'badges/app-store.svg', crop: [0, 0, 119.66407, 40] },
  // Google's "Get it on Google Play" PNG, 646 × 250, with the badge at 564 × 168 inside transparent padding.
  'google-play': { file: 'badges/google-play.png', crop: [41, 41, 564, 168] },
};
export const BADGE_FILES: Readonly<Record<Badge, string>> = { 'app-store': BADGE_ART['app-store'].file, 'google-play': BADGE_ART['google-play'].file };
const LEGAL: Readonly<Record<Badge, string>> = {
  'app-store': 'Apple and the Apple logo are trademarks of Apple Inc., registered in the U.S. and other countries. App Store is a service mark of Apple Inc.',
  'google-play': 'Google Play and the Google Play logo are trademarks of Google LLC.',
};

type BadgeWord = Word & { badge: Badge };
const badgeWidth = (badge: Badge) => {
  const [, , w, h] = BADGE_ART[badge].crop;
  return (BADGE_HEIGHT * w) / h;
};

// The note pill, centred on (x, y), in upper case, with a small pop on its sixteenth.
function noteTag(ctx: CanvasRenderingContext2D, frame: number, note: string, at: number, x: number, y: number, theme: Theme): void {
  const p = dropIn(frame, at);
  if (p <= 0) return;
  const text = note.toUpperCase();
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((8 * Math.PI) / 180);
  ctx.scale(0.6 + 0.4 * p, 0.6 + 0.4 * p);
  ctx.font = `800 ${NOTE_SIZE}px ${FONT}`;
  ctx.letterSpacing = '0.08em';
  const width = ctx.measureText(text).width + NOTE_SIZE * 1.1;
  const height = NOTE_SIZE * 1.5;
  ctx.beginPath();
  ctx.roundRect(-width / 2, -height / 2, width, height, height / 2);
  ctx.fillStyle = css(theme.x);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = css(theme.surface);
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = css(theme['on-color']);
  // The letter spacing also follows the last letter, so the text moves right by half of it.
  ctx.fillText(text, NOTE_SIZE * 0.04, NOTE_SIZE * 0.06);
  ctx.restore();
}

// The badges in one row, centred, each with its note on its top right corner, and the credit lines under them. A
// badge cuts in on its sixteenth, as provided: no drop, no scale, no tilt.
function badges(ctx: CanvasRenderingContext2D, frame: number, words: readonly BadgeWord[], theme: Theme, art: BadgeArt): void {
  const widths = words.map((word) => badgeWidth(word.badge));
  let x = -(widths.reduce((sum, width) => sum + width, 0) + BADGE_GAP * (words.length - 1)) / 2;
  const shown: Badge[] = [];
  words.forEach((word, i) => {
    const width = widths[i] ?? 0;
    if (frame >= frameOf(word.at)) {
      shown.push(word.badge);
      const [sx, sy, sw, sh] = BADGE_ART[word.badge].crop;
      ctx.drawImage(art[word.badge], sx, sy, sw, sh, x, BADGE_Y - BADGE_HEIGHT / 2, width, BADGE_HEIGHT);
      if (word.note !== undefined) noteTag(ctx, frame, word.note, word.at + NOTE_DELAY, x + width - 2, BADGE_Y - BADGE_HEIGHT / 2 - 6, theme);
    }
    x += width + BADGE_GAP;
  });
  ctx.font = `600 ${LEGAL_SIZE}px ${FONT}`;
  ctx.letterSpacing = '0em';
  ctx.fillStyle = css(theme.ink);
  shown.forEach((badge, i) => ctx.fillText(LEGAL[badge], 0, LEGAL_Y + i * LEGAL_SIZE * 1.3));
}

// The wordmark of the game header: "tick" in `--ink` and the "3d" sticker. The URL suffix slides out of the
// sticker to the right, so the whole line reads as the address. A third word group is the call to action, and
// the word groups after it, each with a `badge`, are the official store badges.
export function endCard(ctx: CanvasRenderingContext2D, frame: number, words: readonly Word[], theme: Theme, art: BadgeArt): void {
  const [mark, suffix, action, ...rest] = words;
  const stores = rest.filter((word): word is BadgeWord => word.badge !== undefined);
  if (mark === undefined || suffix === undefined || stores.length !== rest.length || !mark.text.endsWith('3d') || [mark, suffix, action].some((word) => word?.badge !== undefined)) {
    throw new Error('the end card needs the wordmark "…3d", the URL suffix, then a call to action and store badges');
  }
  if (action !== undefined) wordAt(ctx, frame, action, CALL_TO_ACTION, theme);
  badges(ctx, frame, stores, theme, art);
  const name = mark.text.slice(0, -2);
  const slam = dropIn(frame, mark.at);
  if (slam <= 0) return;
  const slide = frame < frameOf(suffix.at) ? 0 : spring({ frame: frame - frameOf(suffix.at), fps: FPS, config: { damping: 14, stiffness: 200 }, durationInFrames: Math.ceil(2 * S16_FRAMES) });

  // The sizes shrink until the whole address fits in the square, with a margin.
  let size = 150;
  const widths = () => {
    ctx.font = `800 ${size}px ${FONT}`;
    ctx.letterSpacing = '-0.05em';
    const nameWidth = ctx.measureText(name).width;
    const stickerWidth = ctx.measureText('3d').width + size * 0.28 + size * 0.08;
    ctx.font = `800 ${size * SUFFIX}px ${FONT}`;
    ctx.letterSpacing = '-0.02em';
    return { mark: nameWidth + stickerWidth, suffix: ctx.measureText(suffix.text).width + size * 0.1 };
  };
  let w = widths();
  while (w.mark + w.suffix > SQUARE - 120) {
    size -= 2;
    w = widths();
  }
  const y = 260;
  const left = -(w.mark + w.suffix * slide) / 2;
  ctx.save();
  ctx.translate(0, y);
  ctx.scale(2.2 - 1.2 * slam, 2.2 - 1.2 * slam);
  // The suffix first, so the sticker covers it while it slides out.
  if (slide > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(left + w.mark, -size, SQUARE, size * 2);
    ctx.clip();
    ctx.font = `800 ${size * SUFFIX}px ${FONT}`;
    ctx.letterSpacing = '-0.02em';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = css(theme.ink);
    ctx.fillText(suffix.text, left + w.mark - w.suffix * (1 - slide) + size * 0.1, size * 0.3);
    ctx.restore();
  }
  ctx.font = `800 ${size}px ${FONT}`;
  ctx.letterSpacing = '-0.05em';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = css(theme.ink);
  ctx.fillText(name, left, size * 0.3);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const nameWidth = ctx.measureText(name).width;
  ctx.save();
  ctx.translate(left + nameWidth + size * 0.08 + (w.mark - nameWidth - size * 0.08) / 2, -size * 0.02);
  sticker(ctx, '3d', size, 'x', theme, '-0.05em');
  ctx.restore();
  ctx.restore();
}

// Clears the canvas and runs `draw` in the units of the centre square, with centred text.
export function onSquare(ctx: CanvasRenderingContext2D, draw: () => void): void {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(Math.min(width, height) / SQUARE, Math.min(width, height) / SQUARE);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  draw();
  ctx.restore();
}
