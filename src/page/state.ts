// The open session and the state that more than one module reads and changes.
import type { TimeControl } from '../clock.ts';
import type { DeviceDb } from '../device-db.ts';
import { type EpochMs, toEpochMs } from '../epoch.ts';
import { type Game, type Player, newGame } from '../game.ts';
import type { LocalBackend } from '../local.ts';
import { nameOf } from '../names.ts';
import { type Me, token } from '../online.ts';
import { parseCustomName } from '../protocol.ts';
import type { SessionView, MatchOptions, Code, MoveRequest, SeatAction, SessionUpdate, PublicGame } from '../protocol.ts';
import { type Mode, settings } from './settings.ts';

// The open session: its latest view, the backend that holds it, and its mode.
export type Session = SessionView & { backend: SessionBackend; mode: Mode; unsubscribe: () => void };

// A past position on the board: the game index and the number of moves shown.
export type Review = { game: number; move: number };

// What the board shows: nothing yet, an open session, or a finished game from its link (/?game=<id>,
// read-only). A switch replaces the whole screen, so the review and the computer search of the old
// screen end with it. Only the functions below change it.
type Screen =
  | { kind: 'empty' }
  // `thinking`: the computer searches its move.
  | { kind: 'session'; session: Session; review: Review | undefined; thinking: boolean }
  | { kind: 'viewing'; game: PublicGame; review: Review | undefined };

let screen: Screen = { kind: 'empty' };

// Async work holds a token from its start, and drops its result when the token is stale:
// a newer token of the same kind exists.
export type Token = { readonly isStale: () => boolean };

function tokens(): { next: () => Token; now: () => Token } {
  let latest = 0;
  const at = (mine: number): Token => ({ isStale: () => mine !== latest });
  return { next: () => at(++latest), now: () => at(latest) };
}

// Every switch to another session takes a new token. A slow load of an older switch then opens
// nothing, so a quick Easy → Hard or Online → Computer ends on the last choice.
const switches = tokens();
export const newSwitch = switches.next;

// A round is one game position that the computer can answer. A new screen, a new game and an undo
// start a new round, so a computer move found for the old round is dropped.
const rounds = tokens();
export const newRound = (): void => void rounds.next();
export const currentRound = rounds.now;

export function showSession(session: Session): void {
  rounds.next();
  screen = { kind: 'session', session, review: undefined, thinking: false };
}

// A newer view of the open session. The review and the computer search go on.
export function updateSession(session: Session): void {
  if (screen.kind !== 'session' || screen.session.code !== session.code) throw new Error(`session ${session.code} is not open`);
  screen = { ...screen, session };
}

export function showGame(game: PublicGame, review: Review): void {
  rounds.next();
  screen = { kind: 'viewing', game, review };
}

export function clearScreen(): void {
  rounds.next();
  screen = { kind: 'empty' };
}

// An empty screen has no review: clearing it there changes nothing.
export function setReview(review: Review | undefined): void {
  if (screen.kind === 'empty') {
    if (review === undefined) return;
    throw new Error('a review without a game on the board');
  }
  screen = { ...screen, review };
}

// Only a session has a computer that thinks: clearing it elsewhere changes nothing.
export function setThinking(thinking: boolean): void {
  if (screen.kind !== 'session') {
    if (!thinking) return;
    throw new Error('the computer thinks without a session');
  }
  screen = { ...screen, thinking };
}

// The state that more than one module changes. A module cannot assign to a variable that it
// imports, so all modules change these fields through the one `page` object. The screen fields
// are read-only views of `screen`: the functions above change them.
type PageState = {
  // The games of the open session, oldest first. The last game is the live one.
  games: Game[];
  readonly session: Session | undefined;
  readonly review: Review | undefined;
  // Storage on this device, and the backend for computer, friend and hosted Nearby games.
  deviceDb: DeviceDb | undefined;
  local: LocalBackend | undefined;
  // Login state from the server. Without a network or on a LAN host, login is not available.
  account: Me;
  readonly thinking: boolean;
  // An action waits for its backend. Also before a session is open, such as the first online game.
  busy: boolean;
  // Milliseconds from the search request to its answer, for each computer move of the current game.
  // Index 0 is the computer's first move. A new game and a session switch empty the list, and an undo
  // drops the entries of the moves that it takes back. A game that this page did not see from its first
  // move keeps a shorter list (see src/page/computer.ts).
  computerThinkMs: number[];
  // Session holder time minus local time. Move times come from the server or the Nearby host, so the clocks use its time.
  serverOffset: number;
  // The keypad entry: layer, row, column, each 1..4. A tap fills the next one.
  coordDigits: number[];
  // A finished game opened from its link (/?game=<id>), read-only. No session is open meanwhile.
  readonly viewing: PublicGame | undefined;
};

