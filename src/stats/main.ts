// The hidden stats page (/stats): the aggregates of GET /api/stats as hand-made SVG charts.
// Colors come from the theme tokens in style.css, so every chart follows the saved theme.
import '../style.css';
import { PRACTICE_MODES, PRESETS, PRESET_IDS, type PracticeMode, type PresetId } from '../practice/practice.ts';
import './stats.css';
import { describeClock } from '../clock.ts';
import { CELL_COUNT, SIZE } from '../game.ts';
import { type Count, MOVE_TIME_BUCKETS, type Stats } from '../protocol.ts';
import { setupPageHeader } from '../header/header.ts';

const SVG = 'http://www.w3.org/2000/svg';
const grid = document.querySelector('#stats-grid');
const note = document.querySelector('#stats-note');
if (!(grid instanceof HTMLElement) || !(note instanceof HTMLElement)) throw new Error('stats.html misses #stats-grid or #stats-note');
setupPageHeader();

// ---- Small builders ----

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function svg(width: number, height: number, label: string): SVGSVGElement {
  const root = document.createElementNS(SVG, 'svg');
  root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', label);
  return root;
}

// A rectangle with a hover text. The browser shows the <title> as a tooltip.
function rect(x: number, y: number, width: number, height: number, fill: string, tip: string, opacity = 1): SVGRectElement {
  const shape = document.createElementNS(SVG, 'rect');
  for (const [name, value] of Object.entries({ x, y, width, height, rx: Math.min(2, width / 2), fill, 'fill-opacity': opacity })) {
    shape.setAttribute(name, String(value));
  }
  const title = document.createElementNS(SVG, 'title');
  title.textContent = tip;
  shape.append(title);
  return shape;
}

const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 1 });
const percent = (part: number, whole: number) => (whole === 0 ? '–' : `${Math.round((part / whole) * 100)}%`);
const seconds = (ms: number | null) => (ms === null ? '–' : ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

function card(title: string, wide = false, hint = ''): HTMLElement {
  const box = el('section', wide ? 'stats-card wide' : 'stats-card');
  box.append(el('h2', '', title));
  if (hint) box.append(el('p', 'stats-hint', hint));
  grid?.append(box);
  return box;
}

function empty(box: HTMLElement): void {
  box.append(el('p', 'stats-empty', 'No data yet.'));
}

function table(box: HTMLElement, headers: string[], rows: (string | number)[][]): void {
  if (rows.length === 0) return empty(box);
  const wrap = el('div', 'stats-table');
  const element = el('table');
  const head = el('tr');
  for (const header of headers) head.append(el('th', '', header));
  element.append(el('thead'));
  element.tHead?.append(head);
  const body = el('tbody');
  for (const row of rows) {
    const line = el('tr');
    for (const value of row) line.append(el('td', '', typeof value === 'number' ? number(value) : value));
    body.append(line);
  }
  element.append(body);
  wrap.append(element);
  box.append(wrap);
}

// Horizontal bars, one row per key, longest first. Each bar has its value next to it.
function bars(box: HTMLElement, counts: Count[], color = 'var(--o)', label: (key: string) => string = capital): void {
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) return empty(box);
  const max = Math.max(...counts.map((entry) => entry.count));
  const list = el('div', 'stats-bars');
  for (const entry of counts) {
    const bar = svg(100, 10, `${label(entry.key)}: ${entry.count}`);
    bar.setAttribute('preserveAspectRatio', 'none');
    bar.append(rect(0, 0, Math.max(1, (entry.count / max) * 100), 10, color, `${label(entry.key)}: ${number(entry.count)} (${percent(entry.count, total)})`));
    list.append(el('span', 'stats-bar-label', label(entry.key)), bar, el('span', 'stats-bar-value', `${number(entry.count)} · ${percent(entry.count, total)}`));
  }
  box.append(list);
}

