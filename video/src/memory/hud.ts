// The 2D layer of the smart-memory ad: the text lines, the coordinate keypad of the game (index.html `.coords`,
// src/page/keypad.ts) and the thought line from the keypad to the cell of a placed move. Units of the square
// of the format (formats.ts), origin in its middle, y down.
import { Easing, interpolate } from 'remotion';
import { frameOf, since } from '../grid.ts';
import { BORDER, SHADOW, type BadgeArt, css, endCard, onSquare, wordAt, wordWidth } from '../lettering.ts';
import { clamp, cubic } from '../rig.ts';
import type { Theme, Token } from '../themes.ts';
import { type Area, minTextSize } from './formats.ts';
import { MOVES, digitsOf, playerOf } from './game.ts';
import { PLAN, eventOf, eventsOf, typingOf } from './plan.ts';

// The text: at least 96 units, and at least 6 % of the frame height. A line wraps into rows of TEXT_WIDTH.
const TEXT_SIZE = 96;
const TEXT_WIDTH = 1000;
const TEXT_TOP = -500;
// The keypad: three slots over four digit keys and Place. It slides up from under the frame.
const SLOT = { y: 250, width: 170, height: 136, gap: 26 } as const;
const KEY = { y: 410, width: 112, height: 92, gap: 20, place: 210 } as const;
const SLIDE = 3;
const LABELS = ['Layer', 'Row', 'Column'] as const;
// The Hide buttons of the game panel (index.html `.toggles`), above the slots, for a mask with `toggle`.
const TOGGLES = { y: 92, width: 196, height: 72, gap: 16 } as const;
const HIDE = ['Board', 'History', 'Coordinates'] as const;
// A pressed key lights for this many sixteenths.
const PRESS = 1.5;

const keypad = eventOf('keypad');
const mask = eventOf('mask');
const moves = eventsOf('move');

function box(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, fill: Token, theme: Theme): void {
  ctx.beginPath();
  ctx.roundRect(x + SHADOW, y + SHADOW, width, height, 16);
  ctx.fillStyle = css(theme.shadow);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 16);
  ctx.fillStyle = css(theme[fill]);
  ctx.fill();
  ctx.lineWidth = BORDER;
  ctx.strokeStyle = css(theme.line);
  ctx.stroke();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: Token, theme: Theme, alpha = 1): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `800 ${size}px "Bricolage Grotesque"`;
  ctx.letterSpacing = '-0.02em';
  ctx.fillStyle = css(theme[color]);
  ctx.fillText(text, x, y);
  ctx.restore();
}

// What the slots show at a frame: the digits that X types, else the last move in its player's color. With Hide
// coordinates on, the last move shows as `? ? ?` (src/page/keypad.ts renderCoords).
type Slots = { digits: readonly string[]; tint: 'x' | 'o' | 'surface'; masked: boolean };
function slotsAt(frame: number): Slots {
  const typing = moves.find((event) => {
    const [first] = typingOf(event);
    return first !== undefined && frame >= frameOf(first) && frame < frameOf(event.at);
  });
  if (typing !== undefined) {
    const typed = typingOf(typing).filter((at) => frame >= frameOf(at)).length;
    const cell = MOVES[typing.move];
    if (cell === undefined) throw new RangeError(`no move ${typing.move}`);
    return { digits: digitsOf(cell).slice(0, typed).map(String), tint: 'surface', masked: false };
  }
  const last = moves.findLast((event) => frame >= frameOf(event.at))?.move ?? PLAN.firstMove - 1;
  const cell = MOVES[last];
  if (cell === undefined) throw new RangeError(`no move ${last}`);
  const masked = frame >= frameOf(mask.at);
  return { digits: masked ? ['?', '?', '?'] : digitsOf(cell).map(String), tint: playerOf(last) === 'X' ? 'x' : 'o', masked };
}

