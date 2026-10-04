import './style.css';
import { chooseMove, DIFFICULTIES, type Difficulty } from './ai.ts';
import { type CardInput, drawCard, saveImage, shareImage } from './card.ts';
import {
  LIMIT_RANGE,
  NO_LIMIT,
  type TimeControl,
  describeClock,
  formatClock,
  formatDuration,
  hasLimit,
  isFlagged,
  parseClock,
  remaining,
  sameClock,
} from './clock.ts';
import {
  CELL_COUNT,
  SIZE,
  type Game,
  type MoveError,
  type Player,
  newGame,
  other,
  play,
  replay,
  timeOut,
  toCell,
  toCoords,
  undo,
  winnerOf,
} from './game.ts';
import { api, OnlineError } from './online.ts';
import { type Code, type MatchOptions, type SessionView, normalizeCode, normalizeName, toGame } from './protocol.ts';
import { setMuted, sounds } from './sound.ts';

const MODES = ['computer', 'friend', 'online'] as const;
const VIEWS = ['tower', 'flat'] as const;
const LAYOUTS = ['grid', 'row', 'column', 'steps'] as const;
const PLAYERS = ['X', 'O'] as const;
// Palettes in style.css, in menu order. index.html repeats the names for its pre-paint script.
const THEMES = [
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
type Mode = (typeof MODES)[number];
type View = (typeof VIEWS)[number];
type Layout = (typeof LAYOUTS)[number];
type Theme = (typeof THEMES)[number];
const THEME_NAMES: Record<Theme, string> = {
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

type Settings = {
  mode: Mode;
  difficulty: Difficulty;
  human: Player;
  view: View;
  layout: Layout;
  hideBoard: boolean;
  hideHistory: boolean;
  // Locally, the time limit of every game. Online, the time limit for a session that this screen creates.
  clock: TimeControl;
  muted: boolean;
  theme: Theme;
};
type Toggle = 'hideBoard' | 'hideHistory';

const DEFAULTS: Settings = {
  mode: 'computer',
  difficulty: 'medium',
  human: 'X',
  view: 'tower',
  layout: 'grid',
  hideBoard: false,
  hideHistory: false,
  clock: NO_LIMIT,
  muted: false,
  theme: 'light',
};
const STORAGE_KEY = 'tick3d.settings';
// Inline icons draw in the text color, so they follow the theme. Emoji do not.
const SPEAKER = '<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>';
const SOUND_ON_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">${SPEAKER}<path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11"/></svg>`;
const SOUND_OFF_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">${SPEAKER}<path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>`;
const COMPUTER_DELAY_MS = 450;
const CARD_DELAY_MS = 1400;

type Refusal =
  | MoveError
  | 'wait'
  | 'not-your-turn'
  | 'spectator'
  | 'reviewing'
  | 'no-session'
  | 'locked';
const REFUSAL_TEXT: Record<Refusal, string> = {
  occupied: 'That cell is taken. Pick an empty cell.',
  'game-over': 'The game is over. Start a new game.',
  wait: 'Wait for the computer to move.',
  'not-your-turn': 'It is not your turn.',
  spectator: 'You are watching. Both seats are taken.',
  reviewing: 'You are looking at an old position. Go back to the live game first.',
  'no-session': 'Create an online game or join one with a code first.',
  locked: 'Settings are locked until this game ends.',
};

function oneOf<T extends string>(options: readonly T[], value: unknown, fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}

const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);

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
    hideBoard: bool(stored.hideBoard, DEFAULTS.hideBoard),
    hideHistory: bool(stored.hideHistory, DEFAULTS.hideHistory),
    clock: parseClock(stored.clock) ?? DEFAULTS.clock,
    muted: bool(stored.muted, DEFAULTS.muted),
    theme: oneOf(THEMES, stored.theme, DEFAULTS.theme),
  };
}

function saveSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage is blocked (private mode). Settings then last for this visit only.
  }
}

function element<T extends HTMLElement>(selector: string, type: new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`missing element ${selector}`);
  return found;
}

const boardEl = element('#board', HTMLDivElement);
const boardHiddenEl = element('#board-hidden', HTMLDivElement);
const statusEl = element('#status', HTMLDivElement);
const scoreEl = element('#score', HTMLDivElement);
const toastEl = element('#toast', HTMLDivElement);
const burstEl = element('#burst', HTMLDivElement);
const reviewEl = element('#review', HTMLDivElement);
const reviewLabel = element('#review-label', HTMLSpanElement);
const coordsForm = element('#coords', HTMLFormElement);
const coordsSlotsEl = element('#coords-slots', HTMLDivElement);
const coordsSlots = [...coordsSlotsEl.querySelectorAll('b')];
const coordsBack = element('#coords-back', HTMLButtonElement);
const coordsPlace = element('#coords-place', HTMLButtonElement);
const digitButtons = document.querySelectorAll<HTMLButtonElement>('[data-digit]');
const historyEl = element('#history', HTMLOListElement);
const onlineCodeEl = element('#online-code', HTMLElement);
const shareButton = element('#share', HTMLButtonElement);
const sessionNameInput = element('#session-name', HTMLInputElement);
const joinForm = element('#join', HTMLFormElement);
const joinCodeInput = element('#join-code', HTMLInputElement);
const newCodeButton = element('#new-code', HTMLButtonElement);
const newGameButton = element('#new-game', HTMLButtonElement);
const undoButton = element('#undo', HTMLButtonElement);
const soundButton = element('#sound', HTMLButtonElement);
const lockButton = element('#lock', HTMLButtonElement);
const clockSummary = element('#clock-summary', HTMLParagraphElement);
const clocksEl = element('#clocks', HTMLDivElement);
const clockNote = element('#clock-note', HTMLSpanElement);
const showCardButton = element('#show-card', HTMLButtonElement);
const cardDialog = element('#end-card', HTMLDialogElement);
const cardImage = element('#end-card-image', HTMLImageElement);
const cardCodeOption = element('#end-card-code-option', HTMLLabelElement);
const cardCode = element('#end-card-code', HTMLInputElement);
const cardLink = element('#end-card-link', HTMLInputElement);
const cardShareButton = element('#end-card-share', HTMLButtonElement);
const cardSaveButton = element('#end-card-save', HTMLButtonElement);
const cardCloseButton = element('#end-card-close', HTMLButtonElement);
const themeColorMeta = element('meta[name="theme-color"]', HTMLMetaElement);
const themeMenu = element('#theme-menu', HTMLDetailsElement);
const themeSwatch = element('#theme-swatch', HTMLSpanElement);
const themeName = element('#theme-name', HTMLSpanElement);
const themePicker = element('#theme-picker', HTMLDivElement);
const coordsTitle = element('#coords-title', HTMLSpanElement);

