// Results of games away from the server, game ids, and the survival records against the computer.
import type { Game } from '../game.ts';
import { type RecordNews, type Records, parseRecords, addLoss, mergeRecords } from '../records.ts';
import { isDefaultTuning } from '../tuning.ts';
import { token, api, OnlineError } from '../online.ts';
import { type Code, type GameId, type ResultUpload, type MatchOptions, newGameId, onlineGameId, toRecord } from '../protocol.ts';
import { computerTuning } from './advanced.ts';
import { showToast } from './feedback.ts';
import { gameMetrics } from './metrics.ts';
import { nearbyMetrics } from './nearby.ts';
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
  };
  await page.deviceDb.put('results', { id, upload, sent: false });
  await flushResults();
  return upload.publicId ?? undefined;
}

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
  const { hideBoard, hideHistory } = open.options;
  const { records, news } = addLoss(loadRecords(), { difficulty: settings.difficulty, clock: game.clock, hideBoard, hideHistory, tuned: !isDefaultTuning(computerTuning()) }, game.moves.length);
  saveRecords(records);
  if (news === undefined) return;
  recordNews.set(`${open.code}:${index}`, news);
  showToast(`New record: you lasted ${news.moves} moves. Your best was ${news.previous}.`);
}

export function hideLabel({ hideBoard, hideHistory }: MatchOptions): string | undefined {
  if (hideBoard && hideHistory) return 'Board and history hidden';
  if (hideBoard) return 'Board hidden';
  if (hideHistory) return 'History hidden';
  return undefined;
}