// Columns over time, with the first and the last date and the highest value as the only labels.
function columns(box: HTMLElement, values: { label: string; value: number }[], color: string, unit: string): void {
  const max = Math.max(1, ...values.map((entry) => entry.value));
  const width = values.length * 10;
  const chart = svg(width, 100, `${unit} per day`);
  chart.setAttribute('preserveAspectRatio', 'none');
  chart.classList.add('stats-columns');
  values.forEach((entry, i) => {
    // Every day gets a hover target of the full height, also a day with zero.
    chart.append(rect(i * 10, 0, 10, 100, 'transparent', `${entry.label}: ${entry.value} ${unit}`));
    if (entry.value > 0) chart.append(rect(i * 10 + 1, 100 - (entry.value / max) * 100, 8, (entry.value / max) * 100, color, `${entry.label}: ${entry.value} ${unit}`));
  });
  const axis = el('div', 'stats-axis');
  axis.append(el('span', '', values[0]?.label ?? ''), el('span', '', `max ${max}`), el('span', '', values.at(-1)?.label ?? ''));
  box.append(chart, axis);
}

// Darker cells hold more. One hue, so the order reads at a glance.
function shade(value: number, max: number): number {
  return max === 0 || value === 0 ? 0.06 : 0.15 + 0.85 * (value / max);
}

// The 4 layers of the cube as four 4 × 4 grids, from layer 1 (bottom) to layer 4 (top).
function cube(box: HTMLElement, counts: number[], color: string, what: string): void {
  if (counts.length !== CELL_COUNT) throw new Error(`a cube needs ${CELL_COUNT} counts`);
  const max = Math.max(...counts);
  if (max === 0) return empty(box);
  const layers = el('div', 'stats-cube');
  for (let layer = 0; layer < SIZE; layer++) {
    const figure = el('figure');
    const chart = svg(44, 44, `Layer ${layer + 1}`);
    for (let row = 0; row < SIZE; row++) {
      for (let column = 0; column < SIZE; column++) {
        const value = counts[layer * 16 + row * 4 + column] ?? 0;
        const tip = `Layer ${layer + 1}, row ${row + 1}, column ${column + 1}: ${value} ${what}`;
        chart.append(rect(column * 11 + 0.5, row * 11 + 0.5, 10, 10, color, tip, shade(value, max)));
      }
    }
    figure.append(chart, el('figcaption', '', `Layer ${layer + 1}`));
    layers.append(figure);
  }
  box.append(layers);
}

// Weekday × hour of day, in UTC.
function heatmap(box: HTMLElement, hours: Stats['hours']): void {
  const max = Math.max(0, ...hours.map((entry) => entry.games));
  if (max === 0) return empty(box);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const chart = svg(24 * 10 + 24, 7 * 10 + 10, 'Games by weekday and hour');
  days.forEach((day, d) => {
    const text = document.createElementNS(SVG, 'text');
    text.setAttribute('x', '0');
    text.setAttribute('y', String(d * 10 + 7.5));
    text.textContent = day;
    chart.append(text);
    for (let hour = 0; hour < 24; hour++) {
      const games = hours.find((entry) => entry.day === d && entry.hour === hour)?.games ?? 0;
      chart.append(rect(24 + hour * 10, d * 10, 9, 9, 'var(--x)', `${day} ${hour}:00–${hour}:59 UTC: ${games} games`, shade(games, max)));
    }
  });
  for (const hour of [0, 6, 12, 18]) {
    const text = document.createElementNS(SVG, 'text');
    text.setAttribute('x', String(24 + hour * 10));
    text.setAttribute('y', '78');
    text.textContent = `${hour}h`;
    chart.append(text);
  }
  chart.classList.add('stats-heatmap');
  const scroll = el('div', 'stats-scroll');
  scroll.append(chart);
  box.append(scroll);
}

