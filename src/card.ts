// The end-of-game card. It is drawn on a canvas, so the picture on screen is the file that is shared.
import { type Game, SIZE, toCell } from './game.ts';

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
};

const WIDTH = 1080;
const HEIGHT = 1350;
const COLORS = { bg: '#0b0d1a', ink: '#eef0ff', muted: '#9aa0c3', x: '#ff6b8b', xDeep: '#c2186b', o: '#46d9ff', oDeep: '#3a49d8', gold: '#ffd36b' };
const FONT = "'Outfit', ui-rounded, system-ui, sans-serif";

async function loadFonts(): Promise<void> {
  try {
    await Promise.all([document.fonts.load(`800 64px ${FONT}`), document.fonts.load(`400 32px ${FONT}`)]);
  } catch {
    // The web font failed to load. The canvas then uses the system font.
  }
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('canvas 2d context is not available');
  return ctx;
}

function background(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  for (const [x, y, color] of [
    [0, 0, 'rgba(255, 107, 139, 0.28)'],
    [WIDTH, HEIGHT, 'rgba(70, 217, 255, 0.24)'],
  ] as const) {
    const glow = ctx.createRadialGradient(x, y, 0, x, y, 800);
    glow.addColorStop(0, color);
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }
}

function text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, size: number, weight: number, color: string, align: CanvasTextAlign = 'left'): void {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(value, x, y);
}

function brand(ctx: CanvasRenderingContext2D, date: Date): void {
  text(ctx, 'tick', 80, 130, 76, 800, COLORS.ink);
  const tickWidth = ctx.measureText('tick').width;
  const gradient = ctx.createLinearGradient(80 + tickWidth, 0, 80 + tickWidth + 90, 0);
  gradient.addColorStop(0, COLORS.x);
  gradient.addColorStop(0.5, COLORS.gold);
  gradient.addColorStop(1, COLORS.o);
  ctx.font = `800 76px ${FONT}`;
  ctx.fillStyle = gradient;
  ctx.fillText('3d', 80 + tickWidth, 130);
  const day = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  text(ctx, day, WIDTH - 80, 125, 32, 400, COLORS.muted, 'right');
}

function piece(ctx: CanvasRenderingContext2D, mark: 'X' | 'O', x: number, y: number, size: number): void {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const radius = size * 0.34;
  const [light, deep] = mark === 'X' ? [COLORS.x, COLORS.xDeep] : [COLORS.o, COLORS.oDeep];
  const fill = ctx.createRadialGradient(cx - radius * 0.4, cy - radius * 0.4, radius * 0.1, cx, cy, radius);
  fill.addColorStop(0, '#ffffff');
  fill.addColorStop(0.3, light);
  fill.addColorStop(1, deep);
  ctx.save();
  ctx.shadowColor = light;
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  if (mark === 'X') {
    ctx.fillStyle = fill;
    ctx.fill();
  } else {
    // A ring like the O on the board: outer edge at the radius, hole at about half of it.
    const ring = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
    ring.addColorStop(0, light);
    ring.addColorStop(1, deep);
    ctx.strokeStyle = ring;
    ctx.lineWidth = radius * 0.45;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.775, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// The four layers in a 2 x 2 grid, with the winning line in gold and the last move outlined.
function board(ctx: CanvasRenderingContext2D, game: Game, top: number): void {
  const cell = 64;
  const gap = 8;
  const side = SIZE * cell + (SIZE + 1) * gap;
  const columnGap = 70;
  const left = (WIDTH - (2 * side + columnGap)) / 2;
  const winLine: readonly number[] = game.status.kind === 'won' ? game.status.line : [];
  const last = game.moves.at(-1);
  for (let layer = 0; layer < SIZE; layer++) {
    const x0 = left + (layer % 2) * (side + columnGap);
    const y0 = top + Math.floor(layer / 2) * (side + 70);
    text(ctx, `LAYER ${layer + 1}`, x0, y0 - 14, 24, 400, COLORS.muted);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x0, y0, side, side, 22);
    ctx.fill();
    ctx.stroke();
    for (let row = 0; row < SIZE; row++) {
      for (let column = 0; column < SIZE; column++) {
        const index = toCell({ layer, row, column });
        const x = x0 + gap + column * (cell + gap);
        const y = y0 + gap + row * (cell + gap);
        const isWin = winLine.includes(index);
        ctx.fillStyle = isWin ? 'rgba(255, 211, 107, 0.3)' : 'rgba(255, 255, 255, 0.07)';
        ctx.beginPath();
        ctx.roundRect(x, y, cell, cell, 14);
        ctx.fill();
        if (isWin || index === last) {
          ctx.save();
          ctx.strokeStyle = isWin ? COLORS.gold : 'rgba(255, 255, 255, 0.6)';
          ctx.lineWidth = isWin ? 4 : 3;
          if (isWin) {
            ctx.shadowColor = COLORS.gold;
            ctx.shadowBlur = 20;
          }
          ctx.stroke();
          ctx.restore();
        }
        const mark = game.board[index];
        if (mark === 'X' || mark === 'O') piece(ctx, mark, x, y, cell);
      }
    }
  }
}

export async function drawCard(input: CardInput): Promise<HTMLCanvasElement> {
  await loadFonts();
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = context(canvas);
  background(ctx);
  brand(ctx, input.date);
  const won = input.game.status.kind !== 'draw';
  text(ctx, input.title, WIDTH / 2, 290, 104, 800, won ? COLORS.gold : COLORS.ink, 'center');
  text(ctx, input.subtitle, WIDTH / 2, 355, 40, 400, COLORS.muted, 'center');
  board(ctx, input.game, 450);
  text(ctx, input.matchup, 80, 1215, 40, 600, COLORS.ink);
  text(ctx, input.details, 80, 1265, 30, 400, COLORS.muted);
  text(ctx, input.footer, 80, 1310, 30, 400, COLORS.o);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas produced no image'))), 'image/png');
  });
}

export async function saveImage(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  const url = URL.createObjectURL(await toBlob(canvas));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export type ShareOutcome = 'shared' | 'cancelled' | 'copied' | 'saved';

// Shares the image with the system share sheet. Without file sharing (most desktop browsers),
// the image goes to the clipboard, and without clipboard images it downloads.
export async function shareImage(canvas: HTMLCanvasElement, filename: string, text: string, url?: string): Promise<ShareOutcome> {
  const blob = await toBlob(canvas);
  const data: ShareData = { files: [new File([blob], filename, { type: 'image/png' })], title: 'tick3d', text };
  if (url !== undefined) data.url = url;
  if (typeof navigator.canShare === 'function' && navigator.canShare(data)) {
    try {
      await navigator.share(data);
      return 'shared';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return 'copied';
  } catch {
    await saveImage(canvas, filename);
    return 'saved';
  }
}