// The custom name from the last /api/me answer, so the page shows it offline too.
const NAME_KEY = 'tick3d.name';

function storedName(): string | null {
  try {
    return parseCustomName(localStorage.getItem(NAME_KEY)) ?? null;
  } catch {
    return null; // Storage is blocked. The name comes with the next /api/me answer.
  }
}

export function saveAccount(account: Me): void {
  page.account = account;
  try {
    if (account.name === null) localStorage.removeItem(NAME_KEY);
    else localStorage.setItem(NAME_KEY, account.name);
  } catch {
    // Storage is blocked. The page keeps the name for this visit.
  }
}

// The name that other players see for this player: the GitHub login, the custom name, or the generated name.
export const ownName = (): string => page.account.user?.login ?? page.account.name ?? nameOf(token);

export const page: PageState = {
  games: [newGame('X', settings.clock)],
  get session() {
    return screen.kind === 'session' ? screen.session : undefined;
  },
  get review() {
    return screen.kind === 'empty' ? undefined : screen.review;
  },
  deviceDb: undefined,
  local: undefined,
  account: { loginAvailable: false, user: null, name: storedName() },
  get thinking() {
    return screen.kind === 'session' && screen.thinking;
  },
  busy: false,
  computerThinkMs: [],
  serverOffset: 0,
  coordDigits: [],
  get viewing() {
    return screen.kind === 'viewing' ? screen.game : undefined;
  },
};

export function current(): Game {
  const game = page.games.at(-1);
  if (game === undefined) throw new Error('session has no games');
  return game;
}

export function setCurrent(game: Game): void {
  page.games = [...page.games.slice(0, -1), game];
}

export const isLive = () => current().status.kind === 'playing';
// The lock holds the two players. A watcher keeps every own setting, so a lock never traps a watcher in a game.
export const settingsLocked = () => page.session !== undefined && page.session.locked && page.session.you !== null;
// Both seats have a player. A game with another device waits for the second player before a lock.
export const bothSeated = () => page.session !== undefined && page.session.seats.X && page.session.seats.O;
// A game with another device: online, or Nearby. An undo needs the other player, and chat is open.
export const shared = () => page.session?.mode === 'online' || page.session?.mode === 'nearby';
// A screen that watches a game with another device: it holds no seat.
export const isWatching = () => shared() && page.session?.you === null;

// The hide options belong to the session. With another device they apply to both players.
export function matchOptions(): MatchOptions {
  return page.session?.options ?? { hideBoard: false, hideHistory: false, hideCoordinates: false };
}

// The time limit for the next game. The live game keeps its own limit in `current().clock`.
export function nextClock(): TimeControl {
  return page.session?.clock ?? settings.clock;
}

export const nowMs = (): EpochMs => toEpochMs(Date.now() + page.serverOffset);

// Watchers cannot change a session.
export const canChangeMatch = () => page.session !== undefined && page.session.you !== null;

// The player at this screen, if there is exactly one.
export function me(): Player | null {
  if (page.session === undefined || page.session.mode === 'friend') return null;
  return page.session.you;
}

// Every mode plays a session through a backend with the same calls: the server for online
// games, this device for computer and friend games, the host's device for Nearby games.
export type SessionBackend = {
  load(code: Code): Promise<SessionView>;
  join(code: Code): Promise<SessionView>;
  move(code: Code, request: MoveRequest): Promise<SessionView>;
  newGame(code: Code): Promise<SessionView>;
  update(code: Code, changes: SessionUpdate): Promise<SessionView>;
  lock(code: Code): Promise<SessionView>;
  chat(code: Code, text: string): Promise<SessionView>;
  seat(code: Code, action: SeatAction): Promise<SessionView>;
  answerSeat(code: Code, accept: boolean): Promise<SessionView>;
  subscribe(code: Code, onChange: () => void): () => void;
};
