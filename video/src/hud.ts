// The on-screen text: the lines of beats.json, drawn on a 2D canvas that three.js shows as a texture.
// Layout units are pixels of the 1080 × 1080 centre square, origin in its middle, y down.
import { spring } from 'remotion';
import { SPOT_SIXTEENTHS, type TextStyle } from '../creative/beats.ts';
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

type Word = { text: string; at: number };
// A plain word: `--surface` letters with a thick `--line` outline and a hard shadow. A sticker: the "3d" of
// the wordmark, a `--line` box in a token color with `--on-color` letters, tilted by `tilt` degrees (-5 as in the
// wordmark).
type Look = { y: number; size: number; sticker?: Token; tilt?: number };

// The look of each word group of a line, by the style of the line ('end-card' draws with endCard).
const LOOKS: Readonly<Record<Exclude<TextStyle, 'end-card'>, readonly Look[]>> = {
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

// The call to action under the address: a small `--o` sticker.
const CALL_TO_ACTION: Look = { y: 420, size: 74, sticker: 'o', tilt: -3 };

// The wordmark of the game header: "tick" in `--ink` and the "3d" sticker. The URL suffix slides out of the
// sticker to the right, so the whole line reads as the address. An optional third word group is the call to action.
function endCard(ctx: CanvasRenderingContext2D, frame: number, words: readonly Word[], theme: Theme): void {
  const [mark, suffix, action, ...rest] = words;
  if (mark === undefined || suffix === undefined || rest.length > 0 || !mark.text.endsWith('3d')) {
    throw new Error('the end card needs the wordmark "…3d", the URL suffix and at most a call to action');
  }
  if (action !== undefined) wordAt(ctx, frame, action, CALL_TO_ACTION, theme);
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
