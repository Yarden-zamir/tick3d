// The shape of beats.json: the machine timeline of the 15 s spot (issue #119).
// All times are whole sixteenth notes from the start of the spot, on the 136 BPM grid of src/song.ts.
// Seconds = sixteenths * SIXTEENTH (src/song.ts). One bar is 16 sixteenths. The spot is 8 bars (128 sixteenths),
// then the final chord rings to 15.0 s.
import { DIFFICULTIES, type Difficulty } from '../../src/ai.ts';
import { CELL_COUNT, type Line, type Player } from '../../src/game.ts';
import { isCount, isRecord, isUnknownArray } from '../../src/guards.ts';
import type { SoundSetId } from '../../src/sound-sets.ts';

// The ids of [data-theme] in src/style.css. 'light' is also the theme without data-theme.
const THEMES = ['light', 'dark', 'candy', 'mint', 'midnight', 'snow', 'retro', 'synthwave', 'bloodmoon', 'coffee', 'batman', 'mono'] as const;
type ThemeId = (typeof THEMES)[number];

const CAMERAS = ['slam', 'dive', 'orbit', 'push', 'ride', 'pull-back', 'settle'] as const;
// The only sound sets of the spot (maintainer rule on #119).
const SPOT_SOUND_SETS = ['classic', 'cells', 'chiptune'] as const satisfies readonly SoundSetId[];
type Camera = (typeof CAMERAS)[number];

export const SIXTEENTHS_PER_BAR = 16;
export const BAR_COUNT = 8;
export const SPOT_SIXTEENTHS = SIXTEENTHS_PER_BAR * BAR_COUNT;

// Things that happen at one sixteenth. Each kind has one picture rule and one sound rule (script.md).
type BeatEvent =
  // A layer of the tower hits: it drops into place, or pulses if it is in place. Sound: the Classic voice of X on that layer.
  | { kind: 'layer-slam'; at: number; layer: number }
  // The empty cells that win for the player now. They blink in --win.
  | { kind: 'threats'; at: number; cells: readonly number[] }
  // The blinking threat cells pulse on an eighth note. Sound: the preview strike of each cell (sounds.preview), in the set of the bar.
  | { kind: 'threat-pulse'; at: number; cells: readonly number[] }
  // The win jingle of the game (sounds.win): five notes, one per sixteenth from `at`. The beam throbs on each.
  | { kind: 'win-jingle'; at: number }
  // The winning line becomes a light beam. It lights one cell per sixteenth from `at`, in the order of `line`.
  // Sound: the 4 ending melody notes of songOf, one per cell.
  | { kind: 'beam'; at: number; line: Line }
  | { kind: 'confetti'; at: number }
  // The song melody of all moves again, one note per sixteenth from `at`. Each piece pulses with its note.
  | { kind: 'replay'; at: number }
  // The final chord of songOf. It rings to the end of the spot.
  | { kind: 'final-chord'; at: number };

type Bar = {
  bar: number;
  start: number;
  scene: string;
  // A theme or a sound set that differs from the previous bar changes on the downbeat. The theme sweeps across the frame.
  theme: ThemeId;
  soundSet: (typeof SPOT_SOUND_SETS)[number];
  camera: Camera;
  events: readonly BeatEvent[];
};

// A move on the timeline. Sound: the melody note of songOf for this move index, in the sound set of its bar.
type TimedMove = { move: number; player: Player; cell: number; at: number };

// One on-screen line. Each word group slams in at its own sixteenth. The line leaves at `until`. The style places it:
// - 'center': two word groups across the middle, the second one a sticker (src/hud.ts LOOKS);
// - 'top': two word groups above the tower, the second one a sticker;
// - 'cards': feature cards in the sticker style of the wordmark above the tower, one at a time;
// - 'list': feature cards above the tower that scroll up as a list, two at a time;
// - 'end-card': the wordmark, the URL suffix, a call to action, then official store badges (words with a
//   `badge`). It is the last line, and it stays to the end of the spot.
const TEXT_STYLES = ['center', 'top', 'cards', 'list', 'end-card'] as const;
export type TextStyle = (typeof TEXT_STYLES)[number];
// An official store badge on the end card (video/public/badges/). Its `text` names it and is not drawn; an optional
// `note`, such as "soon", is a small sticker next to it.
const BADGES = ['app-store', 'google-play'] as const;
export type Badge = (typeof BADGES)[number];
type TextLine = { words: readonly { text: string; at: number; badge?: Badge; note?: string }[]; until: number; style: TextStyle };