type Online = {
  code: Code;
  name: string;
  you: Player | null;
  seats: Record<Player, boolean>;
  options: MatchOptions;
  locked: boolean;
  clock: TimeControl;
  version: number;
  unsubscribe: () => void;
};

const settings = loadSettings();
// The session: every game played with the current settings. The last game is the live one.
let games: Game[] = [newGame('X', settings.clock)];
let online: Online | undefined;
let review: { game: number; move: number } | undefined;
// The lock for local games. Online sessions keep their lock on the server, for both players.
let localLocked = false;
let thinking = false;
let busy = false;
// Increments on every new local game, so a computer move scheduled for an old game is dropped.
let round = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
// Server time minus local time. Online move times come from the server, so the clocks use its time.
let serverOffset = 0;
let lastTickSecond: number | undefined;
let lastFlagRefresh = 0;
let card: { index: number; canvas: HTMLCanvasElement } | undefined;
// The keypad entry: layer, row, column, each 1..4. A tap fills the next one.
let coordDigits: number[] = [];

function current(): Game {
  const game = games.at(-1);
  if (game === undefined) throw new Error('session has no games');
  return game;
}

function setCurrent(game: Game): void {
  games = [...games.slice(0, -1), game];
}

const isLive = () => current().status.kind === 'playing';
const settingsLocked = () => (online ? online.locked : localLocked && isLive());

// Online, the hide options belong to the session and apply to both players. Locally, they are settings.
function matchOptions(): MatchOptions {
  return online ? online.options : { hideBoard: settings.hideBoard, hideHistory: settings.hideHistory };
}

// The time limit for the next game. The live game keeps its own limit in `current().clock`.
function nextClock(): TimeControl {
  return online ? online.clock : settings.clock;
}

const nowMs = () => Date.now() + (online ? serverOffset : 0);

// Watchers cannot change a session. Everybody can change a local game.
const canChangeMatch = () => online === undefined || online.you !== null;

// ---- Board ----

const cells: HTMLButtonElement[] = [];
for (let layer = 0; layer < SIZE; layer++) {
  const layerEl = document.createElement('div');
  layerEl.className = 'layer';
  layerEl.style.setProperty('--i', String(layer));
  layerEl.innerHTML = `<span class="layer-label">Layer ${layer + 1}</span>`;
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (let row = 0; row < SIZE; row++) {
    for (let column = 0; column < SIZE; column++) {
      const cell = toCell({ layer, row, column });
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cell';
      button.innerHTML = '<span class="piece"></span>';
      button.addEventListener('click', () => humanMove(cell));
      button.addEventListener('pointerenter', () => highlightColumn(cell));
      button.addEventListener('focus', () => highlightColumn(cell));
      button.addEventListener('pointerleave', () => highlightColumn(undefined));
      cells[cell] = button;
      grid.append(button);
    }
  }
  layerEl.append(grid);
  boardEl.append(layerEl);
}
if (cells.length !== CELL_COUNT) throw new Error('board build is incomplete');

function cellButton(cell: number): HTMLButtonElement {
  const button = cells[cell];
  if (!button) throw new RangeError(`no button for cell ${cell}`);
  return button;
}

function highlightColumn(cell: number | undefined): void {
  const target = cell === undefined ? undefined : toCoords(cell);
  cells.forEach((button, index) => {
    const { row, column } = toCoords(index);
    button.classList.toggle('peer', target !== undefined && row === target.row && column === target.column);
  });
}

// ---- Feedback ----

