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
import { type DeviceDb, memoryDeviceDb, openDeviceDb } from './device-db.ts';
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
  toCell,
  toCoords,
  winnerOf,
} from './game.ts';
import { type LocalBackend, createLocalBackend } from './local.ts';
import { type RecordNews, type Records, addLoss, parseRecords } from './records.ts';
import { DEFAULT_TUNING, type Tuning, TUNING_FIELDS, fieldValue, isDefaultTuning, parseTuning } from './tuning.ts';
import { DEVICE_ICONS, deviceLabel, detectDevice } from './nearby/device.ts';
import { type Channel, answerOffer, createOffer } from './nearby/peer.ts';
import { renderQr } from './nearby/qr.ts';
import { type NearbyGuest, type NearbyHost, createNearbyGuest, createNearbyHost } from './nearby/session.ts';
import { type Hello, decodeSignal } from './nearby/signal.ts';
import { setupPwa } from './pwa.ts';
import { type Me, OnlineError, api, token } from './online.ts';
import {
  type ChatMessage,
  type Code,
  type MatchOptions,
  type MoveRequest,
  type ResultUpload,
  type SessionUpdate,
  type SessionView,
  type Tally,
  normalizeChat,
  normalizeCode,
  normalizeName,
  toGame,
  toRecord,
} from './protocol.ts';
import { SessionError } from './session/core.ts';
import type { SessionDoc } from './session/format.ts';
import { setMuted, sounds } from './sound.ts';

const MODES = ['computer', 'friend', 'online', 'nearby'] as const;
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
  // The time limit for the next session this screen starts. A session keeps its own limit after that.
  clock: TimeControl;
  muted: boolean;
  // The tower's turn around its vertical axis, in degrees. Dragging the tower sets it.
  spin: number;
  theme: Theme;
};
type Toggle = 'hideBoard' | 'hideHistory';

const DEFAULTS: Settings = {
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
  'no-session': 'Start a game, or join one with a code, first.',
  locked: 'Settings are locked until this game ends.',
};

function oneOf<T extends string>(options: readonly T[], value: unknown, fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}

const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
const wrapSpin = (spin: number) => ((spin % 360) + 360) % 360;
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
const shareQrButton = element('#share-qr', HTMLButtonElement);
const onlineQr = element('#online-qr', HTMLDivElement);
const onlineQrImage = element('#online-qr-image', HTMLDivElement);
const onlineQrCaption = element('#online-qr-caption', HTMLSpanElement);
const sessionNameInput = element('#session-name', HTMLInputElement);
const joinForm = element('#join', HTMLFormElement);
const joinCodeInput = element('#join-code', HTMLInputElement);
const newCodeButton = element('#new-code', HTMLButtonElement);
const newGameButton = element('#new-game', HTMLButtonElement);
const undoButton = element('#undo', HTMLButtonElement);
const soundButton = element('#sound', HTMLButtonElement);
const lockButton = element('#lock', HTMLButtonElement);
const resetAngleButton = element('#reset-angle', HTMLButtonElement);
const rulesButton = element('#rules-button', HTMLButtonElement);
const rulesBanner = element('#rules-banner', HTMLButtonElement);
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
const cardNewGameButton = element('#end-card-new-game', HTMLButtonElement);
const advancedBox = element('#advanced', HTMLDetailsElement);
const tuningEl = element('#tuning', HTMLDivElement);
const tuningReset = element('#tuning-reset', HTMLButtonElement);
const themeColorMeta = element('meta[name="theme-color"]', HTMLMetaElement);
const themeMenu = element('#theme-menu', HTMLDetailsElement);
const themeSwatch = element('#theme-swatch', HTMLSpanElement);
const themeName = element('#theme-name', HTMLSpanElement);
const themePicker = element('#theme-picker', HTMLDivElement);
const coordsTitle = element('#coords-title', HTMLSpanElement);
const chatEl = element('#chat', HTMLElement);
const chatLog = element('#chat-log', HTMLOListElement);
const chatForm = element('#chat-form', HTMLFormElement);
const chatInput = element('#chat-input', HTMLInputElement);
const chatSend = element('#chat-send', HTMLButtonElement);
const chatNotice = element('#chat-notice', HTMLButtonElement);
const chatNoticeFrom = element('#chat-notice-from', HTMLElement);
const chatNoticeText = element('#chat-notice-text', HTMLSpanElement);
const accountButton = element('#account-button', HTMLButtonElement);
const accountAvatar = element('#account-avatar', HTMLImageElement);
const accountName = element('#account-name', HTMLSpanElement);
const offlineBadge = element('#offline-badge', HTMLSpanElement);
const updateBar = element('#update-bar', HTMLDivElement);
const updateReload = element('#update-reload', HTMLButtonElement);
const myGamesDialog = element('#my-games', HTMLDialogElement);
const myGamesClose = element('#my-games-close', HTMLButtonElement);
const homeLink = element('#home-link', HTMLAnchorElement);
const homeConfirm = element('#home-confirm', HTMLDialogElement);
const homeConfirmText = element('#home-confirm-text', HTMLParagraphElement);
const homeConfirmLeave = element('#home-confirm-leave', HTMLButtonElement);
const homeConfirmStay = element('#home-confirm-stay', HTMLButtonElement);
const accountBox = element('#account-box', HTMLDivElement);
const myGamesNote = element('#my-games-note', HTMLParagraphElement);
const myGamesStats = element('#my-games-stats', HTMLDivElement);
const myGamesOnlineBox = element('#my-games-online-box', HTMLElement);
const myGamesOnline = element('#my-games-online', HTMLUListElement);
const myGamesDevice = element('#my-games-device', HTMLUListElement);
const lanHost = element('#lan-host', HTMLParagraphElement);
const nearbyDeviceIcon = element('#nearby-device-icon', HTMLSpanElement);
const nearbyNameInput = element('#nearby-name', HTMLInputElement);
const nearbyStart = element('#nearby-start', HTMLDivElement);
const nearbyHostButton = element('#nearby-host', HTMLButtonElement);
const nearbyJoinButton = element('#nearby-join', HTMLButtonElement);
const nearbyStep = element('#nearby-step', HTMLDivElement);
const nearbyStepText = element('#nearby-step-text', HTMLParagraphElement);
const nearbyQr = element('#nearby-qr', HTMLDivElement);
const nearbyText = element('#nearby-text', HTMLDetailsElement);
const nearbyCodeOut = element('#nearby-code-out', HTMLTextAreaElement);
const nearbyCopy = element('#nearby-copy', HTMLButtonElement);
const nearbyInput = element('#nearby-input', HTMLDivElement);
const nearbyCodeIn = element('#nearby-code-in', HTMLInputElement);
const nearbyUseCode = element('#nearby-use-code', HTMLButtonElement);
const nearbyCancel = element('#nearby-cancel', HTMLButtonElement);
const nearbyDevices = element('#nearby-devices', HTMLUListElement);
const nearbyActions = element('#nearby-actions', HTMLDivElement);
const nearbyAdd = element('#nearby-add', HTMLButtonElement);
const nearbyStop = element('#nearby-stop', HTMLButtonElement);

// The open session: its latest view, the backend that holds it, and its mode.
type Session = SessionView & { backend: SessionBackend; mode: Mode; unsubscribe: () => void };

const settings = loadSettings();
// The games of the open session, oldest first. The last game is the live one.
let games: Game[] = [newGame('X', settings.clock)];
let session: Session | undefined;
let review: { game: number; move: number } | undefined;
// Storage on this device, and the backend for computer, friend and hosted Nearby games.
let deviceDb: DeviceDb | undefined;
let local: LocalBackend | undefined;
// Login state from the server. Without a network or on a LAN host, login is not available.
let account: Me = { loginAvailable: false, user: null };
let thinking = false;
let busy = false;
// Increments on every new local game, so a computer move scheduled for an old game is dropped.
let round = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
// Chat sends do not use `busy`, so a message never blocks a move.
let chatSending = false;
// What the chat log shows, so a render rebuilds it (and scrolls it) only when messages change.
let chatShown = '';
let chatNoticeTimer: ReturnType<typeof setTimeout> | undefined;
// Messages from the other player that arrived while this tab was in the background.
let unread = 0;
const baseTitle = document.title;
// Session holder time minus local time. Move times come from the server or the Nearby host, so the clocks use its time.
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
const settingsLocked = () => session?.locked ?? false;
// A game with another device: online, or Nearby. Moves are final and chat is open.
const shared = () => session?.mode === 'online' || session?.mode === 'nearby';

