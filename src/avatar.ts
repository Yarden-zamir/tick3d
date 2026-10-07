// The picture of a player: the GitHub avatar after a login, else a generated "tower".
// The tower is a 4×4 grid of block columns, 0 to 4 blocks high, drawn in isometric view like the board.
// It is mirrored on the diagonal, so it reads as one shape at 20 px. One column is "lit" in a second color.
//
// The seed is the name that the page shows next to the picture (the login, the custom name or the
// generated name). Every screen has that name, so every screen draws the same picture without a
// player token. Limit: a rename gives a new picture, and two players with one name share a picture.
// Revisit when the view sends a public player id.
import { hash } from './names.ts';
import type { PlayerInfo } from './protocol.ts';

// Each palette has its own dark background, so the picture reads the same in every theme.
type Palette = { background: string; base: string; top: string; side: string; lit: string; litSide: string };
const PALETTES: readonly Palette[] = [
  { background: '#2b2350', base: '#5a537a', top: '#ff5277', side: '#b3203f', lit: '#ffe14d', litSide: '#b8a238' },
  { background: '#14324a', base: '#4b6578', top: '#00b3ff', side: '#00679a', lit: '#ff5277', litSide: '#b83b56' },
  { background: '#3b1d4f', base: '#6b5279', top: '#c792ff', side: '#7a45b8', lit: '#7cff8a', litSide: '#59b863' },
  { background: '#173d33', base: '#4c6c64', top: '#7cff8a', side: '#2fa046', lit: '#ff9f45', litSide: '#b87232' },
  { background: '#4a2a12', base: '#7a5e49', top: '#ffc94d', side: '#c0841a', lit: '#00b3ff', litSide: '#0081b8' },
  { background: '#3d1525', base: '#6e4d5a', top: '#ff9f45', side: '#b85a12', lit: '#c792ff', litSide: '#8f69b8' },
  { background: '#1d2a44', base: '#526075', top: '#ffe14d', side: '#b59a10', lit: '#ff7ad9', litSide: '#b8589c' },
  { background: '#2a2a2a', base: '#5c5c5c', top: '#ff7ad9', side: '#b33b92', lit: '#00b3ff', litSide: '#0081b8' },
  { background: '#0f3b3b', base: '#4a6f6f', top: '#4dfff0', side: '#16a89c', lit: '#ff5277', litSide: '#b83b56' },
  { background: '#402040', base: '#73577a', top: '#ffe14d', side: '#b59a10', lit: '#00b3ff', litSide: '#0081b8' },
  { background: '#1a2b1a', base: '#4f604f', top: '#ff9f45', side: '#b85a12', lit: '#7cff8a', litSide: '#59b863' },
  { background: '#2d1f3d', base: '#5e5070', top: '#ff8a8a', side: '#b34f4f', lit: '#4dfff0', litSide: '#16a89c' },
];

// mulberry32: a small seeded random number generator, so one seed always gives one picture.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIZE = 64;
const HALF_WIDTH = 6.5; // half the width of one cell on screen
const HALF_DEPTH = 3.25; // half the depth of one cell on screen
const BLOCK = 6.5; // the height of one block on screen
const SIDE_DARK = 0.7; // the right side of a block is darker than the left side
const BELOW_TOP = 0.85; // the top face of a block under another block, seen only through gaps

function darker(hex: string, factor: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [value >> 16, (value >> 8) & 255, value & 255].map((channel) => Math.round(channel * factor));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

type Point = readonly [number, number];
const polygon = (points: readonly Point[], fill: string) =>
  `<polygon points="${points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')}" fill="${fill}"/>`;

// The SVG markup of the generated picture for a seed. The same seed always gives the same markup.
export function avatarSvg(seed: string): string {
  if (seed === '') throw new Error('an avatar seed is empty');
  const next = random(hash(seed));
  const palette = PALETTES[Math.floor(next() * PALETTES.length)];
  if (palette === undefined) throw new Error('the avatar palettes are empty');
  // Heights, mirrored on the diagonal. Low columns are more common, so the tall ones stand out.
  // At least 4 columns have blocks, so no picture is almost empty.
  const heights = Array.from({ length: 16 }, () => 0);
  const heightAt = (i: number, j: number) => heights[i * 4 + j] ?? 0;
  do {
    for (let i = 0; i < 4; i++) {
      for (let j = i; j < 4; j++) {
        const height = Math.floor(next() ** 1.6 * 5);
        heights[i * 4 + j] = height;
        heights[j * 4 + i] = height;
      }
    }
  } while (heights.filter((height) => height > 0).length < 4);
  const tallest = Math.max(...heights);
  // The lit column is one of the tallest columns, with its mirror.
  const tallCells = heights.flatMap((height, cell) => (height === tallest ? [[Math.floor(cell / 4), cell % 4] as const] : []));
  const lit = tallCells[Math.floor(next() * tallCells.length)];
  if (lit === undefined) throw new Error('an avatar has no tallest column');
  const isLit = (i: number, j: number) => (i === lit[0] && j === lit[1]) || (i === lit[1] && j === lit[0]);

  // Centers the drawing, from the top of the tallest column to the bottom corner of the base.
  const baseTop = SIZE / 2 - 4 * HALF_DEPTH + (tallest * BLOCK) / 2;
  const at = (i: number, j: number, k: number): Point => [SIZE / 2 + (i - j) * HALF_WIDTH, baseTop + (i + j) * HALF_DEPTH - k * BLOCK];
  let body = polygon([at(0, 0, 0), at(4, 0, 0), at(4, 4, 0), at(0, 4, 0)], palette.base);
  // Back to front: a cell with a larger i + j is nearer, so it draws later.
  for (let diagonal = 0; diagonal < 7; diagonal++) {
    for (let i = 0; i < 4; i++) {
      const j = diagonal - i;
      if (j < 0 || j > 3) continue;
      const top = isLit(i, j) ? palette.lit : palette.top;
      const side = isLit(i, j) ? palette.litSide : palette.side;
      for (let k = 0; k < heightAt(i, j); k++) {
        body += polygon([at(i, j + 1, k), at(i + 1, j + 1, k), at(i + 1, j + 1, k + 1), at(i, j + 1, k + 1)], side);
        body += polygon([at(i + 1, j, k), at(i + 1, j + 1, k), at(i + 1, j + 1, k + 1), at(i + 1, j, k + 1)], darker(side, SIDE_DARK));
        const face = k === heightAt(i, j) - 1 ? top : darker(top, BELOW_TOP);
        body += polygon([at(i, j, k + 1), at(i + 1, j, k + 1), at(i + 1, j + 1, k + 1), at(i, j + 1, k + 1)], face);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="${palette.background}"/>${body}</svg>`;
}

// A person as every screen shows them: the GitHub account, else null, and the shown name without "You".
export type Person = { player: PlayerInfo | null; name: string };

// The picture of one person. `pixels` is the shown size: GitHub sends twice that, for sharp
// pictures on high-density screens. The alt text is empty, because the name is always next to the picture.
export function avatarFor({ player, name }: Person, pixels: number): HTMLImageElement {
  const image = document.createElement('img');
  image.className = 'avatar';
  image.alt = '';
  image.width = pixels;
  image.height = pixels;
  image.src = player === null ? `data:image/svg+xml,${encodeURIComponent(avatarSvg(name))}` : `${player.avatar}&s=${pixels * 2}`;
  return image;
}
