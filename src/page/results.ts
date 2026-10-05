// Results of games away from the server, and the survival records against the computer.
import type { Game } from '../game.ts';
import { type RecordNews, type Records, parseRecords, addLoss } from '../records.ts';
import { isDefaultTuning } from '../tuning.ts';
import { token, api, OnlineError } from '../online.ts';
import { type ResultUpload, toRecord, type MatchOptions } from '../protocol.ts';
import { computerTuning } from './advanced.ts';
import { showToast } from './feedback.ts';
import { settings } from './settings.ts';
import { type Session, page } from './state.ts';

let flushing = false;

// Keeps a finished computer, friend or Nearby game for upload. Online games are on the server already.
export async function recordResult(open: Session, game: Game, index: number): Promise<void> {
  if (page.deviceDb === undefined || open.mode === 'online') return;
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
  if ((await page.deviceDb.get('results', upload.id)) === undefined) {
    await page.deviceDb.put('results', { id: upload.id, upload, sent: false });
  }
  await flushResults();
}

// Sends every result that is waiting, when the network is up. A failure leaves them for the next try.
export async function flushResults(): Promise<void> {
  if (flushing || page.deviceDb === undefined || !navigator.onLine) return;
  flushing = true;
  try {
    const waiting = (await page.deviceDb.all('results')).filter((result) => !result.sent);
    if (waiting.length === 0) return;
    await api.uploadResults(waiting.map((result) => result.upload));
    for (const result of waiting) await page.deviceDb.put('results', { ...result, sent: true });
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
export function noteSurvival(open: Session, game: Game, index: number): void {
  const { hideBoard, hideHistory } = open.options;
  const { records, news } = addLoss(loadRecords(), { difficulty: settings.difficulty, clock: game.clock, hideBoard, hideHistory, tuned: !isDefaultTuning(computerTuning()) }, game.moves.length);
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
  } catch {
    // Storage is blocked (private mode). Records then last for this visit only.
  }
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
