// The end-of-game card. It is drawn on a canvas, so the picture on screen is the file that is shared.
import { type Game, SIZE, toCell, toCoords } from './game.ts';
import type { RecordNews } from './records.ts';

export type CardInput = {
  game: Game;
  title: string;
  subtitle: string;
  // For example "vs Computer · Hard" or "Online · Friday rematch".
  matchup: string;
  details: string;
  date: Date;
  // Printed at the bottom: the game link, or only the site address.
  footer: string;
  // A survival record against the computer that this game broke.
  record?: RecordNews;
};

const WIDTH = 1080;
const HEIGHT = 1350;
const FONT = "'Bricolage Grotesque', ui-rounded, system-ui, sans-serif";
// The same X as the board: a cross cut from a square, as fractions of the piece box.
const X_SHAPE = [
  [0.2, 0], [0.5, 0.3], [0.8, 0], [1, 0.2], [0.7, 0.5], [1, 0.8],
  [0.8, 1], [0.5, 0.7], [0.2, 1], [0, 0.8], [0.3, 0.5], [0, 0.2],
] as const;

type Theme = Record<
  'page' | 'dot' | 'surface' | 'ink' | 'muted' | 'line' | 'shadow' | 'slab' | 'x' | 'o' | 'win' | 'onColor',
  string
>;

// The card uses the active theme, so it matches the page it came from.
function theme(): Theme {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => {
    const value = css.getPropertyValue(`--${name}`).trim();
    if (value === '') throw new Error(`theme token --${name} is not set`);
    return value;
  };
  return {
    page: token('page'),
    dot: token('dot'),
    surface: token('surface'),
    ink: token('ink'),
    muted: token('muted'),
    line: token('line'),
    shadow: token('shadow'),
    slab: token('slab'),
    x: token('x'),
    o: token('o'),
    win: token('win'),
    onColor: token('on-color'),
  };
}

async function loadFonts(): Promise<void> {
  try {
    await Promise.all([document.fonts.load(`800 64px ${FONT}`), document.fonts.load(`600 32px ${FONT}`)]);
  } catch {
    // The web font failed to load. The canvas then uses the system font.
  }
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('canvas 2d context is not available');
  return ctx;
}

type Box = { x: number; y: number; w: number; h: number; fill: string; radius: number; border: number; shadow: number };

// A brutalist block: a hard offset shadow, a flat fill and a thick outline.
function block(ctx: CanvasRenderingContext2D, t: Theme, { x, y, w, h, fill, radius, border, shadow }: Box): void {
  ctx.fillStyle = t.shadow;
  ctx.beginPath();
  ctx.roundRect(x + shadow, y + shadow, w, h, radius);
  ctx.fill();
  ctx.fillStyle = fill;
  ctx.strokeStyle = t.line;
  ctx.lineWidth = border;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fill();
  ctx.stroke();
}

function text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, size: number, weight: number, color: string, align: CanvasTextAlign = 'left'): void {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(value, x, y);
}

// Shrinks the text until it fits `maxWidth`, so a long line never runs off the card.
function fittedText(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  size: number,
  weight: number,
  color: string,
  maxWidth: number,
  align: CanvasTextAlign = 'left',
): void {
  let fitted = size;
  ctx.font = `${weight} ${fitted}px ${FONT}`;
  while (fitted > 16 && ctx.measureText(value).width > maxWidth) {
    fitted--;
    ctx.font = `${weight} ${fitted}px ${FONT}`;
  }
  text(ctx, value, x, y, fitted, weight, color, align);
}

// A sticker in the gap between the wordmark and the date, tilted like the "3d" of the wordmark.
function recordSticker(ctx: CanvasRenderingContext2D, t: Theme, record: RecordNews): void {
  ctx.save();
  ctx.translate(WIDTH / 2 + 55, 150);
  ctx.rotate((4 * Math.PI) / 180);
  block(ctx, t, { x: -125, y: -44, w: 250, h: 88, fill: t.o, radius: 12, border: 5, shadow: 7 });
  text(ctx, 'New record', 0, -4, 36, 800, t.onColor, 'center');
  text(ctx, `best was ${record.previous} ${record.previous === 1 ? 'move' : 'moves'}`, 0, 28, 22, 700, t.onColor, 'center');
  ctx.restore();
}

