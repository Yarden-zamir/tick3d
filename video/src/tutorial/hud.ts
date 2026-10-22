// The on-screen text of the tutorial, in the lettering of src/lettering.ts: the label of a section above the
// tower, the running count of the lines under it, the end card, the finger mark of a tap or a drag, and the turn
// frame around the picture.
import { interpolate } from 'remotion';
import { frameOf, since } from '../grid.ts';
import { BORDER, PX, SHADOW, type BadgeArt, type Look, css, endCard, onSquare, wordAt, wordWidth } from '../lettering.ts';
import { clamp } from '../rig.ts';
import { pulse } from '../stage.ts';
import type { Theme } from '../themes.ts';
import { type EventOf, SECTIONS, dragShare, eventsOf, sectionAt } from './plan.ts';

// The label: a plain line in the top band of the square, and a sticker under it. The tower stays below y -320.
const LABEL: Look = { y: -470, size: 96 };
const LABEL_STICKER: Look = { y: -380, size: 76, sticker: 'x', tilt: -4 };
// The plain line shrinks until it fits the square with a margin.
const LABEL_WIDTH = 980;
// The counter: the number in a `--win` sticker, the color of the lines, then the words. Under the tower.
const COUNT: Look = { y: 458, size: 84, sticker: 'win', tilt: -3 };
const COUNT_WORDS: Look = { y: 458, size: 60 };
const COUNT_GAP = 22;

// A label with the same text as the label before it keeps its words in place: only its sticker slams in again.
const LABELS = SECTIONS.flatMap((section) => section.labels);
function textAt(label: (typeof LABELS)[number]): number {
  let first = label;
  for (let i = LABELS.indexOf(label) - 1; i >= 0 && LABELS[i]?.text === label.text; i--) first = LABELS[i] ?? first;
  return first.at;
}

const sets = eventsOf('set').map(({ event }) => ({ at: event.at, count: event.lines.length }));
// The count rolls up to its new total over 2 sixteenths.
const ROLL = 2;

function label(ctx: CanvasRenderingContext2D, frame: number, theme: Theme): void {
  const shown = sectionAt(frame).labels.findLast((entry) => frame >= frameOf(entry.at));
  if (shown === undefined) return;
  let size = LABEL.size;
  while (wordWidth(ctx, shown.text, { ...LABEL, size }) > LABEL_WIDTH) size -= 2;
  wordAt(ctx, frame, { text: shown.text, at: textAt(shown) }, { ...LABEL, size }, theme);
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

// A point on the centre square, in its pixels from its middle, y down.
export type Point = { x: number; y: number };

// The finger mark: a `--surface` dot with a `--line` outline and a hard shadow, as a button of the game. A press
// pushes it into its shadow. `alpha` fades it.
const FINGER = 34;
function finger(ctx: CanvasRenderingContext2D, at: Point, press: number, alpha: number, theme: Theme): void {
  const drop = SHADOW * 1.5 * (1 - press);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(at.x - drop / 2, at.y - drop / 2);
  ctx.beginPath();
  ctx.arc(drop, drop, FINGER, 0, 2 * Math.PI);
  ctx.fillStyle = css(theme.shadow);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, FINGER, 0, 2 * Math.PI);
  ctx.fillStyle = css(theme.surface);
  ctx.fill();
  ctx.lineWidth = BORDER;
  ctx.strokeStyle = css(theme.line);
  ctx.stroke();
  ctx.restore();
}

// The ripple of a tap: 2 `--line` rings grow out of the finger and fade, the second half a sixteenth later.
function ripple(ctx: CanvasRenderingContext2D, at: Point, t: number, theme: Theme): void {
  for (const delay of [0, 0.75]) {
    const age = t - delay;
    if (age < 0 || age > 3) continue;
    ctx.save();
    ctx.globalAlpha = interpolate(age, [0, 3], [1, 0], clamp);
    ctx.beginPath();
    ctx.arc(at.x, at.y, FINGER + 90 * Math.sqrt(age / 3), 0, 2 * Math.PI);
    ctx.lineWidth = BORDER * 1.5;
    ctx.strokeStyle = css(theme.line);
    ctx.stroke();
    ctx.restore();
  }
}