// The digit key that X pressed last, and how long ago, in sixteenths. Place is key 4.
function pressAt(frame: number): { key: number; age: number } | undefined {
  const presses = moves.flatMap((event) => {
    const cell = MOVES[event.move];
    if (cell === undefined || playerOf(event.move) !== 'X') return [];
    const digits = digitsOf(cell);
    return [...typingOf(event).map((at, i) => ({ key: (digits[i] ?? 1) - 1, at })), { key: 4, at: event.at }];
  });
  const press = presses.findLast((entry) => frame >= frameOf(entry.at));
  if (press === undefined || since(frame, press.at) >= PRESS) return undefined;
  return { key: press.key, age: since(frame, press.at) };
}

// Board and History are on. Coordinates switches on at the mask, with a press into its shadow (`.btn:active`).
function drawToggles(ctx: CanvasRenderingContext2D, frame: number, theme: Theme): void {
  const rowWidth = 3 * TOGGLES.width + 2 * TOGGLES.gap;
  const age = since(frame, mask.at);
  label(ctx, 'Hide', -rowWidth / 2 + 40, TOGGLES.y - TOGGLES.height / 2 - 30, 30, 'ink', theme);
  HIDE.forEach((name, i) => {
    const on = i < 2 || age >= 0;
    const sink = i === 2 ? interpolate(age, [0, 0.3, PRESS], [0, SHADOW, 0], clamp) : 0;
    const x = -rowWidth / 2 + i * (TOGGLES.width + TOGGLES.gap) + sink;
    box(ctx, x, TOGGLES.y - TOGGLES.height / 2 + sink, TOGGLES.width, TOGGLES.height, on ? 'toggle-on' : 'surface', theme);
    label(ctx, name, x + TOGGLES.width / 2, TOGGLES.y + sink + 3, 32, on ? 'on-color' : 'ink', theme);
  });
}

function drawKeypad(ctx: CanvasRenderingContext2D, frame: number, theme: Theme): void {
  const shown = interpolate(since(frame, keypad.at), [0, SLIDE], [0, 1], { ...clamp, easing: Easing.out(Easing.back(1.4)) });
  const gone = interpolate(since(frame, keypad.until), [0, 2], [0, 1], { ...clamp, easing: Easing.in(cubic) });
  if (shown <= 0 || gone >= 1) return;
  ctx.save();
  ctx.translate(0, (1 - shown + gone) * 760);

  if (mask.toggle === true) drawToggles(ctx, frame, theme);
  const slots = slotsAt(frame);
  const slotsWidth = 3 * SLOT.width + 2 * SLOT.gap;
  LABELS.forEach((name, i) => {
    const x = -slotsWidth / 2 + i * (SLOT.width + SLOT.gap);
    const top = SLOT.y - SLOT.height / 2;
    box(ctx, x, top, SLOT.width, SLOT.height, slots.tint, theme);
    const ink = slots.tint === 'surface' ? 'ink' : 'on-color';
    label(ctx, name, x + SLOT.width / 2, top + 30, 26, ink, theme, 0.75);
    // Hide coordinates: each slot rolls its digit up and out, and `?` in from below, half a sixteenth apart.
    const roll = interpolate(since(frame, mask.at + 0.5 * i), [0, 1.5], [0, 1], { ...clamp, easing: Easing.inOut(cubic) });
    const digit = slots.digits[i] ?? '';
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, top + 48, SLOT.width, SLOT.height - 52);
    ctx.clip();
    const centre = top + 92;
    if (slots.masked && roll < 1) {
      const before = slotsAt(frameOf(mask.at) - 1).digits[i] ?? '';
      label(ctx, before, x + SLOT.width / 2, centre - roll * 90, 84, ink, theme);
      label(ctx, digit, x + SLOT.width / 2, centre + (1 - roll) * 90, 84, ink, theme);
    } else {
      label(ctx, digit, x + SLOT.width / 2, centre, 84, ink, theme);
    }
    ctx.restore();
  });

  const press = pressAt(frame);
  const keysWidth = 4 * KEY.width + KEY.place + 4 * KEY.gap;
  for (let key = 0; key < 5; key++) {
    const width = key === 4 ? KEY.place : KEY.width;
    const x = -keysWidth / 2 + key * (KEY.width + KEY.gap);
    const pressed = press?.key === key;
    // A pressed key moves into its shadow, as `.btn:active` does.
    const sink = pressed ? interpolate(press.age, [0, 0.3, PRESS], [0, SHADOW, 0], clamp) : 0;
    const fill: Token = key === 4 ? 'win' : pressed ? 'x' : 'surface';
    box(ctx, x + sink, KEY.y - KEY.height / 2 + sink, width, KEY.height, fill, theme);
    const ink = fill === 'surface' ? 'ink' : 'on-color';
    label(ctx, key === 4 ? 'Place' : String(key + 1), x + sink + width / 2, KEY.y + sink + 4, key === 4 ? 46 : 56, ink, theme);
  }
  ctx.restore();
}