function showToast(text: string, tone: 'info' | 'problem' = 'info'): void {
  toastEl.textContent = text;
  toastEl.dataset.tone = tone;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

// A refused action: the error sound and a message in the problem style.
function showProblem(text: string): void {
  sounds.invalid();
  showToast(text, 'problem');
}

function showError(error: unknown): void {
  if (!(error instanceof OnlineError)) throw error;
  showProblem(error.message);
}

function reject(cell: number | undefined, reason: Refusal): void {
  showProblem(REFUSAL_TEXT[reason]);
  if (cell === undefined) return;
  const button = cellButton(cell);
  button.classList.remove('shake');
  void button.offsetWidth; // restart the animation
  button.classList.add('shake');
}

// The player at this screen, if there is exactly one.
function me(): Player | null {
  if (settings.mode === 'computer') return settings.human;
  if (settings.mode === 'online') return online?.you ?? null;
  return null;
}

// Plays the sound for the last move of the live game, and the result if the move ended it.
function announce(game: Game): void {
  const last = game.moves.at(-1);
  if (last === undefined) return;
  sounds.place(other(game.turn), toCoords(last).layer);
  if (game.status.kind !== 'playing') finish(game);
}

// The live game just ended: result sound, celebration, and the end card a moment later.
function finish(game: Game): void {
  const winner = winnerOf(game.status);
  const mine = me();
  if (winner === null) sounds.draw();
  else if (mine !== null && winner !== mine) sounds.lose();
  else {
    sounds.win();
    celebrate();
  }
  const index = games.length - 1;
  setTimeout(() => {
    // Show the card only if that game is still the finished live game and nothing else is open.
    if (games.length - 1 !== index || isLive() || review !== undefined || cardDialog.open) return;
    void openCard(index);
  }, CARD_DELAY_MS);
}

function celebrate(): void {
  const css = getComputedStyle(document.documentElement);
  const colors = ['--x', '--primary', '--o', '--toggle-on', '--win'].map((name) => css.getPropertyValue(name).trim());
  burstEl.replaceChildren(
    ...Array.from({ length: 36 }, (_, i) => {
      const spark = document.createElement('span');
      const angle = (i / 36) * Math.PI * 2;
      const distance = 120 + Math.random() * 160;
      spark.style.setProperty('--x', `${Math.cos(angle) * distance}px`);
      spark.style.setProperty('--y', `${Math.sin(angle) * distance}px`);
      spark.style.setProperty('--c', colors[i % colors.length] ?? '#fff');
      spark.style.animationDelay = `${Math.random() * 120}ms`;
      return spark;
    }),
  );
}

// ---- Local play ----

const isComputerTurn = () => settings.mode === 'computer' && isLive() && current().turn !== settings.human;

function humanMove(cell: number): void {
  if (review) return reject(cell, 'reviewing');
  if (settings.mode === 'online') return void onlineMove(cell);
  if (thinking || isComputerTurn()) return reject(cell, 'wait');
  const result = play(current(), cell);
  if (!result.ok) return reject(cell, result.error);
  commit(result.game);
}

// The lock holds for one game only, so it ends with the game.
function releaseLockIfOver(): void {
  if (!isLive()) localLocked = false;
}

function commit(next: Game): void {
  setCurrent(next);
  announce(next);
  releaseLockIfOver();
  render();
  scheduleComputer();
}

function scheduleComputer(): void {
  if (!isComputerTurn()) return;
  thinking = true;
  render();
  const scheduledRound = round;
  setTimeout(() => {
    if (scheduledRound !== round) return;
    // The hard level searches on the main thread for up to 600 ms. CSS animations keep running,
    // but input waits. Move the search to a Web Worker if the budget grows past about one second.
    const game = current();
    const cell = chooseMove(game.board, game.turn, settings.difficulty);
    thinking = false;
    const result = play(game, cell);
    if (!result.ok) throw new Error(`computer chose an illegal move: ${result.error} at cell ${cell}`);
    commit(result.game);
  }, COMPUTER_DELAY_MS);
}

// Starts the next local game. An empty live game is replaced, any other stays in the history.
function startLocalGame(): void {
  round++;
  thinking = false;
  review = undefined;
  localLocked = false;
  const next = newGame('X', settings.clock);
  games = current().moves.length === 0 ? [...games.slice(0, -1), next] : [...games, next];
  burstEl.replaceChildren();
  render();
  scheduleComputer();
}

function resetLocalSession(): void {
  games = [newGame('X', settings.clock)];
  startLocalGame();
}

function undoMove(): void {
  if (settings.mode === 'online' || thinking || review || !isLive() || current().moves.length === 0) return;
  // Undo would hand back time that the clock already counted, so a timed game has no undo.
  if (hasLimit(current().clock)) return;
  if (settingsLocked()) return reject(undefined, 'locked');
  // Against the computer, go back to the last position where it was the human's turn.
  const count = settings.mode === 'computer' ? 2 : 1;
  round++;
  setCurrent(undo(current(), count));
  sounds.click();
  render();
  scheduleComputer();
}

// ---- Online play ----

function setUrlCode(code: Code | undefined): void {
  const url = new URL(location.href);
  if (code === undefined) url.searchParams.delete('code');
  else url.searchParams.set('code', code);
  history.replaceState(null, '', url);
}

function applyView(view: SessionView): void {
  if (online === undefined || online.code !== view.code) throw new Error(`view for ${view.code} without an open session`);
  if (view.version < online.version) return; // an older response arrived late
  const before = current();
  const beforeCount = games.length;
  games = view.games.map(toGame);
  serverOffset = view.now - Date.now();
  const previous = online;
  online = { ...view, unsubscribe: online.unsubscribe };
  const after = current();
  if (!sameClock(online.clock, previous.clock)) {
    const startsLater = after.status.kind === 'playing' && after.moves.length > 0;
    showToast(`Time limit${startsLater ? ' for the next game' : ''}: ${describeClock(online.clock)}.`);
  }
  if (online.locked && !previous.locked) showToast('Settings are locked for both players until this game ends.');
  for (const [option, label] of [['hideBoard', 'Hide board'], ['hideHistory', 'Hide all but last move']] as const) {
    if (online.options[option] !== previous.options[option]) {
      showToast(`${label} is ${online.options[option] ? 'on' : 'off'} for both players.`);
    }
  }
  // A move that is not on screen yet came from the opponent. Our own moves were announced already.
  const isNewMove =
    games.length === beforeCount &&
    after.moves.length === before.moves.length + 1 &&
    before.moves.every((cell, i) => after.moves[i] === cell);
  const timedOutNow = games.length === beforeCount && before.status.kind === 'playing' && after.status.kind === 'timeout';
  if (isNewMove) announce(after);
  else if (timedOutNow) finish(after);
  if (review && review.game >= games.length) review = undefined;
  releaseLockIfOver();
  render();
}

function openSession(view: SessionView): void {
  online?.unsubscribe();
  round++; // drops a computer move scheduled for the local game
  thinking = false;
  if (settings.mode !== 'online') {
    settings.mode = 'online';
    saveSettings();
  }
  review = undefined;
  localLocked = false;
  burstEl.replaceChildren();
  online = { ...view, unsubscribe: () => undefined };
  games = view.games.map(toGame);
  serverOffset = view.now - Date.now();
  const code = view.code;
  online.unsubscribe = api.subscribe(code, () => void refresh(code));
  setUrlCode(code);
  render();
}

function leaveSession(): void {
  online?.unsubscribe();
  online = undefined;
  setUrlCode(undefined);
}

async function refresh(code: Code): Promise<void> {
  try {
    const view = await api.load(code);
    if (online?.code === code) applyView(view);
  } catch (error) {
    showError(error);
  }
}

async function withBusy(task: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  render();
  try {
    await task();
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    render();
  }
}

function defaultSessionName(): string {
  return `Game of ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

const createSession = () =>
  withBusy(async () => openSession(await api.create(defaultSessionName(), settings.clock)));

const joinSession = (code: Code) =>
  withBusy(async () => {
    let view = await api.load(code);
    if (view.you === null && (!view.seats.X || !view.seats.O)) view = await api.join(code);
    openSession(view);
    sounds.click();
    showToast(view.you === null ? 'Both seats are taken. You are watching.' : `Joined ${view.name} as ${view.you}.`);
  });

async function onlineMove(cell: number): Promise<void> {
  if (online === undefined) return reject(cell, 'no-session');
  if (online.you === null) return reject(cell, 'spectator');
  if (busy) return reject(cell, 'not-your-turn');
  const game = current();
  const result = play(game, cell, nowMs());
  if (!result.ok) return reject(cell, result.error);
  if (game.turn !== online.you) return reject(cell, 'not-your-turn');
  const code = online.code;
  const request = { game: games.length - 1, moveCount: game.moves.length, cell };
  // Show the move at once. The server answer replaces it, or a refresh undoes it on an error.
  setCurrent(result.game);
  announce(result.game);
  releaseLockIfOver();
  await withBusy(async () => {
    try {
      applyView(await api.move(code, request));
    } catch (error) {
      await refresh(code);
      throw error;
    }
  });
}

async function shareLink(): Promise<void> {
  if (online === undefined) return;
  const url = location.href;
  const text = `Play 3D tic-tac-toe with me on tick3d. Code ${online.code}.`;
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'tick3d', text, url });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied.');
  } catch {
    showToast(`Send this link: ${url}`);
  }
}

// ---- Rendering ----

function playerName(player: Player): string {
  const mine = me();
  if (settings.mode === 'friend' || mine === null) return `Player ${player}`;
  if (player === mine) return 'You';
  return settings.mode === 'computer' ? 'Computer' : 'Opponent';
}

function resultText(game: Game): string {
  switch (game.status.kind) {
    case 'won':
      return `${game.status.winner} won`;
    case 'timeout':
      return `${game.status.winner} won on time`;
    case 'draw':
      return 'Draw';
    case 'playing':
      return game === current() ? 'Live' : 'Not finished';
  }
}

function statusText(): string {
  const game = current();
  if (review) {
    const reviewed = games[review.game];
    return `Game ${review.game + 1} · move ${review.move} of ${reviewed?.moves.length ?? 0}`;
  }
  if (settings.mode === 'online' && online === undefined) return 'Create a game or enter a code';
  const mine = me();
  switch (game.status.kind) {
    case 'won':
      if (mine === null) return `Player ${game.status.winner} wins!`;
      if (game.status.winner === mine) return 'You win!';
      return settings.mode === 'computer' ? 'The computer wins.' : 'Your opponent wins.';
    case 'timeout': {
      const loser = other(game.status.winner);
      if (mine === null) return `${loser} ran out of time. Player ${game.status.winner} wins!`;
      if (game.status.winner !== mine) return 'You ran out of time.';
      return `${settings.mode === 'computer' ? 'The computer' : 'Your opponent'} ran out of time. You win!`;
    }
    case 'draw':
      return 'Draw. The cube is full.';
    case 'playing':
      if (thinking) return 'Computer is thinking…';
      if (settings.mode === 'friend') return `Player ${game.turn} to move`;
      if (settings.mode === 'online' && online !== undefined) {
        if (online.you === null) return `Watching · ${game.turn} to move`;
        if (!online.seats[other(online.you)]) return 'Waiting for a second player. Share the code.';
        return game.turn === online.you ? `Your move (${game.turn})` : `Opponent's move (${game.turn})`;
      }
      return `Your move (${game.turn})`;
  }
}

