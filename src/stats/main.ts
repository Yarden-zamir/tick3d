// The hidden stats page (/stats): the aggregates of GET /api/stats as hand-made SVG charts.
// Colors come from the theme tokens in style.css, so every chart follows the saved theme.
// The filters live in the address (parseStatsFilter), so a view survives a reload and a link shares it.
import '../style.css';
import './stats.css';
import { DIFFICULTIES } from '../ai.ts';
import { describeClock } from '../clock.ts';
import { element } from '../element.ts';
import { CELL_COUNT, SIZE } from '../game.ts';
import { accountLink, setupPageHeader } from '../header/header.ts';
import { myGamesHref } from '../header/my-games-link.ts';
import { api } from '../online.ts';
import {
  ALL_STATS,
  type Count,
  FORM_WINDOW,
  MOVE_TIME_BUCKETS,
  SESSION_MODES,
  STATS_RANGES,
  STATS_SCOPES,
  type SessionMode,
  type Stats,
  type StatsFilter,
  type StatsRange,
  parseStatsFilter,
  statsQuery,
} from '../protocol.ts';

const SVG = 'http://www.w3.org/2000/svg';
const grid = element('#stats-grid', HTMLDivElement);
const note = element('#stats-note', HTMLParagraphElement);
const filters = element('#stats-filters', HTMLElement);
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
  grid.append(box);
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

