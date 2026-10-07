// Opening, leaving and switching sessions, moves of the player, and answers from a backend.
import { sameClock, describeClock } from '../clock.ts';
import { checkPlayoffInvite } from './playoff-invite.ts';
import { play, newGame, type Player, other } from '../game.ts';
import { OnlineError, api } from '../online.ts';
import { type Code, type GameId, type SessionView, parseSessionView, toGame } from '../protocol.ts';
import { type LinkIntent, withWatch } from '../session-link.ts';
import type { SessionDoc } from '../session/format.ts';
import { sounds } from '../sound.ts';
import { notifyChat } from './chat.ts';
import { scheduleComputer } from './computer.ts';
import { burstEl } from './dom.ts';
import { announce, finish } from './end-card.ts';
import { reject, showToast, showError, showProblem } from './feedback.ts';
import { closeGameView } from './game-view.ts';
import { countMove, countUndo } from './metrics.ts';
import { nearbyKind, endNearby, redrawNearby } from './nearby.ts';
import { seatChangeText } from './players.ts';
import { render } from './render.ts';
import { type Mode, settings, saveSettings } from './settings.ts';
import {
  page,
  clearScreen,
  current,
  nowMs,
  setCurrent,
  setReview,
  setThinking,
  shared,
  showSession,
  newRound,
  newSwitch,
  type Token,
  updateSession,
  type Session,
  type SessionBackend,
  settingsLocked,
} from './state.ts';

// The error sound of a refused move lasts about 0.27 s. A taken cell plays its own sound after it.
const TAKEN_SOUND_DELAY_MS = 320;

export function humanMove(cell: number, via: 'board' | 'keypad'): void {
  if (page.viewing) return reject(cell, 'viewing');
  if (page.review) return reject(cell, 'reviewing');
  void playMove(cell, via);
}