function shownGame(): Game {
  if (review === undefined) return current();
  const reviewed = games[review.game];
  if (reviewed === undefined) throw new Error(`no game ${review.game} to review`);
  return replay(reviewed.moves.slice(0, review.move), { first: reviewed.first, clock: reviewed.clock });
}

function render(): void {
  const game = shownGame();
  const live = review === undefined && isLive();
  const options = matchOptions();
  const hideBoard = options.hideBoard && live;
  const hideHistory = options.hideHistory && live;
  const frozen = settingsLocked();

  document.body.dataset.turn = game.turn;
  boardEl.className = `board ${settings.view} layout-${settings.layout}`;
  boardEl.classList.toggle('finished', game.status.kind !== 'playing');
  boardEl.classList.toggle('thinking', thinking || busy);
  boardEl.hidden = hideBoard;
  boardHiddenEl.hidden = !hideBoard;

  const winLine: readonly number[] = game.status.kind === 'won' ? game.status.line : [];
  const last = game.moves.at(-1);
  cells.forEach((button, cell) => {
    const actual = game.board[cell] ?? null;
    const mark = hideHistory && cell !== last ? null : actual;
    const { layer, row, column } = toCoords(cell);
    button.classList.toggle('x', mark === 'X');
    button.classList.toggle('o', mark === 'O');
    button.classList.toggle('win', winLine.includes(cell));
    button.classList.toggle('last', cell === last);
    button.setAttribute('aria-label', `Layer ${layer + 1}, row ${row + 1}, column ${column + 1}: ${mark ?? 'empty'}`);
  });

  statusEl.textContent = statusText();
  statusEl.dataset.state = review ? 'review' : current().status.kind;

  reviewEl.hidden = review === undefined;
  if (review) reviewLabel.textContent = statusText();
  coordsForm.hidden = review !== undefined;
  renderCoords();

  document.querySelectorAll<HTMLElement>('[data-show-mode]').forEach((field) => {
    field.hidden = field.dataset.showMode !== settings.mode;
  });
  document.querySelectorAll<HTMLElement>('[data-show-view]').forEach((field) => {
    field.hidden = field.dataset.showView !== settings.view;
  });
  document.querySelectorAll<HTMLElement>('.segmented').forEach((group) => {
    const value = String(settings[group.dataset.setting as keyof Settings]);
    group.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.value === value));
      button.disabled = frozen;
    });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((button) => {
    button.setAttribute('aria-pressed', String(options[button.dataset.toggle as Toggle]));
    button.disabled = frozen || busy || !canChangeMatch();
  });

  // Online box
  onlineCodeEl.textContent = online?.code ?? '····';
  shareButton.disabled = online === undefined;
  if (document.activeElement !== sessionNameInput) sessionNameInput.value = online?.name ?? '';
  sessionNameInput.disabled = online?.you == null || busy;
  joinCodeInput.disabled = frozen || busy;
  newCodeButton.disabled = frozen || busy;

  // Score: finished games of this session only.
  const score = { X: 0, O: 0, draw: 0 };
  for (const g of games) {
    const winner = winnerOf(g.status);
    if (winner !== null) score[winner]++;
    if (g.status.kind === 'draw') score.draw++;
  }
  scoreEl.innerHTML = [
    ['X', playerName('X'), score.X],
    ['draw', 'Draws', score.draw],
    ['O', playerName('O'), score.O],
  ]
    .map(([key, label, value]) => `<div class="tally ${key}"><b>${value}</b><span>${label}</span></div>`)
    .join('');

  historyEl.replaceChildren(
    ...games.map((g, index) => {
      const item = document.createElement('li');
      const reviewable = g !== current() || g.status.kind !== 'playing';
      item.innerHTML = `<span>Game ${index + 1}</span><span class="result">${resultText(g)} · ${g.moves.length} moves</span>`;
      if (reviewable) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = review?.game === index ? 'Viewing' : 'Replay';
        button.addEventListener('click', () => startReview(index));
        item.append(button);
      }
      if (g.status.kind !== 'playing') {
        const cardButton = document.createElement('button');
        cardButton.type = 'button';
        cardButton.textContent = 'Card';
        cardButton.addEventListener('click', () => void openCard(index));
        item.append(cardButton);
      }
      item.classList.toggle('active', review?.game === index);
      return item;
    }),
  );

  const onlineWithoutSeat = settings.mode === 'online' && online?.you == null;
  newGameButton.disabled = frozen || busy || thinking || onlineWithoutSeat || (settings.mode === 'online' && isLive());
  undoButton.hidden = settings.mode === 'online';
  undoButton.disabled =
    frozen || thinking || review !== undefined || !isLive() || current().moves.length === 0 || hasLimit(current().clock);
  showCardButton.hidden = isLive() || review !== undefined;
  renderClockEditor(frozen);
  renderClocks();
  lockButton.disabled = frozen || busy || !isLive() || review !== undefined || !canChangeMatch();
  const lockScope = online ? ' for both players' : '';
  lockButton.textContent = frozen ? `🔒 Locked${lockScope} until this game ends` : `🔓 Lock settings${lockScope}`;
  lockButton.setAttribute('aria-pressed', String(frozen));
  soundButton.innerHTML = settings.muted ? SOUND_OFF_ICON : SOUND_ON_ICON;
  soundButton.setAttribute('aria-pressed', String(!settings.muted));
}

