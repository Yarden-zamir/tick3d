// The on-screen text: the lines of beats.json, drawn on a 2D canvas that three.js shows as a texture.
// Layout units are pixels of the 1080 × 1080 centre square, origin in its middle, y down.
import { spring } from 'remotion';
import { type Icon, SPOT_SIXTEENTHS, type TextStyle } from '../creative/beats.ts';
import { BEATS, FPS, S16_FRAMES, frameOf, since } from './timeline.ts';
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

type Word = { text: string; at: number; icon?: Icon };
// A plain word: `--surface` letters with a thick `--line` outline and a hard shadow. A sticker: the "3d" of
// the wordmark, a `--line` box in a token color with `--on-color` letters, tilted by `tilt` degrees (-5 as in the
// wordmark).
type Look = { y: number; size: number; sticker?: Token; tilt?: number };

// The look of each word group of a line, by the style of the line ('end-card' draws with endCard).
const LOOKS: Readonly<Record<Exclude<TextStyle, 'end-card' | 'list'>, readonly Look[]>> = {
  center: [{ y: -80, size: 132 }, { y: 100, size: 120, sticker: 'x' }],
  top: [{ y: -496, size: 100 }, { y: -398, size: 90, sticker: 'x' }],

  // One sticker at a time in the free space above the tower. When the next card slams in, the card before it
  // shrinks and fades out over 1 sixteenth.
  cards: [
    { y: -466, size: 88, sticker: 'x', tilt: -5 },
    { y: -466, size: 88, sticker: 'o', tilt: 4 },
    { y: -466, size: 88, sticker: 'x', tilt: -3 },
    { y: -466, size: 88, sticker: 'o', tilt: 5 },
  ],
};

// The 'list' style: a new card lands in the bottom row and pushes the cards before it up one row. A card two
// rows up fades out, so two features show at a time and none of them holds the screen alone.
const LIST_BOTTOM = -414;
const LIST_ROW = 84;
const LIST_SIZE = 64;