// A 100% bar per row, split into parts. The legend names each part; the table below gives the numbers.
function stacked(box: HTMLElement, rows: { label: string; parts: number[] }[], parts: { name: string; color: string }[]): void {
  if (rows.length === 0) return empty(box);
  const legend = el('div', 'stats-legend');
  for (const part of parts) {
    const key = el('span');
    const swatch = el('i');
    swatch.style.background = part.color;
    key.append(swatch, part.name);
    legend.append(key);
  }
  const list = el('div', 'stats-bars');
  for (const row of rows) {
    const total = row.parts.reduce((sum, value) => sum + value, 0);
    const bar = svg(100, 10, row.label);
    bar.setAttribute('preserveAspectRatio', 'none');
    let x = 0;
    row.parts.forEach((value, i) => {
      const part = parts[i];
      if (part === undefined || total === 0 || value === 0) return;
      const width = (value / total) * 100;
      // A small gap between the parts keeps them apart in every theme.
      bar.append(rect(x, 0, Math.max(0.5, width - 0.6), 10, part.color, `${row.label} · ${part.name}: ${value} (${percent(value, total)})`));
      x += width;
    });
    list.append(el('span', 'stats-bar-label', row.label), bar, el('span', 'stats-bar-value', `${number(total)} games`));
  }
  box.append(legend, list);
}

// Two series side by side per bucket, with a legend.
function pairs(box: HTMLElement, rows: { label: string; a: number; b: number }[], names: [string, string], colors: [string, string]): void {
  const max = Math.max(0, ...rows.flatMap((row) => [row.a, row.b]));
  if (max === 0) return empty(box);
  const legend = el('div', 'stats-legend');
  names.forEach((name, i) => {
    const key = el('span');
    const swatch = el('i');
    swatch.style.background = colors[i] ?? '';
    key.append(swatch, name);
    legend.append(key);
  });
  const chart = svg(rows.length * 30, 100, `${names[0]} and ${names[1]}`);
  chart.setAttribute('preserveAspectRatio', 'none');
  chart.classList.add('stats-columns');
  rows.forEach((row, i) => {
    const heightA = (row.a / max) * 100;
    const heightB = (row.b / max) * 100;
    chart.append(rect(i * 30 + 3, 100 - heightA, 11, Math.max(heightA, row.a > 0 ? 1 : 0), colors[0], `${row.label} · ${names[0]}: ${row.a}`));
    chart.append(rect(i * 30 + 16, 100 - heightB, 11, Math.max(heightB, row.b > 0 ? 1 : 0), colors[1], `${row.label} · ${names[1]}: ${row.b}`));
  });
  const axis = el('div', 'stats-axis spread');
  for (const row of rows) axis.append(el('span', '', row.label));
  box.append(legend, chart, axis);
}

function tiles(stats: Stats): void {
  const box = card('Totals', true);
  const list = el('div', 'stats-tiles');
  const entries: [string, string][] = [
    ['Games', number(stats.totals.games)],
    ['Last 7 days', number(stats.totals.gamesLast7Days)],
    ['Players', number(stats.totals.players)],
    ['GitHub accounts', number(stats.totals.accounts)],
    ['Online sessions', number(stats.totals.sessions)],
    ['Moves', number(stats.totals.moves)],
    ['Played offline', percent(stats.offlineGames, stats.metricsGames)],
  ];
  for (const [label, value] of entries) {
    const tile = el('div', 'stats-tile');
    tile.append(el('b', '', value), el('span', '', label));
    list.append(tile);
  }
  box.append(list);
}

const MODE_NAMES: Record<string, string> = { computer: 'Computer', friend: 'Friend', online: 'Online', nearby: 'Nearby' };
const ENDING_NAMES: Record<string, string> = {
  axis: 'Line along an axis',
  plane: 'Diagonal in a plane',
  space: 'Diagonal through the cube',
  timeout: 'Out of time',
  draw: 'Draw',
  // A game stored before game links: the kind of its line is not known.
  won: 'Line, kind not stored',
};
const HIDE_NAMES: Record<string, string> = { none: 'Nothing hidden', board: 'Board hidden', history: 'History hidden', both: 'Both hidden' };
const modeName = (key: string) => MODE_NAMES[key] ?? capital(key);
function hideName(setting: string, coordinates: boolean): string {
  if (!coordinates) return HIDE_NAMES[setting] ?? setting;
  return setting === 'none' ? 'Coordinates hidden' : `${HIDE_NAMES[setting] ?? setting}, coordinates too`;
}