// ---- Clock ----

function renderClocks(): void {
  const game = current();
  const left = remaining(game, nowMs());
  clocksEl.hidden = left === null || review !== undefined || (settings.mode === 'online' && online === undefined);
  if (left === null) return;
  const live = game.status.kind === 'playing';
  clocksEl.querySelectorAll<HTMLElement>('[data-clock]').forEach((chip) => {
    const player: Player = chip.dataset.clock === 'X' ? 'X' : 'O';
    const active = live && game.turn === player && game.moves.length >= 2;
    const clock = left[player];
    // The game limit is the main figure. With both limits, the active player also sees the move limit.
    const main = clock.game ?? clock.move ?? clock.left;
    const both = clock.game !== null && clock.move !== null;
    chip.textContent = `${playerName(player)} · ${formatClock(main)}${both && active ? ` · move ${formatClock(clock.move ?? 0)}` : ''}`;
    chip.classList.toggle('active', active);
    chip.classList.toggle('low', active && clock.left <= 10_000);
    chip.classList.toggle('out', clock.left <= 0);
  });
  clockNote.hidden = !live || game.moves.length >= 2;
}

// Runs 5 times a second: redraws the clocks, ticks in the last 10 seconds, and ends a game on time.
function tickClock(): void {
  renderClocks();
  const game = current();
  if (!hasLimit(game.clock) || game.status.kind !== 'playing') return;
  const now = nowMs();
  if (isFlagged(game, now)) {
    if (online === undefined) {
      round++; // drops a computer move in progress
      thinking = false;
      setCurrent(timeOut(game));
      releaseLockIfOver();
      finish(current());
      render();
    } else if (now - lastFlagRefresh > 1000) {
      // The server records the timeout when it reads the session, so a refresh is enough.
      lastFlagRefresh = now;
      void refresh(online.code);
    }
    return;
  }
  const left = remaining(game, now)?.[game.turn].left;
  if (left === undefined || game.moves.length < 2 || left > 10_000) return;
  const second = Math.ceil(left / 1000);
  if (second !== lastTickSecond) {
    lastTickSecond = second;
    sounds.tick(second <= 3);
  }
}