// The hide options belong to the session. With another device they apply to both players.
function matchOptions(): MatchOptions {
  return session?.options ?? { hideBoard: false, hideHistory: false };
}

// The time limit for the next game. The live game keeps its own limit in `current().clock`.
function nextClock(): TimeControl {
  return session?.clock ?? settings.clock;
}

const nowMs = () => Date.now() + serverOffset;

// Watchers cannot change a session.
const canChangeMatch = () => session !== undefined && session.you !== null;

// ---- Board ----

const cells: HTMLButtonElement[] = [];
// The tower draws each layer as flat sheets stacked in 3D, from the bottom up: the plate (the
// board's underside), the base (the board's top with a footprint under each tile), the grid of
// tiles (the cells you click), and the marks (the pieces, standing on the tiles). Each sheet is
// painted once; turning the tower only moves the sheets. The flat view shows the grid alone.
// Heights above the board's top, in cells.
const SHEETS = { plate: -0.14, base: 0, grid: 0.035, marks: 0.065 } as const;
type Sheet = keyof typeof SHEETS;
const sheets: { element: HTMLDivElement; sheet: Sheet }[] = [];
// The piece shown on the marks sheet for each cell.
const marks: HTMLSpanElement[] = [];

function sheetOf(sheet: Sheet, className: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = className;
  sheets.push({ element, sheet });
  return element;
}

for (let layer = 0; layer < SIZE; layer++) {
  const layerEl = document.createElement('div');
  layerEl.className = 'layer';
  layerEl.style.setProperty('--i', String(layer));
  layerEl.innerHTML = `<span class="layer-label">Layer ${layer + 1}</span>`;
  const plate = sheetOf('plate', 'plate');
  const base = sheetOf('base', 'grid base');
  const grid = sheetOf('grid', 'grid');
  const markSheet = sheetOf('marks', 'grid marks');
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
      base.append(Object.assign(document.createElement('span'), { className: 'foot' }));
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.innerHTML = '<span class="piece"></span>';
      marks[cell] = mark;
      markSheet.append(mark);
    }
  }
  // Bottom sheet first: the sheets paint in this order, so higher sheets cover lower ones.
  layerEl.append(plate, base, grid, markSheet);
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

// ---- Tower camera ----

// The tower only turns around its vertical axis: the tilt stays at the resting view.
// Degrees of turn per pixel dragged sideways.
const DRAG_SPIN = 0.4;
// A press counts as a drag after this many pixels sideways, so a tap still places a mark.
const DRAG_THRESHOLD = 6;

// The tower's fixed tilt, in degrees. Only the spin changes.
const TOWER_TILT = 62;
let cameraShown = '';

// Turning the tower only changes the transform of the 16 sheets. Each sheet is flat (style.css),
// so the browser turns it as one ready-made picture: the cost of a frame does not grow with the
// number of marks. Nothing else on the page is restyled during a drag.
function applyCamera(): void {
  const turn = settings.view === 'tower' ? `rotateX(${TOWER_TILT}deg) rotateZ(${settings.spin}deg)` : '';
  if (turn !== cameraShown) {
    cameraShown = turn;
    // Each sheet rises by its height in the board's own frame, so the edges show under the
    // tiles and pieces at any turn.
    for (const { element, sheet } of sheets) {
      element.style.transform = turn && `${turn} translateZ(calc(var(--cell) * ${SHEETS[sheet]}))`;
    }
  }
  resetAngleButton.disabled = settings.spin === DEFAULTS.spin;
}

type Drag = { pointer: number; x: number; spin: number; moved: boolean };
let drag: Drag | undefined;
let dragFrame = 0;
// The click that ends a drag must not place a mark.
let swallowClick = false;

boardEl.addEventListener('pointerdown', (event) => {
  if (settings.view !== 'tower' || !event.isPrimary || event.button !== 0) return;
  drag = { pointer: event.pointerId, x: event.clientX, spin: settings.spin, moved: false };
});

boardEl.addEventListener('pointermove', (event) => {
  if (drag === undefined || event.pointerId !== drag.pointer) return;
  const dx = event.clientX - drag.x;
  if (!drag.moved) {
    if (Math.abs(dx) < DRAG_THRESHOLD) return;
    drag.moved = true;
    boardEl.dataset.dragging = '';
    boardEl.setPointerCapture(event.pointerId);
    highlightColumn(undefined);
  }
  settings.spin = wrapSpin(drag.spin + dx * DRAG_SPIN);
  // One style update per frame, however fast the pointer events come.
  if (dragFrame === 0) {
    dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;
      applyCamera();
    });
  }
});

function endDrag(event: PointerEvent): void {
  if (drag === undefined || event.pointerId !== drag.pointer) return;
  if (drag.moved) {
    // A click follows pointerup in the same task, or not at all. Either way the flag ends here.
    swallowClick = event.type === 'pointerup';
    setTimeout(() => (swallowClick = false));
    delete boardEl.dataset.dragging;
    applyCamera();
    saveSettings();
  }
  drag = undefined;
}

boardEl.addEventListener('pointerup', endDrag);
// The browser takes over a touch that turns into a vertical scroll.
boardEl.addEventListener('pointercancel', endDrag);

boardEl.addEventListener(
  'click',
  (event) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.stopPropagation();
    event.preventDefault();
  },
  true,
);

resetAngleButton.addEventListener('click', () => {
  settings.spin = DEFAULTS.spin;
  saveSettings();
  sounds.click();
  applyCamera();
});

// ---- Rules banner ----

// The Rules button opens a short rules banner, which closes on a tap or after a while.
const RULES_BANNER_MS = 8000;
let rulesTimer: ReturnType<typeof setTimeout> | undefined;

function setRulesBanner(open: boolean): void {
  clearTimeout(rulesTimer);
  rulesBanner.hidden = !open;
  rulesButton.setAttribute('aria-expanded', String(open));
  if (open) rulesTimer = setTimeout(() => setRulesBanner(false), RULES_BANNER_MS);
}

rulesButton.addEventListener('click', () => {
  sounds.click();
  setRulesBanner(rulesBanner.hidden !== false);
});
rulesBanner.addEventListener('click', () => setRulesBanner(false));

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
  if (!(error instanceof OnlineError) && !(error instanceof SessionError)) throw error;
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

// The refusal flash ends by itself. Removing the class lets the next refusal play it again.
for (const button of cells) {
  button.addEventListener('animationend', (event) => {
    if (event.animationName === 'reject') button.classList.remove('shake');
  });
}

// The player at this screen, if there is exactly one.
function me(): Player | null {
  if (session === undefined || session.mode === 'friend') return null;
  return session.you;
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
  if (session !== undefined) void recordResult(session, game, index);
  if (session?.mode === 'computer' && winner !== null && mine !== null && winner !== mine) noteSurvival(session, game, index);
  setTimeout(() => {
    // Show the card only if that game is still the finished live game and nothing else is open.
    if (games.length - 1 !== index || isLive() || review !== undefined || cardDialog.open) return;
    void openCard(index);
  }, CARD_DELAY_MS);
}

// The confetti animation lasts 1.4 s after a delay of up to 0.12 s.
const CONFETTI_MS = 1600;
let confettiTimer: ReturnType<typeof setTimeout> | undefined;

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
  // Spent sparks would stay in the page, invisible, so remove them.
  clearTimeout(confettiTimer);
  confettiTimer = setTimeout(() => burstEl.replaceChildren(), CONFETTI_MS);
}

// ---- Sessions ----

// Every mode plays a session through a backend with the same calls: the server for online
// games, this device for computer and friend games, the host's device for Nearby games.
type SessionBackend = {
  load(code: Code): Promise<SessionView>;
  join(code: Code): Promise<SessionView>;
  move(code: Code, request: MoveRequest): Promise<SessionView>;
  newGame(code: Code): Promise<SessionView>;
  update(code: Code, changes: SessionUpdate): Promise<SessionView>;
  lock(code: Code): Promise<SessionView>;
  chat(code: Code, text: string): Promise<SessionView>;
  subscribe(code: Code, onChange: () => void): () => void;
};

const isComputerTurn = () =>
  session?.mode === 'computer' && session.you !== null && isLive() && current().turn !== session.you;

function humanMove(cell: number): void {
  if (review) return reject(cell, 'reviewing');
  void playMove(cell);
}