function draw(stats: Stats): void {
  tiles(stats);

  columns(card('Games per day', true, 'The last 60 days, UTC.'), stats.perDay.map((day) => ({ label: day.day.slice(5), value: day.games })), 'var(--o)', 'games');
  columns(card('Players per day', true, 'Different players with a finished game that day.'), stats.perDay.map((day) => ({ label: day.day.slice(5), value: day.players })), 'var(--x)', 'players');
  heatmap(card('When people play', true, 'Weekday and hour, UTC. Darker means more games.'), stats.hours);

  bars(card('Games by mode'), stats.byMode, 'var(--o)', modeName);

  const levels = card('Against the computer', false, 'From the player\'s side.');
  stacked(
    levels,
    stats.levels.map((level) => ({ label: capital(level.level), parts: [level.won, level.drawn, level.lost] })),
    [
      { name: 'Player won', color: 'var(--win)' },
      { name: 'Draw', color: 'var(--muted)' },
      { name: 'Computer won', color: 'var(--x)' },
    ],
  );
  table(
    levels,
    ['Level', 'Games', 'Win rate', 'Avg moves', 'Median', 'Tuned'],
    stats.levels.map((level) => [capital(level.level), level.games, percent(level.won, level.games), level.avgMoves, level.medianMoves, level.tuned]),
  );

  const survival = card('Survival records', false, 'The longest games that the computer won. Default computer only.');
  for (const level of ['easy', 'medium', 'hard'] as const) {
    const rows = stats.survival.filter((entry) => entry.level === level);
    if (rows.length === 0) continue;
    survival.append(el('h3', '', capital(level)));
    table(survival, ['#', 'Player', 'Moves'], rows.map((entry) => [entry.rank, entry.player, entry.moves]));
  }
  if (stats.survival.length === 0) empty(survival);

  // The practice modes of the Voice room (/sound-input).
  const practiceName = (mode: PracticeMode, preset: PresetId) => `${mode === 'echo' ? 'Echo' : 'Targets'}, ${PRESETS[preset].name}`;
  const practice = card('Voice room practice', false, 'Practice runs per mode and level. Average: the mean time of one target or echo round.');
  if (stats.practice.runs.length === 0) empty(practice);
  else {
    table(
      practice,
      ['Mode and level', 'Runs', 'Players', 'Average'],
      stats.practice.runs.map((row) => [practiceName(row.mode, row.preset), row.runs, row.players, seconds(row.avgRoundMs)]),
    );
  }
  const leaders = card('Voice room leaderboards', false, 'The best 5 per mode and level. Targets rank by total time, echo by points and then time.');
  for (const mode of PRACTICE_MODES) {
    for (const preset of PRESET_IDS) {
      const rows = stats.practice.best.filter((entry) => entry.mode === mode && entry.preset === preset);
      if (rows.length === 0) continue;
      leaders.append(el('h3', '', practiceName(mode, preset)));
      table(leaders, ['#', 'Player', 'Time', ...(mode === 'echo' ? ['Points'] : [])], rows.map((entry) => [entry.rank, entry.player, seconds(entry.totalMs), ...(mode === 'echo' ? [entry.score] : [])]));
    }
  }
  if (stats.practice.best.length === 0) empty(leaders);

  table(
    card('Game length', false, 'Moves per finished game.'),
    ['Mode', 'Games', 'Average', 'Median', '90th percentile'],
    stats.lengthByMode.map((row) => [modeName(row.mode), row.games, row.avg, row.median, row.p90]),
  );

  pairs(
    card('Time per move', true, 'Time between two moves. The computer\'s time includes its short pause before a move.'),
    stats.moveTimes.map((bucket) => ({ label: MOVE_TIME_BUCKETS[bucket.bucket] ?? '', a: bucket.human, b: bucket.computer })),
    ['Players', 'Computer'],
    ['var(--o)', 'var(--x)'],
  );
  table(
    card('Median time per move', false, 'Search: the thinking time that devices report for the computer.'),
    ['Level or mode', 'Players', 'Computer', 'Search'],
    stats.thinkTimes.map((row) => [modeName(row.key), seconds(row.humanMs), seconds(row.computerMs), seconds(row.searchMs)]),
  );
  table(
    card('Slowest thinkers', false, 'Median time per move, players with 20 moves or more.'),
    ['Player', 'Median', 'Moves'],
    stats.slowest.map((row) => [row.player, seconds(row.medianMs), row.moves]),
  );

  stacked(
    card('First-player advantage', false, 'X always moves first.'),
    stats.firstPlayer.map((row) => ({ label: modeName(row.mode), parts: [row.x, row.draws, row.o] })),
    [
      { name: 'X won', color: 'var(--x)' },
      { name: 'Draw', color: 'var(--muted)' },
      { name: 'O won', color: 'var(--o)' },
    ],
  );

  cube(card('Opening moves', true, 'The first move of each game. Corners and the 8 inner cells sit on 7 lines each.'), stats.openings, 'var(--x)', 'first moves');
  cube(card('Every move', true, 'All moves of all games.'), stats.cells, 'var(--o)', 'moves');

  bars(card('How games end'), stats.endings, 'var(--toggle-on)', (key) => ENDING_NAMES[key] ?? key);

  table(
    card('Hide board and history', false, 'Win rate: games that the player won against the computer.'),
    ['Setting', 'Games', 'vs computer', 'Win rate'],
    stats.hide.map((row) => [hideName(row.setting, row.coordinates), row.games, row.computerGames, percent(row.humanWins, row.computerGames)]),
  );
  bars(
    card('Time limits'),
    stats.timeLimits.map((row) => ({ key: describeClock({ perGame: row.perGame, perMove: row.perMove }), count: row.games })),
    'var(--primary)',
    (key) => key,
  );
  table(
    card('Tuned computer'),
    ['Computer', 'Games', 'Win rate'],
    stats.tuned.map((row) => [row.tuned ? 'Tuned' : 'Default', row.games, percent(row.humanWins, row.games)]),
  );

  const devices = card('Devices', false, `From ${number(stats.metricsGames)} metric reports: one per device result, and one per player of an online game.`);
  bars(devices, stats.devices);
  const looks = card('Views and layouts');
  bars(looks, stats.views);
  bars(looks, stats.layouts, 'var(--toggle-on)');
  bars(card('Themes'), stats.themes, 'var(--primary)');
  bars(card('App versions'), stats.versions, 'var(--muted)', (key) => key);

  const input = card('Input and undo');
  bars(input, [
    { key: 'Board taps', count: stats.input.board },
    { key: 'Keypad', count: stats.input.keypad },
  ]);
  table(input, ['Undos', 'Games with an undo'], [[stats.undo.undos, stats.undo.gamesWithUndo]]);
  bars(card('Refused actions'), stats.refusals, 'var(--danger)', (key) => key);
  bars(card('Nearby device mixes', false, 'The host device and the other player\'s device.'), stats.nearbyMixes, 'var(--o)');

  table(
    card('Failures', true, 'Errors that pages report, and bursts of refused moves.'),
    ['Kind', 'Message', 'Count', 'Last'],
    stats.errors.map((row) => [row.kind, row.message, row.count, new Date(row.lastAt).toLocaleString()]),
  );
}

// The page only displays the answer, so a light shape check is enough here.
function parseStats(value: unknown): Stats {
  if (typeof value !== 'object' || value === null || !('totals' in value) || !('perDay' in value)) throw new Error('invalid answer from /api/stats');
  return value as Stats;
}

async function load(): Promise<void> {
  const response = await fetch('/api/stats', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
  const stats = parseStats(await response.json());
  note?.replaceChildren(`Updated ${new Date(stats.generatedAt).toLocaleString()}. The numbers refresh every minute.`);
  draw(stats);
}

load().catch((error: unknown) => {
  note.textContent = `The stats did not load. ${error instanceof Error ? error.message : String(error)}`;
});