export type Beats = {
  bpm: 136;
  fps: 30;
  durationSeconds: 15;
  // The game of src/ai.ts self-play: seededRandom(seed) from src/practice/practice.ts feeds chooseMove for both players.
  game: { seed: number; first: Player; levels: Readonly<Record<Player, Difficulty>>; winner: Player; line: Line };
  // The key of the song. songOf picks a key from a hash of the moves; the spot forces C major pentatonic.
  songKey: { root: 0; mode: 'major pentatonic' };
  moves: readonly TimedMove[];
  bars: readonly Bar[];
  text: readonly TextLine[];
};

// A variant of the spot: a small overlay on beats.json in video/creative/variants/<name>.json. It changes the
// theme, the sound set and the camera of bars, and the text, never the game or the events. VIDEO_VARIANT selects one.
// Shape: { name, differs, text?, bars: { "<bar number>": { theme?, soundSet?, camera? } } }. A value replaces the
// value of beats.json. withVariant checks the keys, and parseBeats checks the merged timeline.
const VARIANT_KEYS: readonly string[] = ['name', 'differs', 'text', 'bars'];
const VARIANT_BAR_KEYS: readonly string[] = ['theme', 'soundSet', 'camera'];

// The JSON of beats.json with the overlay of a variant merged in, for parseBeats.
export function withVariant(beats: unknown, variant: unknown): unknown {
  const root = record(beats, '');
  const v = record(variant, 'variant');
  const name = text(v['name'], 'variant.name');
  text(v['differs'], `variant ${name}.differs`);
  for (const key of Object.keys(v)) if (!VARIANT_KEYS.includes(key)) fail(`variant ${name}.${key}`, VARIANT_KEYS.join(' | '));
  const bars = record(v['bars'], `variant ${name}.bars`);
  const merged = list(root['bars'], 'bars').map((entry, i) => {
    const bar = record(entry, `bars[${i}]`);
    const overlay = bars[String(i + 1)];
    if (overlay === undefined) return bar;
    const o = record(overlay, `variant ${name}.bars.${i + 1}`);
    for (const key of Object.keys(o)) if (!VARIANT_BAR_KEYS.includes(key)) fail(`variant ${name}.bars.${i + 1}.${key}`, VARIANT_BAR_KEYS.join(' | '));
    return { ...bar, ...o };
  });
  for (const key of Object.keys(bars)) if (!(Number(key) >= 1 && Number(key) <= merged.length)) fail(`variant ${name}.bars.${key}`, `a bar 1..${merged.length}`);
  return { ...root, bars: merged, ...(v['text'] === undefined ? {} : { text: v['text'] }) };
}

// ---- Runtime check of the JSON. It throws on the first value that does not fit the type. ----