// The editor shows minutes for the game limit and seconds for the move limit.
const LIMIT_SCALE: Record<LimitKind, number> = { perGame: 60, perMove: 1 };
type LimitKind = keyof TimeControl;
// The last value of each limit, so a limit that is switched off comes back with the same value.
const lastLimit: Record<LimitKind, number> = { perGame: 300, perMove: 30 };

function limitControls(kind: LimitKind) {
  const box = element(`[data-limit="${kind}"]`, HTMLDivElement);
  const on = box.querySelector('[data-limit-on]');
  const value = box.querySelector('[data-limit-value]');
  if (!(on instanceof HTMLInputElement) || !(value instanceof HTMLInputElement)) {
    throw new Error(`time limit editor for ${kind} is incomplete`);
  }
  const options = box.querySelector('.limit-options');
  const custom = box.querySelector('.limit-custom');
  if (!(options instanceof HTMLElement) || !(custom instanceof HTMLElement)) {
    throw new Error(`time limit editor for ${kind} is incomplete`);
  }
  return { on, value, options, custom, presets: [...box.querySelectorAll<HTMLButtonElement>('[data-preset]')] };
}

const limitEditors: Record<LimitKind, ReturnType<typeof limitControls>> = {
  perGame: limitControls('perGame'),
  perMove: limitControls('perMove'),
};

function renderClockEditor(frozen: boolean): void {
  const next = nextClock();
  const disabled = frozen || busy || !canChangeMatch();
  for (const kind of ['perGame', 'perMove'] as const) {
    const { on, value, options, custom, presets } = limitEditors[kind];
    const seconds = next[kind];
    if (seconds !== null) lastLimit[kind] = seconds;
    on.checked = seconds !== null;
    on.disabled = disabled;
    // The choices show only while the limit is on.
    options.hidden = seconds === null;
    value.disabled = disabled;
    let onPreset = false;
    for (const preset of presets) {
      const pressed = Number(preset.dataset.preset) === seconds;
      onPreset ||= pressed;
      preset.setAttribute('aria-pressed', String(pressed));
      preset.disabled = disabled;
    }
    // A value that matches no quick pick is a custom value: the custom box shows it as selected.
    // With a quick pick selected, the custom box stays empty, so it never repeats the quick pick.
    const isCustom = seconds !== null && !onPreset;
    custom.classList.toggle('active', isCustom);
    if (document.activeElement !== value) value.value = isCustom ? String(seconds / LIMIT_SCALE[kind]) : '';
  }
  const game = current();
  const pending = game.status.kind === 'playing' && game.moves.length > 0 && !sameClock(game.clock, next);
  clockSummary.textContent = pending
    ? `This game: ${describeClock(game.clock)}. Next game: ${describeClock(next)}.`
    : describeClock(next);
}

function applyClock(clock: TimeControl): void {
  if (settingsLocked()) {
    render();
    return reject(undefined, 'locked');
  }
  if (sameClock(clock, nextClock())) return render();
  sounds.click();
  settings.clock = clock;
  saveSettings();
  if (online === undefined) {
    // A game keeps the limit it started with. A game without moves has not started yet.
    const game = current();
    if (game.status.kind === 'playing' && game.moves.length === 0) setCurrent({ ...game, clock });
    else if (game.status.kind === 'playing') showToast('The new time limit starts with the next game.');
    return render();
  }
  if (online.you === null) {
    render();
    return reject(undefined, 'spectator');
  }
  const code = online.code;
  void withBusy(async () => applyView(await api.update(code, { clock })));
}

function setLimit(kind: LimitKind, seconds: number | null): void {
  const { min, max } = LIMIT_RANGE[kind];
  if (seconds !== null && (!Number.isInteger(seconds) || seconds < min || seconds > max)) {
    const what = kind === 'perGame' ? 'The limit per player' : 'The limit per move';
    showProblem(`${what} goes from ${formatDuration(min)} to ${formatDuration(max)}.`);
    return render();
  }
  const next = nextClock();
  applyClock(kind === 'perGame' ? { ...next, perGame: seconds } : { ...next, perMove: seconds });
}

for (const kind of ['perGame', 'perMove'] as const) {
  const { on, value, presets } = limitEditors[kind];
  on.addEventListener('change', () => setLimit(kind, on.checked ? lastLimit[kind] : null));
  value.addEventListener('change', () => {
    // An emptied custom box means no change.
    if (value.value.trim() === '') return render();
    const amount = Number(value.value.replace(',', '.'));
    setLimit(kind, Number.isFinite(amount) ? Math.round(amount * LIMIT_SCALE[kind]) : NaN);
  });
  for (const preset of presets) {
    preset.addEventListener('click', () => setLimit(kind, Number(preset.dataset.preset)));
  }
}

// ---- End card ----

function cardInput(game: Game, index: number): CardInput {
  const winner = winnerOf(game.status);
  const mine = me();
  const title =
    winner === null
      ? 'Draw'
      : mine === null
        ? `${winner} wins`
        : winner === mine
          ? 'You win!'
          : settings.mode === 'computer'
            ? 'Computer wins'
            : 'You lost';
  const subtitle =
    game.status.kind === 'won'
      ? `Four in a row in ${game.moves.length} moves`
      : game.status.kind === 'timeout'
        ? `${other(game.status.winner)} ran out of time after ${game.moves.length} moves`
        : 'The cube is full. Nobody got four in a row.';
  const level = `${settings.difficulty.charAt(0).toUpperCase()}${settings.difficulty.slice(1)}`;
  const matchup =
    settings.mode === 'computer'
      ? `vs Computer · ${level} · You played ${settings.human}`
      : online
        ? `Online · ${online.name}`
        : 'Two players, one screen';
  const first = game.times[0] ?? 0;
  const last = game.times.at(-1) ?? 0;
  const duration = first > 0 && last > first ? ` · Game time ${formatClock(last - first)}` : '';
  const link = online ? `${location.host}/?code=${online.code}` : location.host;
  return {
    game,
    title,
    subtitle,
    matchup,
    details: `Game ${index + 1} · ${describeClock(game.clock)}${duration}`,
    date: new Date(last > 0 ? last - serverOffset : Date.now()),
    footer: [online && cardCode.checked ? `Code ${online.code}` : '', cardLink.checked ? link : '']
      .filter((part) => part !== '')
      .join(' · '),
  };
}