async function playMove(cell: number): Promise<void> {
  if (session === undefined) return reject(cell, 'no-session');
  if (session.you === null) return reject(cell, 'spectator');
  const waitReason = session.mode === 'computer' ? 'wait' : 'not-your-turn';
  if (busy || thinking) return reject(cell, waitReason);
  const game = current();
  const result = play(game, cell, nowMs());
  if (!result.ok) return reject(cell, result.error);
  // In a friend game this device plays both seats.
  if (session.mode !== 'friend' && game.turn !== session.you) return reject(cell, waitReason);
  const { code, backend } = session;
  const request = { game: games.length - 1, moveCount: game.moves.length, cell };
  // Show the move at once. The answer replaces it, or a refresh undoes it on an error.
  setCurrent(result.game);
  announce(result.game);
  await withBusy(async () => {
    try {
      applyView(await backend.move(code, request));
    } catch (error) {
      await refresh(code);
      throw error;
    }
  });
  scheduleComputer();
}

function scheduleComputer(): void {
  if (!isComputerTurn() || session === undefined || thinking) return;
  const backend = local;
  if (backend === undefined) throw new Error('a computer game without the device backend');
  thinking = true;
  render();
  const { code } = session;
  const scheduledRound = round;
  setTimeout(() => {
    if (scheduledRound !== round || session?.code !== code || !isComputerTurn()) {
      thinking = false;
      return render();
    }
    // The hard level searches on the main thread for up to 600 ms. CSS animations keep running,
    // but input waits. Move the search to a Web Worker if the budget grows past about one second.
    const game = current();
    const cell = chooseMove(game.board, game.turn, settings.difficulty, Math.random, tuning);
    const request = { game: games.length - 1, moveCount: game.moves.length, cell };
    void (async () => {
      try {
        const view = await backend.computerMove(code, request);
        thinking = false;
        applyView(view);
      } catch (error) {
        showError(error);
      } finally {
        thinking = false;
        render();
      }
    })();
  }, COMPUTER_DELAY_MS);
}

function undoMove(): void {
  const backend = local;
  if (session === undefined || backend === undefined || (session.mode !== 'computer' && session.mode !== 'friend')) return;
  if (thinking || review || !isLive() || current().moves.length === 0) return;
  // Undo would hand back time that the clock already counted, so a timed game has no undo.
  if (hasLimit(current().clock)) return;
  if (settingsLocked()) return reject(undefined, 'locked');
  // Against the computer, go back to the last position where it was the human's turn.
  const count = session.mode === 'computer' && current().turn === session.you && current().moves.length >= 2 ? 2 : 1;
  round++;
  const { code } = session;
  sounds.click();
  void withBusy(async () => applyView(await backend.undo(code, count))).then(scheduleComputer);
}

function setUrlCode(code: Code | undefined): void {
  const url = new URL(location.href);
  if (code === undefined) url.searchParams.delete('code');
  else url.searchParams.set('code', code);
  history.replaceState(null, '', url);
}

function applyView(view: SessionView): void {
  // A late answer for a session that is closed now changes nothing.
  if (session === undefined || session.code !== view.code) return;
  if (view.version < session.version) return; // an older answer arrived late
  const before = current();
  const beforeCount = games.length;
  games = view.games.map(toGame);
  serverOffset = view.now - Date.now();
  const previous = session;
  session = { ...view, backend: session.backend, mode: session.mode, unsubscribe: session.unsubscribe };
  const after = current();
  // Changes by the other player get a message. On one device, the player made them.
  if (shared()) {
    if (!sameClock(session.clock, previous.clock)) {
      const startsLater = after.status.kind === 'playing' && after.moves.length > 0;
      showToast(`Time limit${startsLater ? ' for the next game' : ''}: ${describeClock(session.clock)}.`);
    }
    if (session.locked && !previous.locked) showToast('Settings are locked for both players until this game ends.');
    for (const [option, label] of [['hideBoard', 'Hide board'], ['hideHistory', 'Hide history']] as const) {
      if (session.options[option] !== previous.options[option]) {
        showToast(`${label} is ${session.options[option] ? 'on' : 'off'} for both players.`);
      }
    }
  }
  // A move that is not on screen yet came from the other player or the computer. Our own moves were announced already.
  const isNewMove =
    games.length === beforeCount &&
    after.moves.length === before.moves.length + 1 &&
    before.moves.every((cell, i) => after.moves[i] === cell);
  const timedOutNow = games.length === beforeCount && before.status.kind === 'playing' && after.status.kind === 'timeout';
  if (isNewMove) announce(after);
  else if (timedOutNow) finish(after);
  const lastSeen = previous.chat.at(-1)?.id ?? -1;
  const incoming = session.chat.filter((message) => message.id > lastSeen && message.from !== session?.you);
  const newest = incoming.at(-1);
  if (newest !== undefined && shared()) {
    sounds.message();
    notifyChat(newest, incoming.length);
  }
  if (review && review.game >= games.length) review = undefined;
  if (session.mode === 'online') void deviceDb?.put('remote', { code: session.code, view, savedAt: Date.now() });
  render();
}

function openSession(view: SessionView, backend: SessionBackend, mode: Mode): void {
  session?.unsubscribe();
  round++; // drops a computer move scheduled for the previous session
  thinking = false;
  if (settings.mode !== mode) {
    settings.mode = mode;
    saveSettings();
  }
  review = undefined;
  burstEl.replaceChildren();
  session = { ...view, backend, mode, unsubscribe: () => undefined };
  games = view.games.map(toGame);
  serverOffset = view.now - Date.now();
  const code = view.code;
  session.unsubscribe = backend.subscribe(code, () => void refresh(code));
  setUrlCode(mode === 'online' ? code : undefined);
  if (mode === 'online') void deviceDb?.put('remote', { code, view, savedAt: Date.now() });
  render();
  scheduleComputer();
}

function leaveSession(): void {
  session?.unsubscribe();
  session = undefined;
  games = [newGame('X', settings.clock)];
  setUrlCode(undefined);
}

