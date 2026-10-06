// Results of games away from the server, game ids, and the survival records against the computer.
import { type Game, type Player, other } from '../game.ts';
import { type RecordNews, type Records, parseRecords, addLoss, mergeRecords } from '../records.ts';
import { isDefaultTuning } from '../tuning.ts';
import { token, api, OnlineError } from '../online.ts';
import {
  type Code,
  type GameId,
  type PlayerToken,
  type ResultUpload,
  type MatchOptions,
  asPlayerToken,
  newGameId,
  onlineGameId,
  toRecord,
} from '../protocol.ts';
import { computerTuning } from './advanced.ts';
import { showToast } from './feedback.ts';
import { gameMetrics } from './metrics.ts';
import { nearbyKind, nearbyMetrics } from './nearby.ts';
import { settings } from './settings.ts';
import { type Session, page } from './state.ts';

let flushing = false;

// One id per device, session and game, so a result that is sent twice is stored once.
const resultIdOf = (code: Code, index: number) => `${token}-${code.toLowerCase()}-${index}`;

// Keeps a finished computer, friend or Nearby game for upload, and returns the id of its link.
// Online games are on the server already, and a Nearby watcher played no part: both get undefined.
export async function recordResult(open: Session, game: Game, index: number): Promise<GameId | undefined> {
  if (page.deviceDb === undefined || open.mode === 'online') return undefined;
  const you = open.mode === 'friend' ? null : open.you;
  if (open.mode !== 'friend' && you === null) return undefined;
  const id = resultIdOf(open.code, index);
  const tuned = open.mode === 'computer' && !isDefaultTuning(computerTuning());
  // Read the counts before the first wait: the player can start the next game meanwhile.
  const metrics = gameMetrics(open.code, index, tuned);
  const hosting = open.mode === 'nearby' && nearbyKind() === 'hosting';
  const existing = await page.deviceDb.get('results', id);
  // A device version before game links stored results without an id. The server gives those one.
  if (existing !== undefined) return existing.upload.publicId ?? undefined;
  const upload: ResultUpload = {
    id,
    mode: open.mode,
    game: toRecord(game),
    you,
    difficulty: open.mode === 'computer' ? settings.difficulty : null,
    finishedAt: game.times.at(-1) ?? Date.now(),
    publicId: newGameId(),
    options: open.options,
    tuned,
    metrics: { ...metrics, nearby: open.mode === 'nearby' ? await nearbyMetrics() : null },
    guest: hosting && you !== null ? await guestOf(open.code, you) : null,
  };
  await page.deviceDb.put('results', { id, upload, sent: false });
  await flushResults();
  return upload.publicId ?? undefined;
}

// The token of the guest on the other seat of a Nearby game that this device hosts. The host holds
// the session document, so it knows the token. Null while the other seat is empty.
async function guestOf(code: Code, you: Player): Promise<PlayerToken | null> {
  const summary = await page.local?.summary(code);
  if (summary === undefined || summary.doc.mode !== 'nearby') throw new Error(`the hosted Nearby session ${code} is not on this device`);
  const seat = summary.doc.seats[other(you)] ?? null;
  if (seat === null) return null;
  const guest = asPlayerToken(seat);
  if (guest === undefined || guest === token) throw new Error(`the guest seat of ${code} holds no guest token`);
  return guest;
}

// The game links that a Nearby host gave this guest, by session code and game index. The host's
// result names both players, so both devices show and share the host's link. The guest still
// uploads its own copy for its stats. Limit: the links last for this visit only, so a reload shows
// the guest's own link again. Revisit this if players miss the shared link after a reload.
const hostLinks = new Map<string, GameId>();
export const setHostLink = (code: Code, index: number, id: GameId) => hostLinks.set(`${code}:${index}`, id);
export const hostLinkOf = (code: Code, index: number) => hostLinks.get(`${code}:${index}`);