async function openCard(index: number): Promise<void> {
  const game = games[index];
  if (game === undefined || game.status.kind === 'playing') throw new Error(`game ${index} has no result to show`);
  // A local game has no code, so only the link option applies.
  cardCodeOption.hidden = online === undefined;
  const input = cardInput(game, index);
  const canvas = await drawCard(input);
  card = { index, canvas };
  cardImage.src = canvas.toDataURL('image/png');
  cardImage.alt = `${input.title}. ${input.subtitle}.`;
  if (!cardDialog.open) cardDialog.showModal();
}

function cardFilename(): string {
  return `tick3d-${new Date().toISOString().slice(0, 10)}.png`;
}

cardShareButton.addEventListener('click', () => {
  if (card === undefined) return;
  const { canvas, index } = card;
  const game = games[index];
  if (game === undefined) return;
  const input = cardInput(game, index);
  const url = cardLink.checked ? (online ? location.href : location.origin) : undefined;
  const code = cardCode.checked && online ? ` Code ${online.code}.` : '';
  void shareImage(canvas, cardFilename(), `${input.title}: ${input.subtitle} on tick3d.${code}`, url).then((outcome) => {
    if (outcome === 'copied') showToast('Image copied. Paste it anywhere.');
    if (outcome === 'saved') showToast('Image saved.');
  });
});

cardSaveButton.addEventListener('click', () => {
  if (card !== undefined) void saveImage(card.canvas, cardFilename());
});
cardCloseButton.addEventListener('click', () => cardDialog.close());
for (const option of [cardCode, cardLink]) {
  option.addEventListener('change', () => {
    if (card !== undefined) void openCard(card.index);
  });
}
// A click on the dimmed backdrop lands on the dialog element itself.
cardDialog.addEventListener('click', (event) => {
  if (event.target === cardDialog) cardDialog.close();
});
showCardButton.addEventListener('click', () => {
  if (!isLive()) void openCard(games.length - 1);
});

// ---- Review ----

function startReview(index: number): void {
  const game = games[index];
  if (game === undefined) throw new RangeError(`no game ${index}`);
  review = { game: index, move: game.moves.length };
  sounds.click();
  render();
}

function stepReview(action: string | undefined): void {
  if (review === undefined) return;
  const total = games[review.game]?.moves.length ?? 0;
  const moves: Record<string, number> = { first: 0, prev: review.move - 1, next: review.move + 1, last: total };
  if (action === 'exit') review = undefined;
  else if (action !== undefined && action in moves) {
    review = { ...review, move: Math.min(total, Math.max(0, moves[action] ?? review.move)) };
  } else throw new Error(`unknown review action ${action}`);
  sounds.click();
  render();
}

// ---- Theme ----

// One preview tile per theme. Each swatch carries data-theme, so it draws with that theme's tokens.
const themeButtons = THEMES.map((theme) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.themeChoice = theme;
  button.innerHTML = `<span class="swatch" data-theme="${theme}"><span></span></span>${THEME_NAMES[theme]}`;
  button.addEventListener('click', () => {
    themeMenu.open = false;
    if (theme === settings.theme) return;
    settings.theme = theme;
    saveSettings();
    sounds.click();
    applyTheme();
  });
  return button;
});
themePicker.replaceChildren(...themeButtons);

// The theme is a per-screen look like the sound, so the settings lock does not hold it.
function applyTheme(): void {
  document.documentElement.dataset.theme = settings.theme;
  themeButtons.forEach((button) =>
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === settings.theme)),
  );
  themeSwatch.dataset.theme = settings.theme;
  themeName.textContent = THEME_NAMES[settings.theme];
  themeColorMeta.content = getComputedStyle(document.documentElement).getPropertyValue('--page').trim();
}

// ---- Settings ----

function changeSetting(setting: string, value: string | undefined): void {
  if (settingsLocked()) return reject(undefined, 'locked');
  const previousMode = settings.mode;
  switch (setting) {
    case 'view':
      settings.view = oneOf(VIEWS, value, settings.view);
      break;
    case 'layout':
      settings.layout = oneOf(LAYOUTS, value, settings.layout);
      break;
    case 'mode':
      settings.mode = oneOf(MODES, value, settings.mode);
      break;
    case 'difficulty':
      settings.difficulty = oneOf(DIFFICULTIES, value, settings.difficulty);
      break;
    case 'human':
      settings.human = oneOf(PLAYERS, value, settings.human);
      break;
    default:
      throw new Error(`unknown setting ${setting}`);
  }
  saveSettings();
  sounds.click();
  if (setting === 'view' || setting === 'layout') return render();
  if (setting === 'mode' && previousMode === 'online') leaveSession();
  if (settings.mode === 'online') {
    games = [newGame()];
    review = undefined;
    render();
    if (previousMode !== 'online') void createSession();
    return;
  }
  // A different match-up means a fresh session.
  resetLocalSession();
}