async function refresh(code: Code): Promise<void> {
  const open = session;
  if (open === undefined || open.code !== code) return;
  try {
    applyView(await open.backend.load(code));
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

function defaultSessionName(mode: Mode = 'online'): string {
  const day = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const kind = mode === 'computer' ? `${settings.difficulty} computer` : mode === 'friend' ? 'friend' : mode === 'nearby' ? 'nearby game' : 'game';
  return mode === 'online' ? `Game of ${day}` : `${kind[0]?.toUpperCase()}${kind.slice(1)} · ${day}`;
}

// The seat of the player in a computer game: the one the computer does not hold.
const humanSeatOf = (doc: SessionDoc): Player | undefined => (doc.computer ? other(doc.computer.seat) : undefined);

// Opens the newest session on this device for the chosen match-up, or starts one.
async function openLocalSession(mode: 'computer' | 'friend'): Promise<void> {
  const backend = local;
  if (backend === undefined) throw new Error('the device backend is not ready');
  const latest = (await backend.list()).find(
    (entry) =>
      entry.mode === mode &&
      (mode !== 'computer' || (entry.doc.computer?.difficulty === settings.difficulty && humanSeatOf(entry.doc) === settings.human)),
  );
  const view =
    latest !== undefined
      ? await backend.load(latest.code)
      : await backend.create({ mode, name: defaultSessionName(mode), clock: settings.clock, human: settings.human, difficulty: settings.difficulty });
  openSession(view, backend, mode);
}

// Reopens any session on this device, for example from My games.
async function openDeviceSession(code: Code): Promise<void> {
  const backend = local;
  if (backend === undefined) throw new Error('the device backend is not ready');
  const entry = (await backend.list()).find((item) => item.code === code);
  if (entry === undefined || entry.mode === 'nearby') return showProblem('That game is not on this device any more.');
  if (entry.doc.computer) {
    settings.difficulty = entry.doc.computer.difficulty;
    settings.human = humanSeatOf(entry.doc) ?? settings.human;
    saveSettings();
  }
  openSession(await backend.load(code), backend, entry.mode);
}

const createSession = () =>
  withBusy(async () => {
    if (!navigator.onLine) throw new OnlineError('You are offline. Online games need a connection.');
    openSession(await api.create(defaultSessionName(), settings.clock), api, 'online');
  });

const joinSession = (code: Code) =>
  withBusy(async () => {
    let view: SessionView;
    try {
      view = await api.load(code);
    } catch (error) {
      // Without a network, an online game this device saw before opens read-only.
      const cached = await deviceDb?.get('remote', code);
      if (!(error instanceof OnlineError) || cached === undefined) throw error;
      openSession(cached.view, api, 'online');
      showToast('You are offline. This is the game as you last saw it.');
      return;
    }
    if (view.you === null && (!view.seats.X || !view.seats.O)) view = await api.join(code);
    openSession(view, api, 'online');
    sounds.click();
    showToast(view.you === null ? 'Both seats are taken. You are watching.' : `Joined ${view.name} as ${view.you}.`);
  });

// ---- Nearby ----

type NearbyState =
  | { kind: 'idle' }
  // Hosting: the open session is this device's, guests connect over WebRTC.
  | { kind: 'hosting'; host: NearbyHost; invite?: { accept(code: string): Promise<{ channel: Channel; peer: Hello }> } }
  // Joining: waiting for the host's code, then showing our answer until the host connects.
  | { kind: 'joining'; answer?: string }
  | { kind: 'guest'; guest: NearbyGuest; hostHello: Hello };

let nearby: NearbyState = { kind: 'idle' };
let wakeLock: { release(): Promise<void> } | undefined;
const thisDevice = detectDevice();

function nearbyHello(): Hello {
  const name = nearbyNameInput.value.trim() || account.user?.login || deviceLabel(thisDevice);
  return { device: thisDevice, name: name.slice(0, 24) };
}

function deviceItem(hello: Hello | { device: 'server'; name: string }, role: string): HTMLLIElement {
  const item = document.createElement('li');
  const icon = document.createElement('span');
  icon.className = 'device-icon';
  icon.innerHTML = DEVICE_ICONS[hello.device];
  icon.title = deviceLabel(hello.device);
  const name = document.createElement('b');
  name.textContent = hello.name;
  const what = document.createElement('small');
  what.textContent = role;
  item.append(icon, name, what);
  return item;
}

function seatRole(seat: Player | null): string {
  return seat === null ? 'Watching' : `Plays ${seat}`;
}

async function renderNearby(): Promise<void> {
  const state = nearby;
  nearbyStart.hidden = state.kind !== 'idle';
  nearbyActions.hidden = state.kind !== 'hosting' && state.kind !== 'guest';
  nearbyAdd.hidden = state.kind !== 'hosting';
  nearbyStop.textContent = state.kind === 'guest' ? 'Leave' : 'End';
  nearbyDeviceIcon.innerHTML = DEVICE_ICONS[thisDevice];
  if (state.kind === 'hosting') {
    const hostSeat = session?.you ?? 'X';
    const guests = await state.host.guests();
    nearbyDevices.replaceChildren(
      deviceItem(nearbyHello(), `You · host · plays ${hostSeat}`),
      ...guests.map((guest) => deviceItem(guest.hello, seatRole(guest.seat))),
    );
  } else if (state.kind === 'guest') {
    nearbyDevices.replaceChildren(
      deviceItem(state.hostHello, 'Host'),
      deviceItem(nearbyHello(), `You · ${seatRole(session?.you ?? null).toLowerCase()}`),
    );
  } else nearbyDevices.replaceChildren();
  nearbyDevices.hidden = nearbyDevices.childElementCount === 0;
}

// A Nearby code as a link to this site. A phone's normal camera app opens it: an invite opens
// Nearby and joins, and an answer reaches the hosting tab in the same browser (see nearbyLinkCode).
const nearbyLink = (code: string) => `${location.origin}/?nearby=${encodeURIComponent(code)}`;

// Takes a bare code, or a link that carries one, and returns the bare code.
function nearbyCodeOf(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('http')) return trimmed;
  try {
    return new URL(trimmed).searchParams.get('nearby') ?? trimmed;
  } catch {
    return trimmed;
  }
}

function showNearbyStep(text: string, options: { code?: string; input?: boolean } = {}): void {
  nearbyStep.hidden = false;
  nearbyStepText.textContent = text;
  nearbyQr.hidden = options.code === undefined;
  nearbyText.hidden = options.code === undefined;
  nearbyCodeOut.value = options.code ?? '';
  nearbyInput.hidden = !options.input;
  nearbyCodeIn.value = '';
  if (options.code !== undefined) {
    const code = options.code;
    // The QR code holds a link, the text box the bare code. Both work in either place.
    void renderQr(nearbyLink(code)).then((svg) => {
      if (nearbyCodeOut.value === code) nearbyQr.replaceChildren(svg);
    });
  } else nearbyQr.replaceChildren();
}

function hideNearbyStep(): void {
  nearbyStep.hidden = true;
}

// Runs a code from the text box, or from a link that a camera opened, through the current step.
let onNearbyCode: ((code: string) => Promise<void>) | undefined;

async function useNearbyCode(code: string): Promise<void> {
  const handler = onNearbyCode;
  if (handler === undefined) return;
  try {
    await handler(nearbyCodeOf(code));
  } catch (error) {
    showProblem(error instanceof Error ? error.message : 'That code did not work.');
  }
}

// The host shows an invite, scans or reads the guest's answer, and connects.
async function inviteGuest(): Promise<void> {
  if (nearby.kind !== 'hosting') return;
  const state = nearby;
  const invite = await createOffer(nearbyHello());
  nearby = { ...state, invite };
  showNearbyStep('1. Scan this code with the other device\'s camera. 2. Then scan the code that device shows with this device\'s camera, or paste it below.', {
    code: invite.code,
    input: true,
  });
  onNearbyCode = async (code) => {
    const { channel, peer } = await invite.accept(code);
    state.host.addGuest(channel, peer);
    onNearbyCode = undefined;
    hideNearbyStep();
    sounds.sent();
    showToast(`${peer.name} joined.`);
    void renderNearby();
  };
}

async function hostNearby(): Promise<void> {
  const backend = local;
  if (backend === undefined) throw new Error('the device backend is not ready');
  const view = await backend.create({ mode: 'nearby', name: defaultSessionName('nearby'), clock: settings.clock, human: 'X' });
  openSession(view, backend, 'nearby');
  const host = createNearbyHost(backend, view.code, token);
  host.onGuestsChanged(() => void renderNearby());
  nearby = { kind: 'hosting', host };
  // Keep the host's screen on: guests lose the game when the host's page sleeps.
  wakeLock = await navigator.wakeLock?.request('screen').catch(() => undefined);
  await inviteGuest();
  void renderNearby();
}

async function joinNearby(code?: string): Promise<void> {
  nearby = { kind: 'joining' };
  showNearbyStep("Scan the host's code with this device's camera, or paste it below.", { input: true });
  onNearbyCode = async (code) => {
    const answer = await answerOffer(code, nearbyHello());
    nearby = { kind: 'joining', answer: answer.code };
    showNearbyStep(`Show this code to ${answer.peer.name}, the host, to scan.`, { code: answer.code });
    onNearbyCode = undefined;
    const channel = await answer.connected;
    const guest = createNearbyGuest(channel, token, (reason) => {
      if (nearby.kind !== 'guest' || nearby.guest !== guest) return;
      showToast(reason);
      endNearby(false);
    });
    nearby = { kind: 'guest', guest, hostHello: answer.peer };
    hideNearbyStep();
    let view = await guest.load('' as Code);
    if (view.you === null && (!view.seats.X || !view.seats.O)) view = await guest.join(view.code);
    openSession(view, guest, 'nearby');
    sounds.sent();
    showToast(view.you === null ? 'Both seats are taken. You are watching.' : `Joined the game hosted on ${answer.peer.name} as ${view.you}.`);
    void renderNearby();
  };
  if (code !== undefined) await useNearbyCode(code);
}

// Answer codes scanned with a normal camera open a new tab. That tab hands the code to the
// hosting tab of the same browser over this channel, so the host never copies anything.
const nearbyHandoff = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('tick3d-nearby');
nearbyHandoff?.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (nearby.kind === 'hosting' && onNearbyCode !== undefined && typeof event.data === 'string') {
    void useNearbyCode(event.data);
  }
});

// Handles a page opened from a Nearby QR code: an invite joins, an answer goes to the hosting tab.
async function openNearbyLink(code: string): Promise<void> {
  const url = new URL(location.href);
  url.searchParams.delete('nearby');
  history.replaceState(null, '', url);
  settings.mode = 'nearby';
  saveSettings();
  openNearby();
  if ((await decodeSignal(code).catch(() => undefined))?.kind === 'answer') {
    nearbyHandoff?.postMessage(code);
    showNearbyStep('The code went to the tab that hosts the game. You can close this tab.');
    return;
  }
  await joinNearby(code);
}

