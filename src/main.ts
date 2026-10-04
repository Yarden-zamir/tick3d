import './style.css';
import { chooseMove, DIFFICULTIES, type Difficulty } from './ai.ts';
import {
  CELL_COUNT,
  SIZE,
  type Game,
  type MoveError,
  type Player,
  newGame,
  other,
  parseCoordinates,
  play,
  replay,
  toCell,
  toCoords,
  undo,
} from './game.ts';
import { api, OnlineError } from './online.ts';
import { type Code, type SessionView, normalizeCode, normalizeName } from './protocol.ts';
import { setMuted, sounds } from './sound.ts';

const MODES = ['computer', 'friend', 'online'] as const;
const VIEWS = ['tower', 'flat'] as const;
const LAYOUTS = ['grid', 'row', 'column', 'steps'] as const;
const PLAYERS = ['X', 'O'] as const;
type Mode = (typeof MODES)[number];
type View = (typeof VIEWS)[number];
type Layout = (typeof LAYOUTS)[number];

type Settings = {
  mode: Mode;
  difficulty: Difficulty;
  human: Player;
  view: View;
  layout: Layout;
  hideBoard: boolean;
  hideHistory: boolean;
  muted: boolean;
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
  muted: false,
};
const STORAGE_KEY = 'tick3d.settings';
const COMPUTER_DELAY_MS = 450;

type Refusal = MoveError | 'wait' | 'not-your-turn' | 'spectator' | 'reviewing' | 'no-session' | 'locked';
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
    muted: bool(stored.muted, DEFAULTS.muted),
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
const coordsInput = element('#coords-input', HTMLInputElement);
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

type Online = {
  code: Code;
  name: string;
  you: Player | null;
  seats: Record<Player, boolean>;
  version: number;
  unsubscribe: () => void;
};

const settings = loadSettings();
// The session: every game played with the current settings. The last game is the live one.
let games: Game[] = [newGame()];
let online: Online | undefined;
let review: { game: number; move: number } | undefined;
let locked = false;
let thinking = false;
let busy = false;
// Increments on every new local game, so a computer move scheduled for an old game is dropped.
let round = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function current(): Game {
  const game = games.at(-1);
  if (game === undefined) throw new Error('session has no games');
  return game;
}

function setCurrent(game: Game): void {
  games = [...games.slice(0, -1), game];
}

const isLive = () => current().status.kind === 'playing';
const settingsLocked = () => locked && isLive();

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

function showToast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function showError(error: unknown): void {
  if (!(error instanceof OnlineError)) throw error;
  sounds.invalid();
  showToast(error.message);
}

