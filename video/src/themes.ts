// The look of the game, read from src/style.css in the render browser: the theme tokens and the X shape.
// The stylesheet is the only source. No color or shape is typed again here.
import '../../src/style.css';
import type { Beats } from '../creative/beats.ts';

export type ThemeId = Beats['bars'][number]['theme'];

const TOKENS = ['page', 'dot', 'surface', 'ink', 'line', 'shadow', 'slab', 'x', 'o', 'win', 'on-color'] as const;
export type Token = (typeof TOKENS)[number];

// Channels from 0 to 1, as the browser computes them (sRGB, no conversion).
export type Rgba = { r: number; g: number; b: number; a: number };
export type Theme = Readonly<Record<Token, Rgba>>;

// "rgb(255, 82, 119)" or "rgba(0, 0, 0, 0.14)": the computed form of every CSS color.
function parseComputedColor(text: string): Rgba {
  const open = text.indexOf('(');
  const inside = text.slice(open + 1, text.lastIndexOf(')'));
  const parts = inside.replaceAll(',', ' ').replaceAll('/', ' ').split(' ').filter(Boolean).map(Number);
  const [r, g, b, a = 1] = parts;
  if (open < 0 || r === undefined || g === undefined || b === undefined || parts.length > 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new TypeError(`not a computed color: ${text}`);
  }
  return { r: r / 255, g: g / 255, b: b / 255, a };
}

// An element in the page while `read` runs, so the browser computes its styles.
function withElement<T>(html: string, read: (root: HTMLElement) => T): T {
  const root = document.createElement('div');
  root.innerHTML = html;
  root.style.position = 'absolute';
  root.style.visibility = 'hidden';
  document.body.append(root);
  try {
    return read(root);
  } finally {
    root.remove();
  }
}

export function readTheme(id: ThemeId): Theme {
  return withElement(`<div data-theme="${id}"><i></i></div>`, (root) => {
    const probe = root.querySelector('i');
    if (probe === null) throw new Error('the theme probe is missing');
    const entries = TOKENS.map((token) => {
      probe.style.color = `var(--${token})`;
      return [token, parseComputedColor(getComputedStyle(probe).color)] as const;
    });
    return Object.fromEntries(entries) as Record<Token, Rgba>;
  });
}

// The corners of the X: the clip-path polygon of `.x .piece::before`, from 0 to 1 across the piece, y down.
export function readXPolygon(): readonly (readonly [number, number])[] {
  return withElement('<div class="cell x"><span class="piece"></span></div>', (root) => {
    const piece = root.querySelector('.piece');
    if (piece === null) throw new Error('the piece probe is missing');
    const clip = getComputedStyle(piece, '::before').clipPath;
    if (!clip.startsWith('polygon(') || !clip.endsWith(')')) throw new TypeError(`the X is not a polygon: ${clip}`);
    const share = (value: string) => {
      // A bare 0 computes to 0px. Any other length would depend on the size of the cell.
      if (value === '0px' || value === '0') return 0;
      if (!value.endsWith('%')) throw new TypeError(`an X corner is not a percentage: ${value}`);
      return Number(value.slice(0, -1)) / 100;
    };
    return clip
      .slice('polygon('.length, -1)
      .split(',')
      .map((point) => {
        const [x, y, ...rest] = point.trim().split(' ');
        if (x === undefined || y === undefined || rest.length > 0) throw new TypeError(`not an X corner: ${point}`);
        return [share(x), share(y)] as const;
      });
  });
}