function fail(path: string, expected: string): never {
  throw new TypeError(`beats.json ${path}: expected ${expected}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  return isRecord(value) ? value : fail(path, 'an object');
}

function list(value: unknown, path: string): readonly unknown[] {
  return isUnknownArray(value) ? value : fail(path, 'an array');
}

function count(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER): number {
  return isCount(value) && value <= max ? value : fail(path, `a whole number in 0..${max}`);
}

function text(value: unknown, path: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fail(path, 'a non-empty string');
}

function oneOf<T extends string>(options: readonly T[], value: unknown, path: string): T {
  return options.find((option) => option === value) ?? fail(path, options.join(' | '));
}

function exactly<T extends number>(expected: T, value: unknown, path: string): T {
  return value === expected ? expected : fail(path, String(expected));
}

const time = (value: unknown, path: string) => count(value, path, SPOT_SIXTEENTHS);
const cell = (value: unknown, path: string) => count(value, path, CELL_COUNT - 1);
const player = (value: unknown, path: string) => oneOf(['X', 'O'] as const, value, path);

function line(value: unknown, path: string): Line {
  const cells = list(value, path).map((item, i) => cell(item, `${path}[${i}]`));
  const [a, b, c, d] = cells;
  if (cells.length !== 4 || a === undefined || b === undefined || c === undefined || d === undefined) fail(path, '4 cells');
  return [a, b, c, d];
}

function beatEvent(value: unknown, path: string): BeatEvent {
  const e = record(value, path);
  const at = time(e['at'], `${path}.at`);
  const kind = oneOf(['layer-slam', 'threats', 'threat-pulse', 'beam', 'confetti', 'replay', 'win-jingle', 'final-chord'] as const, e['kind'], `${path}.kind`);
  switch (kind) {
    case 'layer-slam':
      return { kind, at, layer: count(e['layer'], `${path}.layer`, 3) };
    case 'threats':
    case 'threat-pulse':
      return { kind, at, cells: list(e['cells'], `${path}.cells`).map((c, i) => cell(c, `${path}.cells[${i}]`)) };
    case 'beam':
      return { kind, at, line: line(e['line'], `${path}.line`) };
    case 'confetti':
    case 'replay':
    case 'win-jingle':
    case 'final-chord':
      return { kind, at };
  }
}

function bar(value: unknown, path: string): Bar {
  const b = record(value, path);
  return {
    bar: count(b['bar'], `${path}.bar`, BAR_COUNT),
    start: time(b['start'], `${path}.start`),
    scene: text(b['scene'], `${path}.scene`),
    theme: oneOf(THEMES, b['theme'], `${path}.theme`),
    soundSet: oneOf(SPOT_SOUND_SETS, b['soundSet'], `${path}.soundSet`),
    camera: oneOf(CAMERAS, b['camera'], `${path}.camera`),
    events: list(b['events'], `${path}.events`).map((e, i) => beatEvent(e, `${path}.events[${i}]`)),
  };
}

export function parseBeats(value: unknown): Beats {
  const root = record(value, '');
  const game = record(root['game'], 'game');
  const levels = record(game['levels'], 'game.levels');
  return {
    bpm: exactly(136, root['bpm'], 'bpm'),
    fps: exactly(30, root['fps'], 'fps'),
    durationSeconds: exactly(15, root['durationSeconds'], 'durationSeconds'),
    game: {
      seed: count(game['seed'], 'game.seed', 2 ** 32 - 1),
      first: player(game['first'], 'game.first'),
      levels: { X: oneOf(DIFFICULTIES, levels['X'], 'game.levels.X'), O: oneOf(DIFFICULTIES, levels['O'], 'game.levels.O') },
      winner: player(game['winner'], 'game.winner'),
      line: line(game['line'], 'game.line'),
    },
    songKey: {
      root: exactly(0, record(root['songKey'], 'songKey')['root'], 'songKey.root'),
      mode: oneOf(['major pentatonic'] as const, record(root['songKey'], 'songKey')['mode'], 'songKey.mode'),
    },
    moves: list(root['moves'], 'moves').map((m, i) => {
      const move = record(m, `moves[${i}]`);
      return {
        move: count(move['move'], `moves[${i}].move`),
        player: player(move['player'], `moves[${i}].player`),
        cell: cell(move['cell'], `moves[${i}].cell`),
        at: time(move['at'], `moves[${i}].at`),
      };
    }),
    bars: list(root['bars'], 'bars').map((b, i) => bar(b, `bars[${i}]`)),
    text: list(root['text'], 'text').map((t, i) => {
      const entry = record(t, `text[${i}]`);
      const words = list(entry['words'], `text[${i}].words`).map((w, j) => {
        const word = record(w, `text[${i}].words[${j}]`);
        const entry = { text: text(word['text'], `text[${i}].words[${j}].text`), at: time(word['at'], `text[${i}].words[${j}].at`) };
        if (word['badge'] === undefined) return entry;
        const badge = { ...entry, badge: oneOf(BADGES, word['badge'], `text[${i}].words[${j}].badge`) };
        return word['note'] === undefined ? badge : { ...badge, note: text(word['note'], `text[${i}].words[${j}].note`) };
      });
      return { words, until: time(entry['until'], `text[${i}].until`), style: oneOf(TEXT_STYLES, entry['style'], `text[${i}].style`) };
    }),
  };
}
