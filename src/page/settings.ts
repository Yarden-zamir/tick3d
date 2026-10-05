// The settings of this screen: their choices, defaults, and storage in localStorage.
import { type Difficulty, DIFFICULTIES } from '../ai.ts';
import { type TimeControl, NO_LIMIT, parseClock } from '../clock.ts';
import type { Player } from '../game.ts';

export const MODES = ['computer', 'friend', 'online', 'nearby'] as const;
export const VIEWS = ['tower', 'flat'] as const;
export const LAYOUTS = ['grid', 'row', 'column', 'steps'] as const;
export const PLAYERS = ['X', 'O'] as const;
// Palettes in style.css, in menu order. index.html repeats the names for its pre-paint script.
export const THEMES = [
  'light',
  'dark',
  'snow',
  'candy',
  'mint',
  'retro',
  'midnight',
  'synthwave',
  'bloodmoon',
  'coffee',
  'batman',
  'mono',
] as const;
export type Mode = (typeof MODES)[number];
type View = (typeof VIEWS)[number];
type Layout = (typeof LAYOUTS)[number];
type Theme = (typeof THEMES)[number];
export const THEME_NAMES: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
  snow: 'Snow',
  candy: 'Candy',
  mint: 'Mint',
  retro: 'Retro',
  midnight: 'Midnight',
  synthwave: 'Synthwave',
  bloodmoon: 'Bloodmoon',
  coffee: 'Dark coffee',
  batman: 'Batman',
  mono: 'Mono',
};

export type Settings = {
  mode: Mode;
  difficulty: Difficulty;
  human: Player;
  view: View;
  layout: Layout;
  // The time limit for the next session this screen starts. A session keeps its own limit after that.
  clock: TimeControl;
  muted: boolean;
  // The tower's turn around its vertical axis, in degrees. Dragging the tower sets it.
  spin: number;
  theme: Theme;
};
export type Toggle = 'hideBoard' | 'hideHistory';

export const DEFAULTS: Settings = {
  mode: 'computer',
  difficulty: 'medium',
  human: 'X',
  view: 'tower',
  layout: 'grid',
  clock: NO_LIMIT,
  muted: false,
  spin: 45,
  theme: 'light',
};
const STORAGE_KEY = 'tick3d.settings';

export function oneOf<T extends string>(options: readonly T[], value: unknown, fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}

const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
export const wrapSpin = (spin: number) => ((spin % 360) + 360) % 360;
const finite = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

// Stored settings come from an older visit or a hand edit, so check every field.
function loadSettings(): Settings {
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    raw = null;
  }
  const stored: Record<string, unknown> = typeof raw === 'object' && raw !== null ? { ...raw } : {};
  return {
    mode: oneOf(MODES, stored.mode, DEFAULTS.mode),
    difficulty: oneOf(DIFFICULTIES, stored.difficulty, DEFAULTS.difficulty),
    human: oneOf(PLAYERS, stored.human, DEFAULTS.human),
    view: oneOf(VIEWS, stored.view, DEFAULTS.view),
    layout: oneOf(LAYOUTS, stored.layout, DEFAULTS.layout),
    clock: parseClock(stored.clock) ?? DEFAULTS.clock,
    muted: bool(stored.muted, DEFAULTS.muted),
    spin: wrapSpin(finite(stored.spin, DEFAULTS.spin)),
    theme: oneOf(THEMES, stored.theme, DEFAULTS.theme),
  };
}

export function saveSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage is blocked (private mode). Settings then last for this visit only.
  }
}

export const settings = loadSettings();