function reject(cell: number | undefined, reason: Refusal): void {
  sounds.invalid();
  showToast(REFUSAL_TEXT[reason]);
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

// Plays the sounds for the last move of `game`, and for the result if the move ended it.
function announce(game: Game): void {
  const last = game.moves.at(-1);
  if (last === undefined) return;
  sounds.place(other(game.turn), toCoords(last).layer);
  if (game.status.kind === 'won') {
    const mine = me();
    if (mine !== null && game.status.winner !== mine) sounds.lose();
    else {
      sounds.win();
      celebrate();
    }
  } else if (game.status.kind === 'draw') {
    sounds.draw();
  }
}

function celebrate(): void {
  const colors = ['#ff6b8b', '#ffb36b', '#46d9ff', '#9b8cff', '#7dffb2'];
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
  if (!isLive()) locked = false;
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
  locked = false;
  games = current().moves.length === 0 ? [...games.slice(0, -1), newGame()] : [...games, newGame()];
  burstEl.replaceChildren();
  render();
  scheduleComputer();
}

function resetLocalSession(): void {
  games = [newGame()];
  startLocalGame();
}

function undoMove(): void {
  if (settings.mode === 'online' || thinking || review || !isLive() || current().moves.length === 0) return;
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
  games = view.games.map((moves) => replay(moves));
  online = { ...online, name: view.name, you: view.you, seats: view.seats, version: view.version };
  const after = current();
  // A move that is not on screen yet came from the opponent. Our own moves were announced already.
  const isNewMove =
    games.length === beforeCount &&
    after.moves.length === before.moves.length + 1 &&
    before.moves.every((cell, i) => after.moves[i] === cell);
  if (isNewMove) announce(after);
  if (review && review.game >= games.length) review = undefined;
  releaseLockIfOver();
  render();
}

function openSession(view: SessionView): void {
  online?.unsubscribe();
  review = undefined;
  locked = false;
  burstEl.replaceChildren();
  online = { ...view, unsubscribe: () => undefined };
  games = view.games.map((moves) => replay(moves));
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

const createSession = () => withBusy(async () => openSession(await api.create(defaultSessionName())));

const joinSession = (code: Code) =>
  withBusy(async () => {
    let view = await api.load(code);
    if (view.you === null && (!view.seats.X || !view.seats.O)) view = await api.join(code);
    if (settings.mode !== 'online') {
      settings.mode = 'online';
      saveSettings();
    }
    openSession(view);
    sounds.click();
    showToast(view.you === null ? 'Both seats are taken. You are watching.' : `Joined ${view.name} as ${view.you}.`);
  });

async function onlineMove(cell: number): Promise<void> {
  if (online === undefined) return reject(cell, 'no-session');
  if (online.you === null) return reject(cell, 'spectator');
  if (busy) return reject(cell, 'not-your-turn');
  const game = current();
  const result = play(game, cell);
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
  return replay(reviewed.moves.slice(0, review.move), reviewed.first);
}

function render(): void {
  const game = shownGame();
  const live = review === undefined && isLive();
  const hideBoard = settings.hideBoard && live;
  const hideHistory = settings.hideHistory && live;
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
    button.setAttribute('aria-pressed', String(settings[button.dataset.toggle as Toggle]));
    button.disabled = frozen;
  });

  // Online box
  onlineCodeEl.textContent = online?.code ?? '····';
  shareButton.disabled = online === undefined;
  if (document.activeElement !== sessionNameInput) sessionNameInput.value = online?.name ?? '';
  sessionNameInput.disabled = online?.you == null || busy;
  joinCodeInput.disabled = frozen || busy;
  newCodeButton.disabled = frozen || busy;
  newCodeButton.textContent = online === undefined ? 'Create game' : 'New code';

  // Score: finished games of this session only.
  const score = { X: 0, O: 0, draw: 0 };
  for (const g of games) {
    if (g.status.kind === 'won') score[g.status.winner]++;
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
      item.classList.toggle('active', review?.game === index);
      return item;
    }),
  );

  const onlineWithoutSeat = settings.mode === 'online' && online?.you == null;
  newGameButton.disabled = frozen || busy || thinking || onlineWithoutSeat || (settings.mode === 'online' && isLive());
  undoButton.hidden = settings.mode === 'online';
  undoButton.disabled = frozen || thinking || review !== undefined || !isLive() || current().moves.length === 0;
  lockButton.disabled = frozen || !isLive() || review !== undefined;
  lockButton.textContent = frozen ? '🔒 Locked until this game ends' : '🔓 Lock settings for this game';
  lockButton.setAttribute('aria-pressed', String(frozen));
  soundButton.textContent = settings.muted ? '🔇' : '🔊';
  soundButton.setAttribute('aria-pressed', String(!settings.muted));
}

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
    settings[toggle] = !settings[toggle];
    saveSettings();
    sounds.click();
    render();
  });
});

// ---- Other controls ----

coordsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const coords = parseCoordinates(coordsInput.value);
  if (coords === undefined) {
    sounds.invalid();
    showToast('Type three numbers from 1 to 4: layer, row, column.');
    return;
  }
  coordsInput.value = '';
  humanMove(toCell(coords));
});

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (settingsLocked()) return reject(undefined, 'locked');
  const code = normalizeCode(joinCodeInput.value);
  if (code === undefined) {
    sounds.invalid();
    showToast('A code has 4 letters or digits.');
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
    sounds.invalid();
    showToast('A name needs 1 to 40 characters.');
    sessionNameInput.value = online.name;
    return;
  }
  const code = online.code;
  void withBusy(async () => {
    applyView(await api.rename(code, name));
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
  if (!isLive() || review) return;
  locked = true;
  sounds.click();
  render();
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