// Columns, with the first and the last label and the highest value as the only labels.
function columns(box: HTMLElement, values: { label: string; value: number }[], color: string, unit: string, title: string): void {
  if (values.length === 0) return empty(box);
  const max = Math.max(1, ...values.map((entry) => entry.value));
  const width = values.length * 10;
  const chart = svg(width, 100, title);
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
// `tip` names the value of a cell. A darker cell holds more, up to `max`.
function cube(box: HTMLElement, counts: number[], color: string, tip: (value: number, cell: number) => string, max = Math.max(...counts)): void {
  if (counts.length !== CELL_COUNT) throw new Error(`a cube needs ${CELL_COUNT} counts`);
  if (max === 0) return empty(box);
  const layers = el('div', 'stats-cube');
  for (let layer = 0; layer < SIZE; layer++) {
    const figure = el('figure');
    const chart = svg(44, 44, `Layer ${layer + 1}`);
    for (let row = 0; row < SIZE; row++) {
      for (let column = 0; column < SIZE; column++) {
        const cell = layer * 16 + row * 4 + column;
        const value = counts[cell] ?? 0;
        const text = `Layer ${layer + 1}, row ${row + 1}, column ${column + 1}: ${tip(value, cell)}`;
        chart.append(rect(column * 11 + 0.5, row * 11 + 0.5, 10, 10, color, text, shade(value, max)));
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

// A line from 0% to 100% over the games, oldest on the left, with a soft fill under it.
// Points are evenly spaced by game, not by time.
function rateLine(box: HTMLElement, points: Stats['form'], color: string, title: string): void {
  const last = points.at(-1);
  if (last === undefined) return empty(box);
  const width = 300;
  const y = (rate: number) => (100 - rate * 100).toFixed(1);
  // One game draws a flat line at its value.
  const path =
    points.length === 1
      ? `M0,${y(last.rate)}H${width}`
      : points.map((point, i) => `${i === 0 ? 'M' : 'L'}${((i / (points.length - 1)) * width).toFixed(1)},${y(point.rate)}`).join('');
  const chart = svg(width, 100, `${title}: ${percent(last.rate, 1)} now`);
  chart.setAttribute('preserveAspectRatio', 'none');
  chart.classList.add('stats-line');
  for (const level of [0.25, 0.5, 0.75]) {
    const guide = document.createElementNS(SVG, 'path');
    guide.setAttribute('d', `M0,${y(level)}H${width}`);
    guide.setAttribute('class', 'stats-guide');
    chart.append(guide);
  }
  const area = document.createElementNS(SVG, 'path');
  area.setAttribute('d', `${path}L${width},100L0,100Z`);
  area.setAttribute('fill', color);
  area.setAttribute('fill-opacity', '0.15');
  const stroke = document.createElementNS(SVG, 'path');
  stroke.setAttribute('d', path);
  stroke.setAttribute('stroke', color);
  stroke.setAttribute('class', 'stats-stroke');
  chart.append(area, stroke);
  const best = Math.max(...points.map((point) => point.rate));
  const axis = el('div', 'stats-axis');
  const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  axis.append(el('span', '', day(points[0]?.at ?? last.at)), el('span', '', `now ${percent(last.rate, 1)} · best ${percent(best, 1)}`), el('span', '', day(last.at)));
  box.append(chart, axis);
}

function tileList(box: HTMLElement, entries: [string, string][]): void {
  const list = el('div', 'stats-tiles');
  for (const [label, value] of entries) {
    const tile = el('div', 'stats-tile');
    tile.append(el('b', '', value), el('span', '', label));
    list.append(tile);
  }
  box.append(list);
}

function tiles(stats: Stats): void {
  const box = card('Totals', true);
  const personal = stats.personal;
  if (personal === null) {
    return tileList(box, [
      ['Games', number(stats.totals.games)],
      ['Last 7 days', number(stats.totals.gamesLast7Days)],
      ['Players', number(stats.totals.players)],
      ['GitHub accounts', number(stats.totals.accounts)],
      ['Online sessions', number(stats.totals.sessions)],
      ['Moves', number(stats.totals.moves)],
      ['Played offline', percent(stats.offlineGames, stats.metricsGames)],
    ]);
  }
  const sum = (key: 'won' | 'drawn' | 'lost') => personal.results.reduce((total, row) => total + row[key], 0);
  const current = personal.currentStreak;
  tileList(box, [
    ['Games', number(stats.totals.games)],
    ['Last 7 days', number(stats.totals.gamesLast7Days)],
    ['Win rate', percent(sum('won'), sum('won') + sum('drawn') + sum('lost'))],
    ['Best win streak', number(personal.bestStreak)],
    ['Current streak', current === null ? '–' : `${current.length} ${current.outcome}`],
    ['Moves', number(stats.totals.moves)],
  ]);
}

// The cards that only the Mine scope has.
function personalCards(personal: NonNullable<Stats['personal']>): void {
  stacked(
    card('Your results', false, 'Won, drawn and lost, per mode and computer level. Friend games have no side, so they do not count.'),
    personal.results.map((row) => ({ label: row.level === null ? modeName(row.mode) : `${modeName(row.mode)} · ${row.level}`, parts: [row.won, row.drawn, row.lost] })),
    [
      { name: 'Won', color: 'var(--win)' },
      { name: 'Draw', color: 'var(--muted)' },
      { name: 'Lost', color: 'var(--danger)' },
    ],
  );
  table(
    card('Favourite opponents', false, 'The players that you played most, and how it went.'),
    ['Player', 'Games', 'Won', 'Drawn', 'Lost'],
    personal.opponents.map((row) => [row.player, row.games, row.won, row.drawn, row.lost]),
  );
}

// The games per number of moves, from the shortest to the longest game.
function lengthColumns(lengths: number[]): { label: string; value: number }[] {
  const first = lengths.findIndex((count) => count > 0);
  if (first === -1) return [];
  const last = lengths.findLastIndex((count) => count > 0);
  return lengths.slice(first, last + 1).map((count, i) => ({ label: `${first + i} moves`, value: count }));
}

// The share of X wins per first move, in percent. A cell with fewer than MIN_OPENINGS games shows as empty.
const MIN_OPENINGS = 3;
const openingRates = (stats: Stats) =>
  stats.openings.map((games, cell) => (games < MIN_OPENINGS ? 0 : Math.round(((stats.openingWinsX[cell] ?? 0) / games) * 100)));

const MODE_NAMES: Record<SessionMode, string> = { computer: 'Computer', friend: 'Friend', online: 'Online', nearby: 'Nearby' };
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
function modeName(key: string): string {
  const mode = SESSION_MODES.find((known) => known === key);
  return mode === undefined ? capital(key) : MODE_NAMES[mode];
}
function hideName(setting: string, coordinates: boolean): string {
  if (!coordinates) return HIDE_NAMES[setting] ?? setting;
  return setting === 'none' ? 'Coordinates hidden' : `${HIDE_NAMES[setting] ?? setting}, coordinates too`;
}

function draw(stats: Stats): void {
  const mine = stats.personal !== null;
  tiles(stats);
  rateLine(
    card(
      'Win rate over time',
      true,
      mine
        ? `Your share of wins in your last ${FORM_WINDOW} games, after each game. Friend games do not count.`
        : `The players' share of wins against the computer in the last ${FORM_WINDOW} games, after each game.`,
    ),
    stats.form,
    'var(--win)',
    'Win rate',
  );
  if (stats.personal !== null) personalCards(stats.personal);

  const days = stats.perDay.length;
  columns(card('Games per day', true, `The last ${days} days, UTC.`), stats.perDay.map((day) => ({ label: day.day.slice(5), value: day.games })), 'var(--o)', 'games', 'Games per day');
  columns(
    card('Players per day', true, 'Different players with a finished game that day.'),
    stats.perDay.map((day) => ({ label: day.day.slice(5), value: day.players })),
    'var(--x)',
    'players',
    'Players per day',
  );
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

  columns(
    card('Game length', true, 'How many games ended after each number of moves. A win needs 7 moves at least.'),
    lengthColumns(stats.lengths),
    'var(--toggle-on)',
    'games',
    'Games by number of moves',
  );
  table(
    card('Game length by mode', false, 'Moves per finished game.'),
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

  cube(card('Opening moves', true, 'The first move of each game. Corners and the 8 inner cells sit on 7 lines each.'), stats.openings, 'var(--x)', (value) => `${value} first moves`);
  cube(
    card('Best openings for X', true, `How often X won after each first move. Darker wins more. Cells with fewer than ${MIN_OPENINGS} games stay blank.`),
    openingRates(stats),
    'var(--win)',
    (value, cell) => ((stats.openings[cell] ?? 0) < MIN_OPENINGS ? 'too few games' : `X won ${value}% of ${stats.openings[cell] ?? 0} games`),
    100,
  );
  cube(card('Every move', true, mine ? 'All moves of your games, also the moves of the other side.' : 'All moves of all games.'), stats.cells, 'var(--o)', (value) => `${value} moves`);

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

  // A fault has no player and no mode, so only the time range applies to it.
  if (stats.filter.scope === 'everyone' && stats.filter.mode === null && stats.filter.level === null) {
    table(
      card('Failures', true, 'Errors that pages report, and bursts of refused moves.'),
      ['Kind', 'Message', 'Count', 'Last'],
      stats.errors.map((row) => [row.kind, row.message, row.count, new Date(row.lastAt).toLocaleString()]),
    );
  }
}

// The page only displays the answer, so a light shape check is enough here.
function parseStats(value: unknown): Stats {
  if (typeof value !== 'object' || value === null || !('totals' in value) || !('perDay' in value) || !('filter' in value) || !('form' in value)) {
    throw new Error('invalid answer from /api/stats');
  }
  return value as Stats;
}

// ---- Filters ----

const SCOPE_NAMES: Record<StatsFilter['scope'], string> = { everyone: 'Everyone', mine: 'Mine' };
const RANGE_NAMES: Record<StatsRange, string> = { '7d': '7 days', '30d': '30 days', all: 'All time' };

// One row of toggle buttons. `null` is the "All" choice of mode and level.
function filterGroup<T extends string | null>(label: string, choices: readonly { value: T; name: string }[], selected: T, pick: (value: T) => void): HTMLElement {
  const group = el('div', 'stats-filter');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  const row = el('div', 'toggles');
  for (const choice of choices) {
    const button = el('button', 'btn btn-small', choice.name);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(choice.value === selected));
    button.addEventListener('click', () => pick(choice.value));
    row.append(button);
  }
  group.append(el('span', 'stats-filter-label', label), row);
  return group;
}

function renderFilters(filter: StatsFilter): void {
  const go = (change: Partial<StatsFilter>) => navigate({ ...filter, ...change });
  const all = { value: null, name: 'All' } as const;
  const groups = [
    filterGroup('Whose games', STATS_SCOPES.map((value) => ({ value, name: SCOPE_NAMES[value] })), filter.scope, (scope) => go({ scope })),
    filterGroup('Time', STATS_RANGES.map((value) => ({ value, name: RANGE_NAMES[value] })), filter.range, (range) => go({ range })),
    // A level matches computer games only, so another mode drops it.
    filterGroup('Mode', [all, ...SESSION_MODES.map((value) => ({ value, name: MODE_NAMES[value] }))], filter.mode, (mode) =>
      go({ mode, level: mode === null || mode === 'computer' ? filter.level : null }),
    ),
  ];
  if (filter.mode === null || filter.mode === 'computer') {
    groups.push(filterGroup('Level', [all, ...DIFFICULTIES.map((value) => ({ value, name: capital(value) }))], filter.level, (level) => go({ level })));
  }
  filters.replaceChildren(...groups);
}

// The address of the view, which also goes into the return address of a GitHub login.
function navigate(filter: StatsFilter): void {
  history.pushState(null, '', `${location.pathname}${statsQuery(filter)}`);
  void show(filter);
}

// The filter in the address. An address with an unknown filter shows everything, with a note.
function readFilter(): { filter: StatsFilter; problem: string } {
  const filter = parseStatsFilter(new URLSearchParams(location.search));
  if (filter !== undefined) return { filter, problem: '' };
  history.replaceState(null, '', location.pathname);
  return { filter: ALL_STATS, problem: 'The address had an unknown filter, so the page shows all games. ' };
}

// A newer view replaces a view that still loads.
let request = 0;

async function show(filter: StatsFilter, problem = ''): Promise<void> {
  const id = ++request;
  accountLink.href = myGamesHref(`${location.pathname}${location.search}`);
  renderFilters(filter);
  note.textContent = `${problem}Loading…`;
  grid.setAttribute('aria-busy', 'true');
  try {
    const stats = parseStats(await api.stats(filter));
    if (id !== request) return;
    grid.replaceChildren();
    draw(stats);
    const scope = stats.personal === null ? 'all players' : 'your games on every device that you logged in with, or on this browser';
    note.textContent = `${problem}Updated ${new Date(stats.generatedAt).toLocaleString()}. These numbers show ${scope}.`;
  } catch (error) {
    if (id !== request) return;
    grid.replaceChildren();
    note.textContent = `${problem}The stats did not load. ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (id === request) grid.removeAttribute('aria-busy');
  }
}

addEventListener('popstate', () => {
  const { filter, problem } = readFilter();
  void show(filter, problem);
});
const { filter, problem } = readFilter();
void show(filter, problem);