// Sends the metrics of this device for a finished online game that it played. A failure drops them:
// online games have no upload queue. Revisit this if the stats page shows few online reports.
export function sendOnlineMetrics(open: Session, index: number): void {
  if (open.mode !== 'online' || open.you === null) return;
  const metrics = gameMetrics(open.code, index, false);
  void api.gameMetrics(onlineGameId(open.code, index), metrics).catch((error: unknown) => {
    if (!(error instanceof OnlineError)) throw error;
  });
}

// The id of the link of a finished game in the open session, or undefined when it has none.
export async function gameIdOf(open: Session, index: number): Promise<GameId | undefined> {
  if (open.mode === 'online') return onlineGameId(open.code, index);
  const shared = open.mode === 'nearby' ? hostLinkOf(open.code, index) : undefined;
  if (shared !== undefined) return shared;
  return (await page.deviceDb?.get('results', resultIdOf(open.code, index)))?.upload.publicId ?? undefined;
}

// Sends every result that is waiting, when the network is up. A failure leaves them for the next try.
export async function flushResults(): Promise<void> {
  if (flushing || page.deviceDb === undefined || !navigator.onLine) return;
  flushing = true;
  try {
    const waiting = (await page.deviceDb.all('results')).filter((result) => !result.sent);
    if (waiting.length === 0) return;
    const renamed = await api.uploadResults(waiting.map((result) => result.upload));
    // The server gives another id to a result without one, or to one whose id another game holds.
    // A link that the page showed before keeps the old id; that is rare enough to accept.
    for (const result of waiting) {
      const publicId = renamed.get(result.id);
      const upload = publicId === undefined ? result.upload : { ...result.upload, publicId };
      await page.deviceDb.put('results', { ...result, upload, sent: true });
    }
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
    // The server is out of reach. The results wait for the next finished game or reconnect.
  } finally {
    flushing = false;
  }
}

const RECORDS_KEY = 'tick3d.records';
// Records that a game broke in this visit, by session code and game index, for its end card.
export const recordNews = new Map<string, RecordNews>();

// The device keeps its records, so they work offline. syncRecords adds the account's records from the server.
function loadRecords(): Records {
  try {
    return parseRecords(JSON.parse(localStorage.getItem(RECORDS_KEY) ?? 'null'));
  } catch {
    return {};
  }
}

function saveRecords(records: Records): void {
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
  } catch {
    // Storage is blocked (private mode). Records then last for this visit only.
  }
}

// Takes the higher of each record on this device and on the server (every device of the account),
// so a new record must beat both. Without a network the device records stay as they are.
export async function syncRecords(): Promise<void> {
  if (!navigator.onLine) return;
  try {
    const server = await api.records();
    saveRecords(mergeRecords(loadRecords(), server));
  } catch (error) {
    if (!(error instanceof OnlineError)) throw error;
  }
}

// A game that the computer won: the moves it lasted can beat the record of its setup.
// The hide options count as they are at the end of the game.
export function noteSurvival(open: Session, game: Game, index: number): void {
  const { records, news } = addLoss(loadRecords(), { difficulty: settings.difficulty, clock: game.clock, ...open.options, tuned: !isDefaultTuning(computerTuning()) }, game.moves.length);
  saveRecords(records);
  if (news === undefined) return;
  recordNews.set(`${open.code}:${index}`, news);
  showToast(`New record: you lasted ${news.moves} moves. Your best was ${news.previous}.`);
}

// For example "Board hidden", "Board and history hidden" or "Board, history and coordinates hidden".
export function hideLabel({ hideBoard, hideHistory, hideCoordinates }: MatchOptions): string | undefined {
  const parts = [hideBoard && 'board', hideHistory && 'history', hideCoordinates && 'coordinates'].filter((part) => part !== false);
  const last = parts.pop();
  if (last === undefined) return undefined;
  const text = parts.length === 0 ? last : `${parts.join(', ')} and ${last}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} hidden`;
}