// Leaves Nearby play. The host says goodbye to its guests; a guest closes its connection.
function endNearby(sayBye = true): void {
  const state = nearby;
  if (state.kind === 'hosting') state.host.stop('The host ended the game.');
  if (state.kind === 'guest' && sayBye) state.guest.close();
  void wakeLock?.release().catch(() => undefined);
  wakeLock = undefined;
  onNearbyCode = undefined;
  hideNearbyStep();
  nearby = { kind: 'idle' };
  if (session?.mode === 'nearby') leaveSession();
  render();
  void renderNearby();
}

// Opens the Nearby panel. A session starts when this device hosts or joins.
function openNearby(): void {
  if (nearbyNameInput.value === '') nearbyNameInput.value = account.user?.login ?? deviceLabel(thisDevice);
  render();
  void renderNearby();
}

nearbyHostButton.addEventListener('click', () => {
  sounds.click();
  void hostNearby().catch((error: unknown) => {
    showProblem(error instanceof Error ? error.message : 'Could not start hosting.');
    endNearby();
  });
});
nearbyJoinButton.addEventListener('click', () => {
  sounds.click();
  void joinNearby().catch((error: unknown) => showProblem(error instanceof Error ? error.message : 'Could not join.'));
});
nearbyAdd.addEventListener('click', () => void inviteGuest().catch(showError));
nearbyStop.addEventListener('click', () => endNearby());
nearbyCancel.addEventListener('click', () => {
  hideNearbyStep();
  onNearbyCode = undefined;
  if (nearby.kind === 'joining') nearby = { kind: 'idle' };
  void renderNearby();
});
nearbyUseCode.addEventListener('click', () => void useNearbyCode(nearbyCodeIn.value));
nearbyCopy.addEventListener('click', () => {
  void navigator.clipboard.writeText(nearbyCodeOut.value).then(
    () => showToast('Code copied.'),
    () => showProblem('Copy did not work. Select the code and copy it.'),
  );
});

// ---- Account and My games ----

function renderAccount(): void {
  const user = account.user;
  accountAvatar.hidden = user === null;
  if (user !== null) accountAvatar.src = `${user.avatar}&s=48`;
  accountName.textContent = user?.login ?? 'My games';
}

function tallyBox(label: string, tally: Tally): HTMLElement {
  const box = document.createElement('div');
  box.className = 'my-tally';
  const title = document.createElement('b');
  title.textContent = label;
  const numbers = document.createElement('span');
  numbers.textContent =
    tally.won + tally.lost + tally.drawn === 0 && tally.played > 0
      ? `${tally.played} played`
      : `${tally.won} won · ${tally.lost} lost · ${tally.drawn} drawn`;
  box.append(title, numbers);
  return box;
}