// The thought line: a `--win` line with a `--line` outline from the top of the slots to the cell, drawn in over
// 1 sixteenth from the place, gone by 4.
function drawThought(ctx: CanvasRenderingContext2D, frame: number, theme: Theme, thought: { x: number; y: number; at: number }): void {
  const t = since(frame, thought.at);
  const length = interpolate(t, [0, 1], [0, 1], clamp);
  const alpha = interpolate(t, [2.5, 4], [1, 0], clamp);
  const to = thought;
  const from = { x: 0, y: SLOT.y - SLOT.height / 2 - 10 };
  const end = { x: from.x + (to.x - from.x) * length, y: from.y + (to.y - from.y) * length };
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.setLineDash([18, 16]);
  for (const [token, lineWidth] of [['line', 16], ['win', 8]] as const) {
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(end.x, end.y);
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = css(theme[token]);
    ctx.stroke();
  }
  ctx.restore();
}

// The rows of a text line: one row when it fits TEXT_WIDTH, else the two rows of the most even break. A line has
// at most 6 words (plan.test.ts), and two rows of 3 words always fit at the text sizes of the formats.
function rowsOf(ctx: CanvasRenderingContext2D, text: string, size: number): string[] {
  const words = text.split(' ');
  const width = (row: readonly string[]) => wordWidth(ctx, row.join(' '), { y: 0, size });
  if (width(words) <= TEXT_WIDTH) return [text];
  const breaks = words.slice(1).map((_, i) => [words.slice(0, i + 1), words.slice(i + 1)] as const);
  const [best] = breaks.toSorted((a, b) => Math.max(width(a[0]), width(a[1])) - Math.max(width(b[0]), width(b[1])));
  if (best === undefined || Math.max(width(best[0]), width(best[1])) > TEXT_WIDTH) throw new Error(`"${text}" does not fit two rows at ${size}`);
  return best.map((row) => row.join(' '));
}

export function drawHud(ctx: CanvasRenderingContext2D, frame: number, theme: Theme, art: BadgeArt, area: Area, height: number, thought: { x: number; y: number; at: number } | undefined): void {
  const size = Math.max(TEXT_SIZE, Math.ceil(minTextSize(height, area)));
  onSquare(
    ctx,
    () => {
      if (thought !== undefined) drawThought(ctx, frame, theme, thought);
      drawKeypad(ctx, frame, theme);
      for (const line of PLAN.text) {
        if (frame >= frameOf(line.until)) continue;
        rowsOf(ctx, line.text, size).forEach((row, i) => {
          wordAt(ctx, frame, { text: row, at: line.at }, { y: TEXT_TOP + size * 0.55 + i * size * 1.08, size }, theme);
        });
      }
      const card = eventOf('end-card');
      endCard(ctx, frame, [{ text: 'tick3d', at: card.at }, { text: '.yarden-zamir.com', at: card.at + 4 }], theme, art);
    },
    area,
  );
}