document.querySelectorAll<HTMLElement>('.segmented').forEach((group) => {
  const setting = group.dataset.setting;
  if (setting === undefined) throw new Error('segmented control without data-setting');
  group.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-pressed') === 'true') return;
      changeSetting(setting, button.dataset.value);
    });
  });
});

document.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((button) => {
  const toggle = button.dataset.toggle;
  if (toggle !== 'hideBoard' && toggle !== 'hideHistory') throw new Error(`unknown toggle ${toggle}`);
  button.addEventListener('click', () => {
    if (settingsLocked()) return reject(undefined, 'locked');
    sounds.click();
    if (online === undefined) {
      settings[toggle] = !settings[toggle];
      saveSettings();
      return render();
    }
    if (online.you === null) return reject(undefined, 'spectator');
    const code = online.code;
    const value = !online.options[toggle];
    const changes = toggle === 'hideBoard' ? { hideBoard: value } : { hideHistory: value };
    void withBusy(async () => applyView(await api.update(code, changes)));
  });
});

// ---- Other controls ----

// The cell the keypad points at once layer, row and column are all chosen.
function coordTarget(): number | undefined {
  const [layer, row, column] = coordDigits;
  if (layer === undefined || row === undefined || column === undefined) return undefined;
  return toCell({ layer: layer - 1, row: row - 1, column: column - 1 });
}

// Until the player taps a number, the slots show the last move of the game, so its
// coordinates stay readable with the board hidden. A tap starts the player's own entry.
function renderCoords(): void {
  const game = current();
  const last = game.moves.at(-1);
  const showLast = coordDigits.length === 0 && last !== undefined;
  const lastPlayer = other(game.turn);
  let digits = coordDigits;
  if (showLast) {
    const { layer, row, column } = toCoords(last);
    digits = [layer + 1, row + 1, column + 1];
  }
  coordsSlots.forEach((slot, i) => {
    slot.textContent = String(digits[i] ?? '');
    slot.parentElement?.classList.toggle('next', !showLast && i === coordDigits.length);
  });
  coordsSlotsEl.classList.toggle('played-x', showLast && lastPlayer === 'X');
  coordsSlotsEl.classList.toggle('played-o', showLast && lastPlayer === 'O');
  const name = playerName(lastPlayer);
  const mark = name === `Player ${lastPlayer}` ? '' : ` (${lastPlayer})`;
  coordsTitle.textContent = showLast ? `${name} played${mark}` : 'Move by coordinates';
  const target = coordTarget();
  cells.forEach((button, cell) => button.classList.toggle('aim', cell === target));
  const full = coordDigits.length === 3;
  digitButtons.forEach((button) => (button.disabled = full));
  coordsBack.disabled = coordDigits.length === 0;
  coordsPlace.disabled = !full;
}

digitButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const digit = Number(button.dataset.digit);
    if (!Number.isInteger(digit) || digit < 1 || digit > SIZE) throw new Error(`bad keypad digit ${button.dataset.digit}`);
    if (coordDigits.length >= 3) return;
    coordDigits = [...coordDigits, digit];
    sounds.click();
    renderCoords();
  });
});

coordsBack.addEventListener('click', () => {
  coordDigits = coordDigits.slice(0, -1);
  sounds.click();
  renderCoords();
});

coordsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const target = coordTarget();
  if (target === undefined) {
    showProblem('Tap a layer, a row and a column first.');
    return;
  }
  coordDigits = [];
  humanMove(target);
  renderCoords();
});

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (settingsLocked()) return reject(undefined, 'locked');
  const code = normalizeCode(joinCodeInput.value);
  if (code === undefined) {
    showProblem('A code has 4 letters or digits.');
    return;
  }
  joinCodeInput.value = '';
  void joinSession(code);
});

newCodeButton.addEventListener('click', () => {
  if (settingsLocked()) return reject(undefined, 'locked');
  sounds.click();
  void createSession();
});

shareButton.addEventListener('click', () => void shareLink());

sessionNameInput.addEventListener('change', () => {
  if (online === undefined) return;
  const name = normalizeName(sessionNameInput.value);
  if (name === undefined) {
    showProblem('A name needs 1 to 40 characters.');
    sessionNameInput.value = online.name;
    return;
  }
  const code = online.code;
  void withBusy(async () => {
    applyView(await api.update(code, { name }));
    showToast('Session renamed.');
  });
});

reviewEl.querySelectorAll<HTMLButtonElement>('[data-review]').forEach((button) => {
  button.addEventListener('click', () => stepReview(button.dataset.review));
});

newGameButton.addEventListener('click', () => {
  if (settingsLocked()) return reject(undefined, 'locked');
  sounds.click();
  if (settings.mode !== 'online') return startLocalGame();
  if (online === undefined) return reject(undefined, 'no-session');
  const code = online.code;
  void withBusy(async () => {
    review = undefined;
    burstEl.replaceChildren();
    applyView(await api.newGame(code));
  });
});

undoButton.addEventListener('click', undoMove);

lockButton.addEventListener('click', () => {
  if (!isLive() || review || settingsLocked()) return;
  sounds.click();
  if (online === undefined) {
    localLocked = true;
    return render();
  }
  if (online.you === null) return reject(undefined, 'spectator');
  const code = online.code;
  void withBusy(async () => applyView(await api.lock(code)));
});

soundButton.addEventListener('click', () => {
  settings.muted = !settings.muted;
  setMuted(settings.muted);
  saveSettings();
  sounds.click();
  render();
});

// ---- Start ----

setMuted(settings.muted);
setInterval(tickClock, 200);
applyTheme();
const linkCode = new URLSearchParams(location.search).get('code');
if (linkCode !== null) {
  const code = normalizeCode(linkCode);
  if (code === undefined) {
    setUrlCode(undefined);
    showToast(`The link code "${linkCode}" is not valid.`);
    startLocalGame();
  } else {
    render();
    void joinSession(code);
  }
} else {
  startLocalGame();
}