function listLine(ctx: CanvasRenderingContext2D, frame: number, words: readonly Word[], theme: Theme): void {
  words.forEach((word, i) => {
    const p = dropIn(frame, word.at);
    if (p <= 0) return;
    // How far the later cards pushed this one up, in rows.
    const rows = words.slice(i + 1).reduce((sum, later) => sum + Math.min(1, dropIn(frame, later.at)), 0);
    if (rows >= 2) return;
    ctx.save();
    ctx.globalAlpha = rows > 1 ? 2 - rows : 1;
    ctx.translate(0, LIST_BOTTOM - rows * LIST_ROW - (1 - p) * 120);
    ctx.scale(1 + (1 - p) * 0.4, 1 + (1 - p) * 0.4);
    sticker(ctx, word.text, LIST_SIZE, i % 2 === 0 ? 'x' : 'o', theme, '-0.03em', i % 2 === 0 ? -3 : 3);
    ctx.restore();
  });
}

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
function sticker(ctx: CanvasRenderingContext2D, text: string, size: number, fill: Token, theme: Theme, letterSpacing = '-0.03em', tilt = -5): number {
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

// `leave`: the sixteenth where the word starts to shrink and fade out, over 1 sixteenth.
function wordAt(ctx: CanvasRenderingContext2D, frame: number, word: Word, look: Look, theme: Theme, leave?: number): void {
  const p = dropIn(frame, word.at);
  const out = leave === undefined ? 0 : Math.min(1, Math.max(0, since(frame, leave)));
  if (p <= 0 || out >= 1) return;
  ctx.save();
  ctx.globalAlpha = 1 - out;
  ctx.translate(0, look.y - (1 - p) * 160);
  ctx.scale((1 + (1 - p) * 0.5) * (1 - 0.25 * out), (1 + (1 - p) * 0.5) * (1 - 0.25 * out));
  if (look.sticker === undefined) plainWord(ctx, word.text, look.size, theme);
  else sticker(ctx, word.text, look.size, look.sticker, theme, '-0.03em', look.tilt);
  ctx.restore();
}

// The call to action under the address: a small `--o` sticker. The store badges sit in a row under it.
const CALL_TO_ACTION: Look = { y: 372, size: 62, sticker: 'o', tilt: -3 };
const BADGE_Y = 466;
const BADGE_GAP = 28;
const BADGE_SIZE = 46;

// The store icons, drawn in the flat style of the game, centred on the origin, `s` pixels tall. They are styled
// shapes, not the official badges of Google and Apple.
function playStoreIcon(ctx: CanvasRenderingContext2D, s: number, theme: Theme): void {
  const a = { x: -0.42 * s, y: -0.5 * s };
  const b = { x: -0.42 * s, y: 0.5 * s };
  const c = { x: 0.5 * s, y: 0 };
  const p = { x: -0.06 * s, y: 0 };
  const lerp = (from: { x: number; y: number }, to: { x: number; y: number }, t: number) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  const fill = (points: readonly { x: number; y: number }[], color: string) => {
    ctx.beginPath();
    points.forEach((point, i) => (i === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  // The four colours of the Google Play mark: blue on the left, green on top, red below, yellow at the tip.
  fill([a, b, p], '#00a0ff');
  fill([a, p, c], '#00e676');
  fill([b, c, p], '#ff3d57');
  fill([lerp(a, c, 0.55), c, lerp(b, c, 0.55), { x: 0.14 * s, y: 0 }], '#ffd500');
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.5 * PX;
  ctx.strokeStyle = css(theme.surface);
  ctx.stroke();
}

// An apple with a bite and a leaf, in `--surface`. The bite paints the badge colour over the body.
function appleIcon(ctx: CanvasRenderingContext2D, s: number, theme: Theme, badge: string): void {
  const disc = (x: number, y: number, r: number, color: string) => {
    ctx.beginPath();
    ctx.arc(x * s, y * s, r * s, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  };
  const body = css(theme.surface);
  disc(-0.19, 0.06, 0.3, body);
  disc(0.19, 0.06, 0.3, body);
  ctx.beginPath();
  ctx.ellipse(0, 0.2 * s, 0.36 * s, 0.3 * s, 0, 0, 2 * Math.PI);
  ctx.fillStyle = body;
  ctx.fill();
  disc(0, -0.25, 0.07, badge);
  disc(0.47, 0.02, 0.17, badge);
  ctx.beginPath();
  ctx.ellipse(0.07 * s, -0.4 * s, 0.07 * s, 0.15 * s, (35 * Math.PI) / 180, 0, 2 * Math.PI);
  ctx.fillStyle = body;
  ctx.fill();
}

// A store badge: a `--line` box with a hard shadow, the icon, and the text in `--surface`. Returns its width.
function badgeWidth(ctx: CanvasRenderingContext2D, text: string): number {
  ctx.font = `800 ${BADGE_SIZE}px ${FONT}`;
  ctx.letterSpacing = '-0.02em';
  return ctx.measureText(text).width + BADGE_SIZE * 1.9;
}

function badge(ctx: CanvasRenderingContext2D, word: Word & { icon: Icon }, theme: Theme): void {
  const width = badgeWidth(ctx, word.text);
  const height = BADGE_SIZE * 1.5;
  roundedBox(ctx, -width / 2 + SHADOW, -height / 2 + SHADOW, width, height);
  ctx.fillStyle = css(theme.shadow);
  ctx.fill();
  roundedBox(ctx, -width / 2, -height / 2, width, height);
  ctx.fillStyle = css(theme.line);
  ctx.fill();
  ctx.save();
  ctx.translate(-width / 2 + BADGE_SIZE * 0.85, 0);
  if (word.icon === 'play-store') playStoreIcon(ctx, BADGE_SIZE * 0.9, theme);
  else appleIcon(ctx, BADGE_SIZE * 0.95, theme, css(theme.line));
  ctx.restore();
  ctx.font = `800 ${BADGE_SIZE}px ${FONT}`;
  ctx.letterSpacing = '-0.02em';
  ctx.textAlign = 'left';
  ctx.fillStyle = css(theme.surface);
  ctx.fillText(word.text, -width / 2 + BADGE_SIZE * 1.55, BADGE_SIZE * 0.04);
  ctx.textAlign = 'center';
}

// The store badges in one row, centred, each dropping in on its sixteenth.
function badges(ctx: CanvasRenderingContext2D, frame: number, words: readonly (Word & { icon: Icon })[], theme: Theme): void {
  const widths = words.map((word) => badgeWidth(ctx, word.text));
  let x = -(widths.reduce((sum, width) => sum + width, 0) + BADGE_GAP * (words.length - 1)) / 2;
  words.forEach((word, i) => {
    const width = widths[i] ?? 0;
    const p = dropIn(frame, word.at);
    if (p > 0) {
      ctx.save();
      ctx.translate(x + width / 2, BADGE_Y - (1 - p) * 120);
      ctx.scale(1 + (1 - p) * 0.4, 1 + (1 - p) * 0.4);
      badge(ctx, word, theme);
      ctx.restore();
    }
    x += width + BADGE_GAP;
  });
}

// The wordmark of the game header: "tick" in `--ink` and the "3d" sticker. The URL suffix slides out of the
// sticker to the right, so the whole line reads as the address. A third word group is the call to action, and
// the word groups after it, each with an icon, are the store badges.
function endCard(ctx: CanvasRenderingContext2D, frame: number, words: readonly Word[], theme: Theme): void {
  const [mark, suffix, action, ...rest] = words;
  const stores = rest.filter((word): word is Word & { icon: Icon } => word.icon !== undefined);
  if (mark === undefined || suffix === undefined || stores.length !== rest.length || !mark.text.endsWith('3d') || [mark, suffix, action].some((word) => word?.icon !== undefined)) {
    throw new Error('the end card needs the wordmark "…3d", the URL suffix, then a call to action and store badges with icons');
  }
  if (action !== undefined) wordAt(ctx, frame, action, CALL_TO_ACTION, theme);
  badges(ctx, frame, stores, theme);
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

// Draws the text of `frame` in `theme` on the whole canvas.
export function drawHud(ctx: CanvasRenderingContext2D, frame: number, theme: Theme): void {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(Math.min(width, height) / SQUARE, Math.min(width, height) / SQUARE);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  BEATS.text.forEach((line, index) => {
    // A line that lasts to the end of the 8 bars stays on the end card while the final chord rings.
    if (line.until < SPOT_SIXTEENTHS && frame >= frameOf(line.until)) return;
    if (line.style === 'end-card') {
      endCard(ctx, frame, line.words, theme);
      return;
    }
    if (line.style === 'list') {
      listLine(ctx, frame, line.words, theme);
      return;
    }
    const looks = LOOKS[line.style];
    if (looks.length < line.words.length || (line.style !== 'cards' && looks.length !== line.words.length)) {
      throw new Error(`text line ${index + 1} has ${line.words.length} word groups, and the '${line.style}' style has ${looks.length}`);
    }
    line.words.forEach((word, i) => {
      const look = looks[i];
      if (look !== undefined) wordAt(ctx, frame, word, look, theme, line.style === 'cards' ? line.words[i + 1]?.at : undefined);
    });
  });
  ctx.restore();
}