function background(ctx: CanvasRenderingContext2D, t: Theme): void {
  ctx.fillStyle = t.page;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = t.dot;
  for (let y = 22; y < HEIGHT; y += 44) {
    for (let x = 22; x < WIDTH; x += 44) {
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// The wordmark: "tick" with the "3d" sticker, as in the page header.
function brand(ctx: CanvasRenderingContext2D, t: Theme, date: Date): void {
  text(ctx, 'tick', 80, 150, 96, 800, t.ink);
  const width = ctx.measureText('tick').width;
  ctx.save();
  ctx.translate(80 + width + 66, 116);
  ctx.rotate((-5 * Math.PI) / 180);
  block(ctx, t, { x: -58, y: -52, w: 116, h: 100, fill: t.x, radius: 12, border: 6, shadow: 8 });
  text(ctx, '3d', 0, 30, 84, 800, t.onColor, 'center');
  ctx.restore();
  const day = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  // A long localized date shrinks, so its box never reaches the record sticker at x 720.
  const maxText = 236;
  ctx.font = `700 30px ${FONT}`;
  const dayWidth = Math.min(ctx.measureText(day).width, maxText) + 44;
  block(ctx, t, { x: WIDTH - 80 - dayWidth, y: 80, w: dayWidth, h: 64, fill: t.surface, radius: 10, border: 4, shadow: 6 });
  fittedText(ctx, day, WIDTH - 80 - dayWidth / 2, 123, 30, 700, t.ink, maxText, 'center');
}

// `outline` is the line color, or the on-color on a winning cell, so a piece never melts into its cell.
function xPiece(ctx: CanvasRenderingContext2D, t: Theme, x: number, y: number, size: number, outline: string): void {
  ctx.beginPath();
  X_SHAPE.forEach(([fx, fy], i) => (i === 0 ? ctx.moveTo(x + fx * size, y + fy * size) : ctx.lineTo(x + fx * size, y + fy * size)));
  ctx.closePath();
  ctx.fillStyle = t.x;
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = 3;
  ctx.stroke();
}

function oPiece(ctx: CanvasRenderingContext2D, t: Theme, x: number, y: number, size: number, outline: string): void {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const outer = size * 0.48;
  const thickness = size * 0.26;
  ctx.beginPath();
  ctx.arc(cx, cy, outer - thickness / 2, 0, Math.PI * 2);
  ctx.strokeStyle = t.o;
  ctx.lineWidth = thickness;
  ctx.stroke();
  ctx.strokeStyle = outline;
  ctx.lineWidth = 3;
  for (const radius of [outer, outer - thickness]) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// The board of the card: four layers in a 2 x 2 grid of slabs.
const BOARD_TOP = 490;
const CELL = 58;
const CELL_GAP = 9;
const SLAB = SIZE * CELL + (SIZE + 1) * CELL_GAP;
const SLAB_GAP = 80;
const slabOrigin = (layer: number) => ({
  x: (WIDTH - (2 * SLAB + SLAB_GAP)) / 2 + (layer % 2) * (SLAB + SLAB_GAP),
  y: BOARD_TOP + Math.floor(layer / 2) * (SLAB + 84),
});

// The place of a cell in the card, as shares of the card width and height, for a highlight over the image.
export function cardCellBox(index: number): { left: number; top: number; width: number; height: number } {
  const { layer, row, column } = toCoords(index);
  const { x, y } = slabOrigin(layer);
  return {
    left: (x + CELL_GAP + column * (CELL + CELL_GAP)) / WIDTH,
    top: (y + CELL_GAP + row * (CELL + CELL_GAP)) / HEIGHT,
    width: CELL / WIDTH,
    height: CELL / HEIGHT,
  };
}

// The four layers, with the winning line filled and the last move dashed.
function board(ctx: CanvasRenderingContext2D, t: Theme, game: Game): void {
  const cell = CELL;
  const gap = CELL_GAP;
  const side = SLAB;
  const winLine: readonly number[] = game.status.kind === 'won' ? game.status.line : [];
  const last = game.moves.at(-1);
  for (let layer = 0; layer < SIZE; layer++) {
    const { x: x0, y: y0 } = slabOrigin(layer);
    block(ctx, t, { x: x0, y: y0 - 50, w: 128, h: 38, fill: t.surface, radius: 8, border: 3, shadow: 3 });
    text(ctx, `Layer ${layer + 1}`, x0 + 64, y0 - 22, 24, 800, t.ink, 'center');
    block(ctx, t, { x: x0, y: y0, w: side, h: side, fill: t.slab, radius: 16, border: 5, shadow: 8 });
    for (let row = 0; row < SIZE; row++) {
      for (let column = 0; column < SIZE; column++) {
        const index = toCell({ layer, row, column });
        const x = x0 + gap + column * (cell + gap);
        const y = y0 + gap + row * (cell + gap);
        const isWin = winLine.includes(index);
        block(ctx, t, { x, y, w: cell, h: cell, fill: isWin ? t.win : t.surface, radius: 10, border: 3, shadow: 3 });
        if (index === last) {
          ctx.save();
          ctx.setLineDash([8, 6]);
          ctx.lineWidth = 5;
          ctx.strokeStyle = t.line;
          ctx.beginPath();
          ctx.roundRect(x + 4, y + 4, cell - 8, cell - 8, 8);
          ctx.stroke();
          ctx.restore();
        }
        const mark = game.board[index];
        const inset = cell * 0.16;
        const outline = isWin ? t.onColor : t.line;
        if (mark === 'X') xPiece(ctx, t, x + inset, y + inset, cell - 2 * inset, outline);
        if (mark === 'O') oPiece(ctx, t, x + inset, y + inset, cell - 2 * inset, outline);
      }
    }
  }
}

export async function drawCard(input: CardInput): Promise<HTMLCanvasElement> {
  await loadFonts();
  const t = theme();
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = context(canvas);
  background(ctx, t);
  brand(ctx, t, input.date);
  const decided = input.game.status.kind !== 'draw';
  const bannerText = decided ? t.onColor : t.ink;
  block(ctx, t, { x: 80, y: 210, w: WIDTH - 160, h: 200, fill: decided ? t.win : t.surface, radius: 16, border: 6, shadow: 12 });
  fittedText(ctx, input.title, WIDTH / 2, 322, 104, 800, bannerText, WIDTH - 220, 'center');
  fittedText(ctx, input.subtitle, WIDTH / 2, 378, 38, 600, bannerText, WIDTH - 220, 'center');
  if (input.record !== undefined) recordSticker(ctx, t, input.record);
  // Board rows: 490 + 2 slabs of 277 + 84 between them ends at 1128, clear of the box at 1170.
  board(ctx, t, input.game);
  block(ctx, t, { x: 80, y: 1170, w: WIDTH - 160, h: input.footer === '' ? 104 : 140, fill: t.surface, radius: 14, border: 5, shadow: 10 });
  fittedText(ctx, input.matchup, 110, 1220, 38, 800, t.ink, WIDTH - 220);
  fittedText(ctx, input.details, 110, 1258, 26, 600, t.muted, WIDTH - 220);
  if (input.footer !== '') fittedText(ctx, input.footer, 110, 1294, 28, 800, t.ink, WIDTH - 220);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas produced no image'))), 'image/png');
  });
}

// The file name of a card image, or of the song of the game.
export function cardFilename(extension: 'png' | 'wav'): string {
  return `tick3d-${new Date().toISOString().slice(0, 10)}.${extension}`;
}

export async function saveImage(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  saveFile(await toBlob(canvas), filename);
}

// Downloads the file.
function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export type ShareOutcome = 'shared' | 'cancelled' | 'copied' | 'saved';

// The system share sheet. 'unsupported' means that the browser cannot share these files, or that the
// share failed for another reason than a cancel.
async function systemShare(data: ShareData): Promise<'shared' | 'cancelled' | 'unsupported'> {
  if (typeof navigator.canShare !== 'function' || !navigator.canShare(data)) return 'unsupported';
  try {
    await navigator.share(data);
    return 'shared';
  } catch (error) {
    return error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'unsupported';
  }
}

// Shares the image with the system share sheet. Without file sharing (most desktop browsers),
// the image goes to the clipboard, and without clipboard images it downloads.
export async function shareImage(canvas: HTMLCanvasElement, filename: string, text: string, url?: string): Promise<ShareOutcome> {
  const blob = await toBlob(canvas);
  const data: ShareData = { files: [new File([blob], filename, { type: 'image/png' })], title: 'tick3d', text };
  if (url !== undefined) data.url = url;
  const shared = await systemShare(data);
  if (shared !== 'unsupported') return shared;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return 'copied';
  } catch {
    saveFile(blob, filename);
    return 'saved';
  }
}

// Shares a file with the system share sheet. Without file sharing (most desktop browsers), it downloads.
export async function shareFile(file: File, text: string): Promise<Exclude<ShareOutcome, 'copied'>> {
  const shared = await systemShare({ files: [file], title: 'tick3d', text });
  if (shared !== 'unsupported') return shared;
  saveFile(file, file.name);
  return 'saved';
}