function listItem(title: string, detail: string, action: string, onClick: () => void, badge?: string): HTMLLIElement {
  const item = document.createElement('li');
  const text = document.createElement('div');
  const name = document.createElement('b');
  name.textContent = title;
  const small = document.createElement('small');
  small.textContent = detail;
  text.append(name, small);
  item.append(text);
  if (badge) {
    const mark = document.createElement('span');
    mark.className = 'badge';
    mark.textContent = badge;
    item.append(mark);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = action;
  button.addEventListener('click', () => {
    myGamesDialog.close();
    onClick();
  });
  item.append(button);
  return item;
}

const ago = (time: number) => new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// Stats from the results on this device, for when the server is out of reach.
async function deviceTallies(): Promise<Tally> {
  const tally: Tally = { played: 0, won: 0, lost: 0, drawn: 0 };
  for (const { upload } of (await deviceDb?.all('results')) ?? []) {
    tally.played++;
    if (upload.you === null) continue;
    const winner = winnerOf(toGame(upload.game).status);
    tally[winner === null ? 'drawn' : winner === upload.you ? 'won' : 'lost']++;
  }
  return tally;
}

const gameCount = (count: number) => `${count} ${count === 1 ? 'game' : 'games'}`;

async function openMyGames(): Promise<void> {
  myGamesDialog.showModal();
  // Account
  accountBox.replaceChildren();
  if (account.user) {
    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.src = `${account.user.avatar}&s=64`;
    avatar.alt = '';
    const name = document.createElement('b');
    name.textContent = account.user.login;
    const logout = document.createElement('button');
    logout.type = 'button';
    logout.textContent = 'Log out';
    logout.addEventListener('click', () => void api.logout().then(refreshAccount).then(() => myGamesDialog.close(), showError));
    accountBox.append(avatar, name, logout);
  } else if (account.loginAvailable && navigator.onLine) {
    const text = document.createElement('span');
    text.textContent = 'Log in to keep your games and stats on every device.';
    const login = document.createElement('a');
    login.className = 'login-link';
    login.href = api.loginUrl();
    login.textContent = 'Log in with GitHub';
    accountBox.append(text, login);
  }
  // Device sessions
  const deviceSessions = (await local?.list()) ?? [];
  myGamesDevice.replaceChildren(
    ...deviceSessions
      .filter((entry) => entry.mode !== 'nearby')
      .map((entry) =>
        listItem(entry.name, `${entry.mode === 'computer' ? 'Computer' : 'Friend'} · ${gameCount(entry.games)} · ${ago(entry.updatedAt)}`, 'Open', () => {
          void openDeviceSession(entry.code).catch(showError);
        }),
      ),
  );
  if (myGamesDevice.childElementCount === 0) myGamesDevice.innerHTML = '<li class="empty">No games on this device yet.</li>';
  // Server stats and online sessions
  myGamesStats.replaceChildren();
  myGamesOnline.replaceChildren();
  try {
    if (!navigator.onLine) throw new OnlineError('offline');
    const mine = await api.myGames();
    myGamesNote.textContent = mine.user ? 'Your games on every device you logged in with.' : 'Your games on this browser.';
    myGamesStats.append(
      tallyBox('All games', mine.total),
      tallyBox('Online', mine.byMode.online),
      tallyBox('Computer', mine.byMode.computer),
      tallyBox('Nearby', mine.byMode.nearby),
      tallyBox('Friend', mine.byMode.friend),
    );
    myGamesOnline.append(
      ...mine.sessions.map((summary) =>
        listItem(
          summary.name,
          `vs ${summary.opponent?.login ?? 'Opponent'} · ${gameCount(summary.games)} · ${ago(summary.updatedAt)}`,
          'Continue',
          () => void joinSession(summary.code),
          summary.yourTurn ? 'Your turn' : undefined,
        ),
      ),
    );
    if (mine.sessions.length === 0) myGamesOnline.innerHTML = '<li class="empty">No online sessions yet.</li>';
    myGamesOnlineBox.hidden = false;
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
    myGamesNote.textContent = 'You are offline. These are the games on this device.';
    myGamesStats.append(tallyBox('Games on this device', await deviceTallies()));
    myGamesOnlineBox.hidden = true;
  }
}

accountButton.addEventListener('click', () => void openMyGames().catch(showError));
myGamesClose.addEventListener('click', () => myGamesDialog.close());
myGamesDialog.addEventListener('click', (event) => {
  if (event.target === myGamesDialog) myGamesDialog.close();
});

// ---- Offline and updates ----

setupPwa({
  onOfflineReady() {
    offlineBadge.hidden = false;
    showToast('Ready for offline play. Computer and friend games work without a network now.');
  },
  onNeedRefresh(reload) {
    updateBar.hidden = false;
    updateReload.disabled = false;
    updateReload.textContent = 'Reload';
    updateReload.onclick = () => {
      // Feedback at once: the new version can take a moment to take over.
      updateReload.disabled = true;
      updateReload.textContent = 'Updating…';
      void reload();
    };
  },
});
// A worker that is already active means this device had the game ready offline before.
void navigator.serviceWorker?.getRegistration().then((registration) => {
  if (registration?.active) offlineBadge.hidden = false;
});

// A LAN host (a laptop that runs the server for the local network) says so in the online box.
async function checkLanHost(): Promise<void> {
  try {
    const response = await fetch('/api/health');
    const body: unknown = await response.json();
    const lan = typeof body === 'object' && body !== null && 'lan' in body ? body.lan : null;
    if (typeof lan === 'object' && lan !== null && 'name' in lan && typeof lan.name === 'string') {
      lanHost.hidden = false;
      lanHost.replaceChildren();
      const icon = document.createElement('span');
      icon.className = 'device-icon';
      icon.innerHTML = DEVICE_ICONS.server;
      const text = document.createElement('span');
      text.textContent = `Hosted on ${lan.name} on this network`;
      lanHost.append(icon, text);
    }
  } catch {
    // No server answers (offline, or a static preview). The online box stays as it is.
  }
}

// ---- Results of games away from the server ----

let flushing = false;

// Keeps a finished computer, friend or Nearby game for upload. Online games are on the server already.
async function recordResult(open: Session, game: Game, index: number): Promise<void> {
  if (deviceDb === undefined || open.mode === 'online') return;
  const you = open.mode === 'friend' ? null : open.you;
  // A Nearby watcher played no part, so it has no result of its own.
  if (open.mode !== 'friend' && you === null) return;
  const upload: ResultUpload = {
    // One id per device, session and game, so a result that is sent twice is stored once.
    id: `${token}-${open.code.toLowerCase()}-${index}`,
    mode: open.mode,
    game: toRecord(game),
    you,
    difficulty: open.mode === 'computer' ? settings.difficulty : null,
    finishedAt: game.times.at(-1) ?? Date.now(),
  };
  if ((await deviceDb.get('results', upload.id)) === undefined) {
    await deviceDb.put('results', { id: upload.id, upload, sent: false });
  }
  await flushResults();
}

// Sends every result that is waiting, when the network is up. A failure leaves them for the next try.
async function flushResults(): Promise<void> {
  if (flushing || deviceDb === undefined || !navigator.onLine) return;
  flushing = true;
  try {
    const waiting = (await deviceDb.all('results')).filter((result) => !result.sent);
    if (waiting.length === 0) return;
    await api.uploadResults(waiting.map((result) => result.upload));
    for (const result of waiting) await deviceDb.put('results', { ...result, sent: true });
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
    // The server is out of reach. The results wait for the next finished game or reconnect.
  } finally {
    flushing = false;
  }
}

async function shareLink(): Promise<void> {
  if (session?.mode !== 'online') return;
  const url = location.href;
  const text = `Play 3D tic-tac-toe with me on tick3d. Code ${session.code}.`;
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

// "You", "Computer", the GitHub name of a logged-in player, or the seat.
function playerName(player: Player): string {
  const mine = me();
  if (session === undefined || session.mode === 'friend') return `Player ${player}`;
  if (player === mine) return 'You';
  if (session.mode === 'computer') return 'Computer';
  return session.players[player]?.login ?? (mine === null ? `Player ${player}` : 'Opponent');
}

// The other player in a game with another device, when they took a seat but closed the game.
function awayPlayer(): Player | undefined {
  if (session === undefined || !shared() || session.you === null) return undefined;
  const opponent = other(session.you);
  return session.seats[opponent] && !session.presence[opponent] ? opponent : undefined;
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
  if (settings.mode === 'online' && session === undefined) {
    return navigator.onLine ? 'Create a game or enter a code' : 'You are offline. Online games need a connection.';
  }
  if (session === undefined) return 'Getting the game ready…';
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
      if (shared()) {
        if (session.you === null) return `Watching · ${game.turn} to move`;
        const opponent = other(session.you);
        if (!session.seats[opponent]) {
          return session.mode === 'online' ? 'Waiting for a second player. Share the code.' : 'Waiting for a second device to join.';
        }
        // An async game goes on while a player is away: a move waits for them.
        const away = awayPlayer() !== undefined;
        if (game.turn === session.you) return away ? `Your move (${game.turn}) · ${playerName(opponent)} is away and sees it later` : `Your move (${game.turn})`;
        return away ? `${playerName(opponent)} is away · the game waits for their move` : `${playerName(opponent)}'s move (${game.turn})`;
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
  applyCamera();
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
    const piece = marks[cell];
    if (piece) {
      piece.classList.toggle('x', mark === 'X');
      piece.classList.toggle('o', mark === 'O');
      piece.classList.toggle('win', winLine.includes(cell));
    }
    button.setAttribute('aria-label', `Layer ${layer + 1}, row ${row + 1}, column ${column + 1}: ${mark ?? 'empty'}`);
  });

  statusEl.textContent = statusText();
  statusEl.dataset.state = review ? 'review' : current().status.kind;

  reviewEl.hidden = review === undefined;
  if (review) reviewLabel.textContent = statusText();
  coordsForm.hidden = review !== undefined;
  renderCoords();
  renderChat();

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
  const onlineSession = session?.mode === 'online' ? session : undefined;
  onlineCodeEl.textContent = onlineSession?.code ?? '····';
  shareButton.disabled = onlineSession === undefined;
  shareQrButton.disabled = onlineSession === undefined;
  renderOnlineQr(onlineSession?.code);
  if (document.activeElement !== sessionNameInput) sessionNameInput.value = onlineSession?.name ?? '';
  sessionNameInput.disabled = onlineSession?.you == null || busy;
  joinCodeInput.disabled = frozen || busy;
  newCodeButton.disabled = frozen || busy;

  // Score: finished games of this session only.
  const score = { X: 0, O: 0, draw: 0 };
  for (const g of games) {
    const winner = winnerOf(g.status);
    if (winner !== null) score[winner]++;
    if (g.status.kind === 'draw') score.draw++;
  }
  const away = awayPlayer();
  scoreEl.replaceChildren(
    ...([
      ['X', playerName('X'), score.X],
      ['draw', 'Draws', score.draw],
      ['O', playerName('O'), score.O],
    ] as const).map(([key, label, value]) => {
      const tally = document.createElement('div');
      tally.className = `tally ${key}`;
      tally.classList.toggle('away', key === away);
      const count = document.createElement('b');
      count.textContent = String(value);
      const name = document.createElement('span');
      const info = key === 'draw' || session === undefined ? null : session.players[key];
      if (info) {
        const avatar = document.createElement('img');
        avatar.src = `${info.avatar}&s=48`;
        avatar.alt = '';
        avatar.className = 'avatar';
        name.append(avatar);
      }
      name.append(key === away ? `${label} · away` : label);
      tally.append(count, name);
      return tally;
    }),
  );

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

  // With another device, a game must end before the next one starts.
  const sharedLive = shared() && isLive() && current().moves.length > 0;
  newGameButton.disabled = frozen || busy || thinking || session?.you == null || sharedLive;
  advancedBox.hidden = settings.mode !== 'computer';
  for (const input of tuningEl.querySelectorAll('input')) input.disabled = frozen;
  undoButton.hidden = shared() || settings.mode === 'online' || settings.mode === 'nearby';
  undoButton.disabled =
    frozen || thinking || review !== undefined || !isLive() || current().moves.length === 0 || hasLimit(current().clock);
  showCardButton.hidden = isLive() || review !== undefined;
  renderClockEditor(frozen);
  renderClocks();
  lockButton.disabled = frozen || busy || !isLive() || review !== undefined || !canChangeMatch();
  const lockScope = shared() ? ' for both players' : '';
  lockButton.textContent = frozen ? '🔒 Locked' : '🔓 Lock';
  lockButton.title = frozen ? `Settings are locked${lockScope} until this game ends.` : `Lock every setting${lockScope} until this game ends.`;
  lockButton.setAttribute('aria-pressed', String(frozen));
  renderAccount();
  soundButton.innerHTML = settings.muted ? SOUND_OFF_ICON : SOUND_ON_ICON;
  soundButton.setAttribute('aria-pressed', String(!settings.muted));
}

// ---- Clock ----

function renderClocks(): void {
  const game = current();
  const left = remaining(game, nowMs());
  clocksEl.hidden = left === null || review !== undefined || session === undefined;
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
    // The holder of the session (server, device or Nearby host) records the timeout when it
    // reads the session, so a refresh is enough in every mode.
    if (session !== undefined && now - lastFlagRefresh > 1000) {
      lastFlagRefresh = now;
      void refresh(session.code);
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
  if (session === undefined) return render();
  if (session.you === null) {
    render();
    return reject(undefined, 'spectator');
  }
  const { code, backend } = session;
  // A game keeps the limit it started with, so a change during a game starts with the next one.
  if (!shared() && isLive() && current().moves.length > 0) showToast('The new time limit starts with the next game.');
  // Show the change at once, as with moves. The answer replaces it, or a refresh undoes it on an error.
  session = { ...session, clock };
  render();
  void withBusy(async () => {
    try {
      applyView(await backend.update(code, { clock }));
    } catch (error) {
      await refresh(code);
      throw error;
    }
  });
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

// ---- Advanced settings of the computer ----

const TUNING_KEY = 'tick3d.tuning';

function loadTuning(): Tuning {
  try {
    return parseTuning(JSON.parse(localStorage.getItem(TUNING_KEY) ?? 'null'));
  } catch {
    return DEFAULT_TUNING;
  }
}

let tuning = loadTuning();

function saveTuning(next: Tuning): void {
  tuning = next;
  try {
    if (isDefaultTuning(next)) localStorage.removeItem(TUNING_KEY);
    else localStorage.setItem(TUNING_KEY, JSON.stringify(next));
  } catch {
    // Storage is blocked (private mode). The settings then last for this visit only.
  }
}

// One box per level, one number per field. A change applies from the computer's next move.
function buildTuning(): void {
  const groups = new Map<string, HTMLFieldSetElement>();
  for (const field of TUNING_FIELDS) {
    let group = groups.get(field.group);
    if (group === undefined) {
      group = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = field.group;
      group.append(legend);
      groups.set(field.group, group);
    }
    const label = document.createElement('label');
    const input = document.createElement('input');
    Object.assign(input, { type: 'number', min: String(field.min), max: String(field.max), step: String(field.step) });
    input.value = String(field.get(tuning));
    input.addEventListener('change', () => {
      const value = fieldValue(field, input.valueAsNumber);
      if (value === undefined) showToast(`${field.label}: use a number from ${field.min} to ${field.max}.`);
      else saveTuning(field.set(tuning, value));
      input.value = String(field.get(tuning));
    });
    label.append(field.label, input);
    group.append(label);
  }
  tuningEl.replaceChildren(...groups.values());
}

tuningReset.addEventListener('click', () => {
  if (settingsLocked()) return reject(undefined, 'locked');
  saveTuning(DEFAULT_TUNING);
  buildTuning();
  render();
  showToast('The computer plays with the default settings again.');
});

buildTuning();

// ---- Survival records ----

const RECORDS_KEY = 'tick3d.records';
// Records that a game broke in this visit, by session code and game index, for its end card.
const recordNews = new Map<string, RecordNews>();

// Records stay on this device, like the settings. Move them to the account when players
// ask to keep their records across devices.
function loadRecords(): Records {
  try {
    return parseRecords(JSON.parse(localStorage.getItem(RECORDS_KEY) ?? 'null'));
  } catch {
    return {};
  }
}

// A game that the computer won: the moves it lasted can beat the record of its setup.
// The hide options count as they are at the end of the game.
function noteSurvival(open: Session, game: Game, index: number): void {
  const { hideBoard, hideHistory } = open.options;
  const { records, news } = addLoss(loadRecords(), { difficulty: settings.difficulty, clock: game.clock, hideBoard, hideHistory, tuned: !isDefaultTuning(tuning) }, game.moves.length);
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
  } catch {
    // Storage is blocked (private mode). Records then last for this visit only.
  }
  if (news === undefined) return;
  recordNews.set(`${open.code}:${index}`, news);
  showToast(`New record: you lasted ${news.moves} moves. Your best was ${news.previous}.`);
}

function hideLabel({ hideBoard, hideHistory }: MatchOptions): string | undefined {
  if (hideBoard && hideHistory) return 'Board and history hidden';
  if (hideBoard) return 'Board hidden';
  if (hideHistory) return 'History hidden';
  return undefined;
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
  const level = `${settings.difficulty.charAt(0).toUpperCase()}${settings.difficulty.slice(1)}${isDefaultTuning(tuning) ? '' : ' (tuned)'}`;
  const matchup =
    session?.mode === 'computer'
      ? `vs Computer · ${level} · You played ${session.you ?? settings.human}`
      : session?.mode === 'online'
        ? `Online · ${session.name}`
        : session?.mode === 'nearby'
          ? `Nearby · ${session.name}`
          : 'Two players, one screen';
  const first = game.times[0] ?? 0;
  const last = game.times.at(-1) ?? 0;
  const duration = first > 0 && last > first ? ` · Game time ${formatClock(last - first)}` : '';
  const onlineCode = session?.mode === 'online' ? session.code : undefined;
  const news = session === undefined ? undefined : recordNews.get(`${session.code}:${index}`);
  const link = onlineCode ? `${location.host}/?code=${onlineCode}` : location.host;
  return {
    game,
    title,
    subtitle,
    matchup,
    details: [`Game ${index + 1}`, describeClock(game.clock), hideLabel(matchOptions())].filter((part) => part !== undefined).join(' · ') + duration,
    date: new Date(last > 0 ? last - serverOffset : Date.now()),
    footer: [onlineCode && cardCode.checked ? `Code ${onlineCode}` : '', cardLink.checked ? link : '']
      .filter((part) => part !== '')
      .join(' · '),
    ...(news === undefined ? {} : { record: news }),
  };
}

async function openCard(index: number): Promise<void> {
  const game = games[index];
  if (game === undefined || game.status.kind === 'playing') throw new Error(`game ${index} has no result to show`);
  // A local game has no code, so only the link option applies.
  cardCodeOption.hidden = session?.mode !== 'online';
  const input = cardInput(game, index);
  const canvas = await drawCard(input);
  card = { index, canvas };
  cardImage.src = canvas.toDataURL('image/png');
  cardImage.alt = `${input.title}. ${input.subtitle}.${input.record ? ` New record: ${input.record.moves} moves.` : ''}`;
  // Only the newest game can start the next one. A card of an older game has no New game button.
  cardNewGameButton.hidden = index !== games.length - 1;
  cardNewGameButton.disabled = newGameButton.disabled;
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
  const isOnline = session?.mode === 'online';
  const url = cardLink.checked ? (isOnline ? location.href : location.origin) : undefined;
  const code = cardCode.checked && isOnline && session ? ` Code ${session.code}.` : '';
  void shareImage(canvas, cardFilename(), `${input.title}: ${input.subtitle} on tick3d.${code}`, url).then((outcome) => {
    if (outcome === 'copied') showToast('Image copied. Paste it anywhere.');
    if (outcome === 'saved') showToast('Image saved.');
  });
});

cardSaveButton.addEventListener('click', () => {
  if (card !== undefined) void saveImage(card.canvas, cardFilename());
});
cardCloseButton.addEventListener('click', () => cardDialog.close());
cardNewGameButton.addEventListener('click', () => {
  cardDialog.close();
  startNewGame();
});
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
  if (previousMode === 'nearby' && nearby.kind !== 'idle') endNearby();
  leaveSession();
  review = undefined;
  render();
  if (settings.mode === 'online') {
    if (previousMode !== 'online') void createSession();
    return;
  }
  if (settings.mode === 'nearby') return openNearby();
  // Each match-up continues its newest session on this device, or starts one.
  void openLocalSession(settings.mode).catch(showError);
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
    if (session === undefined) return reject(undefined, 'no-session');
    if (session.you === null) return reject(undefined, 'spectator');
    sounds.click();
    const { code, backend } = session;
    const value = !session.options[toggle];
    const changes = toggle === 'hideBoard' ? { hideBoard: value } : { hideHistory: value };
    void withBusy(async () => applyView(await backend.update(code, changes)));
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

// ---- Chat ----

function renderChat(): void {
  chatEl.hidden = !shared();
  if (session === undefined || !shared()) {
    chatShown = '';
    return;
  }
  const canWrite = session.you !== null;
  chatInput.disabled = !canWrite;
  chatSend.disabled = !canWrite || chatSending;
  chatInput.placeholder = canWrite ? 'Message your opponent' : 'Only the two players can chat';

  const shown = `${session.code}:${session.chat.map((message) => message.id).join(',')}`;
  if (shown === chatShown) return;
  chatShown = shown;
  if (session.chat.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'chat-empty';
    empty.textContent = canWrite ? 'No messages yet. Say hi.' : 'No messages yet.';
    chatLog.replaceChildren(empty);
    return;
  }
  chatLog.replaceChildren(
    ...session.chat.map((message) => {
      const item = document.createElement('li');
      item.className = `chat-message from-${message.from.toLowerCase()}`;
      item.classList.toggle('mine', message.from === session?.you);
      const name = document.createElement('b');
      name.textContent = playerName(message.from);
      const text = document.createElement('span');
      text.dir = 'auto'; // Hebrew and Arabic messages read right to left
      text.textContent = message.text;
      item.append(name, text);
      return item;
    }),
  );
  chatLog.scrollTop = chatLog.scrollHeight;
}

// True when the whole chat box is on screen, so the player sees new messages arrive.
function chatInView(): boolean {
  if (chatEl.hidden || document.hidden) return false;
  const box = chatEl.getBoundingClientRect();
  return box.top >= 0 && box.bottom <= innerHeight;
}

// A bar at the top of the screen with the newest message, unless the chat is already in view.
// In a background tab, the page title also counts unread messages.
function notifyChat(message: ChatMessage, count: number): void {
  if (document.hidden) {
    unread += count;
    document.title = `(${unread}) ${baseTitle}`;
  }
  if (chatInView()) return;
  chatNoticeFrom.textContent = playerName(message.from);
  chatNoticeText.textContent = message.text;
  chatNotice.classList.toggle('from-x', message.from === 'X');
  chatNotice.classList.toggle('from-o', message.from === 'O');
  chatNotice.hidden = false;
  clearTimeout(chatNoticeTimer);
  chatNoticeTimer = setTimeout(hideChatNotice, 6000);
}

function hideChatNotice(): void {
  clearTimeout(chatNoticeTimer);
  chatNotice.hidden = true;
}

chatNotice.addEventListener('click', () => {
  hideChatNotice();
  chatEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (session?.you != null) chatInput.focus({ preventScroll: true });
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  unread = 0;
  document.title = baseTitle;
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (session === undefined || !shared() || chatSending) return;
  if (session.you === null) return reject(undefined, 'spectator');
  const text = normalizeChat(chatInput.value);
  if (text === undefined) {
    sounds.invalid();
    showToast('Type a message first.');
    return;
  }
  const { code, backend } = session;
  chatSending = true;
  render();
  void (async () => {
    try {
      const view = await backend.chat(code, text);
      chatInput.value = '';
      sounds.sent();
      if (session?.code === code) applyView(view);
    } catch (error) {
      showError(error);
    } finally {
      chatSending = false;
      render();
    }
  })();
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

// The game's link as a QR code: a friend's phone camera opens the online game directly.
let onlineQrShown: Code | undefined;
function renderOnlineQr(code: Code | undefined): void {
  const open = shareQrButton.getAttribute('aria-expanded') === 'true' && code !== undefined;
  onlineQr.hidden = !open;
  if (!open || code === onlineQrShown) return;
  onlineQrShown = code;
  onlineQrCaption.textContent = `Scan with a phone camera to join ${code}.`;
  const link = `${location.origin}/?code=${code}`;
  void renderQr(link).then((svg) => {
    if (onlineQrShown === code) onlineQrImage.replaceChildren(svg);
  });
}
shareQrButton.addEventListener('click', () => {
  sounds.click();
  const open = shareQrButton.getAttribute('aria-expanded') !== 'true';
  shareQrButton.setAttribute('aria-expanded', String(open));
  renderOnlineQr(session?.mode === 'online' ? session.code : undefined);
});

sessionNameInput.addEventListener('change', () => {
  if (session === undefined) return;
  const name = normalizeName(sessionNameInput.value);
  if (name === undefined) {
    showProblem('A name needs 1 to 40 characters.');
    sessionNameInput.value = session.name;
    return;
  }
  const { code, backend } = session;
  void withBusy(async () => {
    applyView(await backend.update(code, { name }));
    showToast('Session renamed.');
  });
});

reviewEl.querySelectorAll<HTMLButtonElement>('[data-review]').forEach((button) => {
  button.addEventListener('click', () => stepReview(button.dataset.review));
});

newGameButton.addEventListener('click', startNewGame);

function startNewGame(): void {
  if (settingsLocked()) return reject(undefined, 'locked');
  if (session === undefined) return reject(undefined, 'no-session');
  sounds.click();
  round++; // drops a computer move for the game that ends here
  thinking = false;
  const { code, backend } = session;
  void withBusy(async () => {
    review = undefined;
    burstEl.replaceChildren();
    applyView(await backend.newGame(code));
  }).then(scheduleComputer);
}

undoButton.addEventListener('click', undoMove);

// What a player loses when they go home now, or undefined when there is nothing to lose.
function homeWarning(): string | undefined {
  if (nearby.kind === 'hosting') return 'End the Nearby game for everyone?';
  if (nearby.kind !== 'idle') return 'Leave the Nearby game?';
  if (session?.mode === 'online') return 'Leave this online game? You can open it again from My games.';
  if (session !== undefined && isLive() && current().moves.length > 0) return 'Leave this game? The game in progress ends.';
  return undefined;
}

// Home is the first visit: an empty board against the computer, with no game code in the address.
// The theme, the view and the other settings stay.
async function goHome(): Promise<void> {
  for (const dialog of [cardDialog, myGamesDialog, homeConfirm]) if (dialog.open) dialog.close();
  if (nearby.kind !== 'idle') endNearby();
  leaveSession();
  history.replaceState(null, '', location.pathname);
  review = undefined;
  settings.mode = 'computer';
  saveSettings();
  render();
  await openLocalSession('computer');
  const opened = session;
  if (opened === undefined || current().moves.length === 0) return;
  // The newest computer session holds a game with moves: a new game gives the empty board.
  round++;
  thinking = false;
  burstEl.replaceChildren();
  applyView(await opened.backend.newGame(opened.code));
  scheduleComputer();
}

homeLink.addEventListener('click', (event) => {
  // A modified click opens a new tab, as for any link.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  sounds.click();
  const warning = homeWarning();
  if (warning === undefined) return void goHome().catch(showError);
  homeConfirmText.textContent = warning;
  homeConfirm.showModal();
  homeConfirmStay.focus();
});
homeConfirmLeave.addEventListener('click', () => void goHome().catch(showError));
homeConfirmStay.addEventListener('click', () => homeConfirm.close());
homeConfirm.addEventListener('click', (event) => {
  if (event.target === homeConfirm) homeConfirm.close();
});

lockButton.addEventListener('click', () => {
  if (!isLive() || review || settingsLocked() || session === undefined) return;
  if (session.you === null) return reject(undefined, 'spectator');
  sounds.click();
  const { code, backend } = session;
  void withBusy(async () => applyView(await backend.lock(code)));
});

soundButton.addEventListener('click', () => {
  settings.muted = !settings.muted;
  setMuted(settings.muted);
  saveSettings();
  sounds.click();
  render();
});

// ---- Start ----

// Asks the server who is logged in. Without a network the page keeps the last answer.
async function refreshAccount(): Promise<void> {
  if (!navigator.onLine) return;
  try {
    account = await api.me();
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
  }
  render();
}

async function start(): Promise<void> {
  try {
    deviceDb = await openDeviceDb();
  } catch {
    // The browser blocks storage (some private modes). Games then last for this visit only.
    deviceDb = memoryDeviceDb();
    showToast('This browser does not let the game store data, so games last for this visit only.');
  }
  local = createLocalBackend(deviceDb, token, () => account.user);
  void refreshAccount();
  void checkLanHost();
  const params = new URLSearchParams(location.search);
  if (params.get('login') === 'failed') {
    showProblem('The GitHub login did not work. Try again.');
    const url = new URL(location.href);
    url.searchParams.delete('login');
    history.replaceState(null, '', url);
  }
  void flushResults();
  addEventListener('online', () => {
    void flushResults();
    void refreshAccount();
    if (session?.mode === 'online') void refresh(session.code);
    render();
  });
  addEventListener('offline', () => render());

  const linkCode = new URLSearchParams(location.search).get('code');
  const code = linkCode === null ? undefined : normalizeCode(linkCode);
  if (linkCode !== null && code === undefined) {
    setUrlCode(undefined);
    showToast(`The link code "${linkCode}" is not valid.`);
  }
  if (code !== undefined) {
    await joinSession(code);
    if (session?.code === code) return;
    // The code opened no game (none with that code, or no network), and the error shows already.
    // The address drops the code, so a reload does not repeat the error, and the page starts as usual.
    setUrlCode(undefined);
  }
  const nearbyCode = params.get('nearby');
  if (nearbyCode !== null) return openNearbyLink(nearbyCode);
  if (settings.mode === 'online') return render();
  if (settings.mode === 'nearby') return openNearby();
  await openLocalSession(settings.mode);
}

setMuted(settings.muted);
setInterval(tickClock, 200);
applyTheme();
applyCamera();
render();
void start().catch(showError);
