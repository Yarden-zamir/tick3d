// The on-screen text of the spot: the lines of beats.json, in the lettering of src/lettering.ts.
import { type Beats, SPOT_SIXTEENTHS } from '../creative/beats.ts';
import { BEAT_PULSE, type BadgeArt, type Look, type Word, beatBump, endCard, onSquare, sticker, wordAt } from './lettering.ts';
import { BEATS, frameOf, since } from './timeline.ts';
import type { Theme } from './themes.ts';

type TextStyle = Beats['text'][number]['style'];

// The look of each word group of a line, by the style of the line ('end-card' draws with endCard).
const LOOKS: Readonly<Record<Exclude<TextStyle, 'end-card' | 'list'>, readonly Look[]>> = {
  center: [{ y: -80, size: 132 }, { y: 100, size: 120, sticker: 'x' }],
  top: [{ y: -496, size: 100 }, { y: -398, size: 90, sticker: 'x' }],
};

// The 'list' style: a ticker that never stops. Each card enters the bottom row on its sixteenth and rises one row
// per gap between cards, at a constant speed, so two cards show at a time. A card fades in over its first 0.4 of
// a row and out over its last 0.4 row, before it reaches the top edge. The words must be evenly spaced, so the speed stays constant.
const LIST_BOTTOM = -410;
const LIST_ROW = 66;
const LIST_SIZE = 58;
const LIST_FADE = 0.4;

function listLine(ctx: CanvasRenderingContext2D, frame: number, line: { words: readonly Word[]; until: number }, theme: Theme): void {
  const { words, until } = line;
  const [first, second] = words;
  if (first === undefined || second === undefined) throw new Error('a list needs at least 2 cards');
  const gap = second.at - first.at;
  if (gap <= 0 || words.some((word, i) => word.at !== first.at + i * gap)) throw new Error('the cards of a list must be evenly spaced');
  // The whole list fades out over the last sixteenth before `until`.
  const ending = Math.min(1, Math.max(0, -since(frame, until)));
  words.forEach((word, i) => {
    const rows = since(frame, word.at) / gap;
    if (rows < 0 || rows >= 2) return;
    const fade = Math.min(1, rows / LIST_FADE, (2 - rows) / LIST_FADE);
    ctx.save();
    ctx.globalAlpha = fade * ending;
    ctx.translate(0, LIST_BOTTOM - rows * LIST_ROW);
    ctx.scale(1 + BEAT_PULSE * beatBump(frame), 1 + BEAT_PULSE * beatBump(frame));
    sticker(ctx, word.text, LIST_SIZE, i % 2 === 0 ? 'x' : 'o', theme, '-0.03em', i % 2 === 0 ? -3 : 3);
    ctx.restore();
  });
}

// Draws the text of `frame` in `theme` on the whole canvas.
export function drawHud(ctx: CanvasRenderingContext2D, frame: number, theme: Theme, art: BadgeArt): void {
  onSquare(ctx, () => {
    BEATS.text.forEach((line, index) => {
      // A line that lasts to the end of the 8 bars stays on the end card while the final chord rings.
      if (line.until < SPOT_SIXTEENTHS && frame >= frameOf(line.until)) return;
      if (line.style === 'end-card') {
        endCard(ctx, frame, line.words, theme, art);
        return;
      }
      if (line.style === 'list') {
        listLine(ctx, frame, line, theme);
        return;
      }
      const looks = LOOKS[line.style];
      if (looks.length !== line.words.length) {
        throw new Error(`text line ${index + 1} has ${line.words.length} word groups, and the '${line.style}' style has ${looks.length}`);
      }
      line.words.forEach((word, i) => {
        const look = looks[i];
        if (look !== undefined) wordAt(ctx, frame, word, look, theme);
      });
    });
  });
}