// A tap: the finger comes in from the lower right over 2 sixteenths, presses on the tap, lifts 1 sixteenth later,
// and goes back the way it came while it fades, so the new X shows inside the ripple.
function tapCue(ctx: CanvasRenderingContext2D, frame: number, at: number, cell: Point, theme: Theme): void {
  const t = since(frame, at);
  if (t < -3 || t > 4) return;
  const away = t < 0 ? interpolate(t, [-3, -1], [1, 0], clamp) : interpolate(t, [1, 3], [0, 1], clamp);
  const where = { x: cell.x + 110 * away, y: cell.y + 130 * away };
  const press = t >= 0 && t < 1 ? 1 : 0;
  finger(ctx, where, press, Math.min(interpolate(t, [-3, -2], [0, 1], clamp), interpolate(t, [2, 4], [1, 0], clamp)), theme);
  ripple(ctx, cell, t, theme);
}

// A drag: under the tower, from the right to the left, so the front of the tower follows the finger. A trail
// of fading dots shows the way it came.
const DRAG_Y = 440;
const DRAG_HALF = 300;
function dragCue(ctx: CanvasRenderingContext2D, frame: number, drag: EventOf<'drag'>, theme: Theme): void {
  const t = since(frame, drag.at);
  if (t < -2 || t > drag.length + 3) return;
  const s16 = since(frame, 0);
  const xAt = (s: number) => DRAG_HALF - 2 * DRAG_HALF * dragShare(drag, s);
  const moving = t >= 0 && t <= drag.length;
  if (moving) {
    for (let i = 8; i >= 1; i--) {
      ctx.save();
      ctx.globalAlpha = 0.5 * (1 - i / 9);
      ctx.beginPath();
      ctx.arc(xAt(s16 - i * 0.3), DRAG_Y, FINGER * (1 - i / 14), 0, 2 * Math.PI);
      ctx.fillStyle = css(theme.line);
      ctx.fill();
      ctx.restore();
    }
  }
  const alpha = Math.min(interpolate(t, [-2, -1], [0, 1], clamp), interpolate(t, [drag.length + 1, drag.length + 3], [1, 0], clamp));
  finger(ctx, { x: xAt(s16), y: DRAG_Y }, moving ? 1 : 0, alpha, theme);
}

// The turn frame: a band around the whole picture in the color of the player to move, as the game page shows it,
// with a `--line` edge on its inside. It shows while a 'turns' event with `frame` is live, and swells when the turn
// changes. It stays at the edge, so it never covers the tower.
const FRAME_BAND = 14 * PX;
function turnFrame(ctx: CanvasRenderingContext2D, frame: number, theme: Theme): void {
  for (const { event, section } of eventsOf('turns')) {
    if (!event.frame || frame < frameOf(section.start) || frame >= frameOf(section.end)) continue;
    const placed = event.cells.filter((_, i) => frame >= frameOf(event.at + i * event.gap)).length;
    const band = FRAME_BAND * (1 + 0.4 * pulse(placed === 0 ? -1 : since(frame, event.at + (placed - 1) * event.gap)));
    const { width, height } = ctx.canvas;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = band;
    ctx.strokeStyle = css(theme[placed % 2 === 0 ? 'x' : 'o']);
    ctx.strokeRect(band / 2, band / 2, width - band, height - band);
    ctx.lineWidth = BORDER;
    ctx.strokeStyle = css(theme.line);
    ctx.strokeRect(band + BORDER / 2, band + BORDER / 2, width - 2 * band - BORDER, height - 2 * band - BORDER);
    ctx.restore();
  }
}

// Draws the text of `frame` in `theme` on the whole canvas. `cellAt` finds a cell of the tower on the square.
export function drawText(ctx: CanvasRenderingContext2D, frame: number, theme: Theme, art: BadgeArt, cellAt: (cell: number) => Point): void {
  onSquare(ctx, () => {
    turnFrame(ctx, frame, theme);
    label(ctx, frame, theme);
    if (sectionAt(frame).counter) counter(ctx, frame, theme);
    for (const { event } of [...eventsOf('tap'), ...eventsOf('undo')]) tapCue(ctx, frame, event.at, cellAt(event.cell), theme);
    for (const { event } of eventsOf('drag')) dragCue(ctx, frame, event, theme);
    for (const { event } of eventsOf('end-card')) endCard(ctx, frame, event.words, theme, art);
  });
}
