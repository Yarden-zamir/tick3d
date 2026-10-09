// The on-screen text of the tutorial, in the lettering of src/lettering.ts: the label of a section above the
// tower, the running count of the lines under it, and the end card.
import { frameOf, since } from '../grid.ts';
import { type Look, endCard, onSquare, wordAt, wordWidth } from '../lettering.ts';
import { pulse } from '../stage.ts';
import type { Theme } from '../themes.ts';
import { linesOf } from './lines.ts';
import { eventsOf, sectionAt } from './plan.ts';

// The label: a plain line in the top band of the square, and a sticker under it. The tower stays below y -320.
const LABEL: Look = { y: -470, size: 96 };
const LABEL_STICKER: Look = { y: -380, size: 76, sticker: 'x', tilt: -4 };
// The plain line shrinks until it fits the square with a margin.
const LABEL_WIDTH = 980;
// The counter: the number in a `--win` sticker, the color of the lines, then the words. Under the tower.
const COUNT: Look = { y: 458, size: 84, sticker: 'win', tilt: -3 };
const COUNT_WORDS: Look = { y: 458, size: 60 };
const COUNT_GAP = 22;

const sets = eventsOf('set').map(({ event }) => ({ at: event.at, count: linesOf(event.lines).length }));
// The count rolls up to its new total over 2 sixteenths.
const ROLL = 2;

function label(ctx: CanvasRenderingContext2D, frame: number, theme: Theme): void {
  const shown = sectionAt(frame).labels.findLast((entry) => frame >= frameOf(entry.at));
  if (shown === undefined) return;
  let size = LABEL.size;
  while (wordWidth(ctx, shown.text, { ...LABEL, size }) > LABEL_WIDTH) size -= 2;
  wordAt(ctx, frame, { text: shown.text, at: shown.at }, { ...LABEL, size }, theme);
  wordAt(ctx, frame, { text: shown.sticker, at: shown.stickerAt }, LABEL_STICKER, theme);
}

function counter(ctx: CanvasRenderingContext2D, frame: number, theme: Theme): void {
  const done = sets.filter((set) => frame >= frameOf(set.at));
  const [first] = sets;
  const last = done.at(-1);
  if (first === undefined || last === undefined) return;
  const total = done.reduce((sum, set) => sum + set.count, 0);
  const t = since(frame, last.at);
  const shown = String(Math.round(total - last.count * Math.max(0, 1 - t / ROLL)));
  const words = 'ways to win';
  // The width of the new total, so the words do not shift while the number rolls.
  const numberWidth = wordWidth(ctx, String(total), COUNT);
  const left = -(numberWidth + COUNT_GAP + wordWidth(ctx, words, COUNT_WORDS)) / 2;
  ctx.save();
  ctx.translate(left + numberWidth / 2, COUNT.y);
  ctx.scale(1 + 0.15 * pulse(t), 1 + 0.15 * pulse(t));
  wordAt(ctx, frame, { text: shown, at: first.at }, { ...COUNT, y: 0 }, theme);
  ctx.restore();
  ctx.save();
  ctx.translate(left + numberWidth + COUNT_GAP + wordWidth(ctx, words, COUNT_WORDS) / 2, 0);
  wordAt(ctx, frame, { text: words, at: first.at }, COUNT_WORDS, theme);
  ctx.restore();
}

// Draws the text of `frame` in `theme` on the whole canvas.
export function drawText(ctx: CanvasRenderingContext2D, frame: number, theme: Theme): void {
  onSquare(ctx, () => {
    label(ctx, frame, theme);
    if (sectionAt(frame).counter) counter(ctx, frame, theme);
    for (const { event } of eventsOf('end-card')) {
      endCard(ctx, frame, [{ text: 'tick3d', at: event.at }, { text: '.yarden-zamir.com', at: event.at + 4 }], theme);
    }
  });
}