async function playMove(cell: number, via: 'board' | 'keypad'): Promise<void> {
  if (page.session === undefined) return reject(cell, 'no-session');
  if (page.session.you === null) return reject(cell, 'spectator');
  const waitReason = page.session.mode === 'computer' ? 'wait' : 'not-your-turn';
  if (page.busy || page.thinking) return reject(cell, waitReason);
  const game = current();
  const result = play(game, cell, nowMs());
  if (!result.ok) {
    reject(cell, result.error);
    // A taken cell plays its own sound after the error sound, so the player learns by ear what is there.
    const mark = game.board[cell];
    if (result.error === 'occupied' && mark) setTimeout(() => sounds.place(mark, cell), TAKEN_SOUND_DELAY_MS);
    return;
  }
  // In a friend game this device plays both seats.
  if (page.session.mode !== 'friend' && game.turn !== page.session.you) return reject(cell, waitReason);
  const { code, backend } = page.session;
  const request = { game: page.games.length - 1, moveCount: game.moves.length, cell };
  countMove(via);
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

// The address holds `watch=1` only while a watch link shows its session. A new code drops it.
export function setUrlCode(code: Code | undefined, watch = false): void {
  const url = withWatch(new URL(location.href), watch);
  if (code === undefined) url.searchParams.delete('code');
  else url.searchParams.set('code', code);
  history.replaceState(null, '', url);
}

// The link of a finished game in the address (`?game=<id>`). A new game, a session switch or Home removes it.
export function setUrlGame(id: GameId | undefined): void {
  const url = new URL(location.href);
  if (id === undefined) url.searchParams.delete('game');
  else url.searchParams.set('game', id);
  history.replaceState(null, '', url);
}

export function applyView(view: SessionView): void {
  // A late answer for a session that is closed now changes nothing.
  if (page.session === undefined || page.session.code !== view.code) return;
  if (view.version < page.session.version) return; // an older answer arrived late
  const before = current();
  const beforeCount = page.games.length;
  page.games = view.games.map(toGame);
  page.serverOffset = view.now - Date.now();
  const previous = page.session;
  updateSession({ ...view, backend: page.session.backend, mode: page.session.mode, unsubscribe: page.session.unsubscribe });
  const after = current();
  // Changes by the other player get a message. On one device, the player made them.
  if (shared()) {
    if (!sameClock(page.session.clock, previous.clock)) {
      const startsLater = after.status.kind === 'playing' && after.moves.length > 0;
      showToast(`Time limit${startsLater ? ' for the next game' : ''}: ${describeClock(page.session.clock)}.`);
    }
    if (page.session.locked && !previous.locked) showToast('Settings are locked for both players until this game ends.');
    if (page.session.fixedSeats !== previous.fixedSeats) showToast(seatLockText(page.session.fixedSeats));
    const seatChange = seatChangeText(previous, page.session);
    if (seatChange !== undefined) showToast(seatChange);
    for (const [option, label] of [['hideBoard', 'Hide board'], ['hideHistory', 'Hide history'], ['hideCoordinates', 'Hide coordinates']] as const) {
      if (page.session.options[option] !== previous.options[option]) {
        showToast(`${label} is ${page.session.options[option] ? 'on' : 'off'} for both players.`);
      }
    }
  }
  // A move that is not on screen yet came from the other player or the computer. Our own moves were announced already.
  const isNewMove =
    page.games.length === beforeCount &&
    after.moves.length === before.moves.length + 1 &&
    before.moves.every((cell, i) => after.moves[i] === cell);
  const timedOutNow = page.games.length === beforeCount && before.status.kind === 'playing' && after.status.kind === 'timeout';
  if (isNewMove) announce(after);
  else if (timedOutNow) finish(after);
  // Undo takes moves back from the same game.
  if (page.games.length === beforeCount && after.moves.length < before.moves.length) countUndo();
  // A live game is not the finished game that the address links to.
  if (after.status.kind === 'playing' && new URLSearchParams(location.search).has('game')) setUrlGame(undefined);
  const lastSeen = previous.chat.at(-1)?.id ?? -1;
  const incoming = page.session.chat.filter((message) => message.id > lastSeen && message.from !== page.session?.you);
  const newest = incoming.at(-1);
  if (newest !== undefined && shared()) {
    sounds.message();
    notifyChat(newest, incoming.length);
  }
  // The Nearby device list shows the seat of each device.
  if (page.session.mode === 'nearby' && (previous.you !== page.session.you || JSON.stringify(previous.names) !== JSON.stringify(page.session.names))) {
    redrawNearby();
  }
  if (page.review && page.review.game >= page.games.length) setReview(undefined);
  followSeat(page.session);
  if (page.session.mode === 'online') {
    void page.deviceDb?.put('remote', { code: page.session.code, view, savedAt: Date.now() });
    checkPlayoffInvite(view);
  }
  render();
}

export function openSession(view: SessionView, backend: SessionBackend, mode: Mode): void {
  page.coordDigits = [];
  page.session?.unsubscribe();
  page.computerThinkMs = [];
  if (settings.mode !== mode) {
    settings.mode = mode;
    saveSettings();
  }
  burstEl.replaceChildren();
  // A new screen: no review, and no computer search of the previous session.
  const session: Session = { ...view, backend, mode, unsubscribe: () => undefined };
  showSession(session);
  page.games = view.games.map(toGame);
  page.serverOffset = view.now - Date.now();
  followSeat(session);
  const code = view.code;
  session.unsubscribe = backend.subscribe(code, () => void refresh(code));
  setUrlCode(mode === 'online' ? code : undefined);
  setUrlGame(undefined);
  if (mode === 'online') void page.deviceDb?.put('remote', { code, view, savedAt: Date.now() });
  render();
  scheduleComputer();
}

export function leaveSession(): void {
  page.coordDigits = [];
  page.session?.unsubscribe();
  // Also ends the review and the computer search of the session or the game from a link.
  clearScreen();
  page.games = [newGame('X', settings.clock)];
  setUrlCode(undefined);
  setUrlGame(undefined);
}

export async function refresh(code: Code): Promise<void> {
  const open = page.session;
  if (open === undefined || open.code !== code) return;
  try {
    applyView(await open.backend.load(code));
  } catch (error) {
    showError(error);
  }
}

export const BUSY_TEXT = 'Wait a moment: the last action is still running.';

export async function withBusy(task: () => Promise<void>): Promise<void> {
  if (page.busy) return showToast(BUSY_TEXT);
  page.busy = true;
  render();
  try {
    await task();
  } catch (error) {
    showError(error);
  } finally {
    page.busy = false;
    render();
  }
}

export function defaultSessionName(mode: Mode = 'online'): string {
  const day = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const kind = mode === 'computer' ? `${settings.difficulty} computer` : mode === 'friend' ? 'friend' : mode === 'nearby' ? 'nearby game' : 'game';
  return mode === 'online' ? `Game of ${day}` : `${kind[0]?.toUpperCase()}${kind.slice(1)} · ${day}`;
}

export const seatLockText = (fixedSeats: boolean): string =>
  fixedSeats ? 'Seats kept.' : 'Seats swap each game.';

// In a computer game the seats rotate between games, so "You play" follows the seat of the live game.
// Limit: a click on the other seat still opens the newest session of that match-up, as before rotation.
// Revisit this if players expect that click to change the seat in the open session.
function followSeat(open: Session): void {
  if (open.mode !== 'computer' || open.you === null || settings.human === open.you) return;
  settings.human = open.you;
  saveSettings();
}

// The seat of the player in a computer game: the one the computer does not hold.
const humanSeatOf = (doc: SessionDoc): Player | undefined => (doc.computer ? other(doc.computer.seat) : undefined);

// A switch also ends a Nearby game, so a host never serves guests in the background.
export function beginSwitch(): Token {
  if (nearbyKind() !== 'idle') endNearby();
  return newSwitch();
}

// Opens the newest session on this device for the chosen match-up, or starts one.
export async function openLocalSession(mode: 'computer' | 'friend'): Promise<void> {
  const switching = beginSwitch();
  const backend = page.local;
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
  if (!switching.isStale()) openSession(view, backend, mode);
}

// Reopens any session on this device, for example from My games.
export async function openDeviceSession(code: Code): Promise<void> {
  const switching = beginSwitch();
  const backend = page.local;
  if (backend === undefined) throw new Error('the device backend is not ready');
  const entry = await backend.summary(code);
  if (entry === undefined || entry.mode === 'nearby') return showProblem('That game is not on this device any more.');
  const view = await backend.load(code);
  if (switching.isStale()) return;
  if (entry.doc.computer) {
    settings.difficulty = entry.doc.computer.difficulty;
    settings.human = humanSeatOf(entry.doc) ?? settings.human;
    saveSettings();
  }
  openSession(view, backend, entry.mode);
}

export const createSession = () =>
  withBusy(async () => {
    if (!navigator.onLine) throw new OnlineError('You are offline. Online games need a connection.');
    const switching = beginSwitch();
    const view = await api.create(defaultSessionName(), settings.clock);
    if (!switching.isStale()) openSession(view, api, 'online');
  });

// A 'watch' intent opens the session without a seat. The Players box can take a free seat later.
export const joinSession = (code: Code, intent: LinkIntent) =>
  withBusy(async () => {
    const switching = beginSwitch();
    let view: SessionView;
    try {
      view = await api.load(code);
    } catch (error) {
      // Without a network, an online game this device saw before opens as last seen.
      // A move then fails with the network error until the network comes back.
      const cached = await page.deviceDb?.get('remote', code);
      if (!(error instanceof OnlineError) || error.status !== undefined || cached === undefined) throw error;
      if (switching.isStale()) return;
      // The parse also fills fields that a view cached by an older version lacks.
      const cachedView = parseSessionView(cached.view);
      openSession(cachedView, api, 'online');
      if (intent === 'watch' && cachedView.you === null) setUrlCode(code, true);
      showToast('You are offline. This is the game as you last saw it.');
      return;
    }
    const seatFree = !view.seats.X || !view.seats.O;
    if (intent === 'play' && view.you === null && seatFree) view = await api.join(code);
    if (switching.isStale()) return;
    openSession(view, api, 'online');
    // A reload of a watch link must not take the seat either.
    if (intent === 'watch' && view.you === null) setUrlCode(code, true);
    sounds.click();
    if (view.you !== null) return showToast(`Joined ${view.name} as ${view.you}.`);
    showToast(seatFree ? 'You are watching. A seat is free: take it in Players.' : 'Both seats are taken. You are watching.');
  });

export function startNewGame(): void {
  // A game from a link has no next game: New game goes back to play.
  if (page.viewing !== undefined) return void closeGameView().catch(showError);
  if (settingsLocked()) return reject(undefined, 'locked');
  if (page.session === undefined) return reject(undefined, 'no-session');
  sounds.click();
  newRound(); // drops a computer move for the game that ends here
  page.computerThinkMs = [];
  setThinking(false);
  const { code, backend } = page.session;
  void withBusy(async () => {
    setReview(undefined);
    burstEl.replaceChildren();
    const before = page.session?.you;
    applyView(await backend.newGame(code));
    // With another device, applyView says it already (seatChangeText).
    const you = page.session?.you;
    if (!shared() && you != null && you !== before) showToast(`You play ${you} this game.`);
  }).then(scheduleComputer);
}
