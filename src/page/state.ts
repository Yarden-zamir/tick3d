// The open session and the state that more than one module reads and changes.
import type { TimeControl } from '../clock.ts';
import type { DeviceDb } from '../device-db.ts';
import { type Game, type Player, newGame } from '../game.ts';
import type { LocalBackend } from '../local.ts';
import type { Me } from '../online.ts';
import type { SessionView, MatchOptions, Code, MoveRequest, SessionUpdate, PublicGame } from '../protocol.ts';
import { type Mode, settings } from './settings.ts';

// The open session: its latest view, the backend that holds it, and its mode.
export type Session = SessionView & { backend: SessionBackend; mode: Mode; unsubscribe: () => void };

// The state that more than one module changes. A module cannot assign to a variable that it
// imports, so all modules change these fields through the one `page` object.
type PageState = {
  // The games of the open session, oldest first. The last game is the live one.
  games: Game[];
  session: Session | undefined;
  review: { game: number; move: number } | undefined;
  // Storage on this device, and the backend for computer, friend and hosted Nearby games.
  deviceDb: DeviceDb | undefined;
  local: LocalBackend | undefined;
  // Login state from the server. Without a network or on a LAN host, login is not available.
  account: Me;
  thinking: boolean;
  busy: boolean;
  // Milliseconds from the search request to its answer, for each computer move of the current game.
  // Index 0 is the computer's first move. A new game and a session switch empty the list, and an undo
  // drops the entries of the moves that it takes back. A game that this page did not see from its first
  // move keeps a shorter list (see src/page/computer.ts).
  computerThinkMs: number[];
  // Increments on every new local game, so a computer move scheduled for an old game is dropped.
  round: number;
  // Session holder time minus local time. Move times come from the server or the Nearby host, so the clocks use its time.
  serverOffset: number;
  // The keypad entry: layer, row, column, each 1..4. A tap fills the next one.
  coordDigits: number[];
  // Every switch to another session takes a new number. A slow load of an older switch then opens
  // nothing, so a quick Easy → Hard or Online → Computer ends on the last choice. A switch also ends
  // a Nearby game, so a host never serves guests in the background.
  navigation: number;
  // A finished game opened from its link (/?game=<id>), read-only. No session is open meanwhile.
  viewing: PublicGame | undefined;
};

export const page: PageState = {
  games: [newGame('X', settings.clock)],
  session: undefined,
  review: undefined,
  deviceDb: undefined,
  local: undefined,
  account: { loginAvailable: false, user: null },
  thinking: false,
  busy: false,
  computerThinkMs: [],
  round: 0,
  serverOffset: 0,
  coordDigits: [],
  navigation: 0,
  viewing: undefined,
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
export const settingsLocked = () => page.session?.locked ?? false;
// A game with another device: online, or Nearby. Moves are final and chat is open.
export const shared = () => page.session?.mode === 'online' || page.session?.mode === 'nearby';

// The hide options belong to the session. With another device they apply to both players.
export function matchOptions(): MatchOptions {
  return page.session?.options ?? { hideBoard: false, hideHistory: false };
}

// The time limit for the next game. The live game keeps its own limit in `current().clock`.
export function nextClock(): TimeControl {
  return page.session?.clock ?? settings.clock;
}

export const nowMs = () => Date.now() + page.serverOffset;

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
  subscribe(code: Code, onChange: () => void): () => void;
};
