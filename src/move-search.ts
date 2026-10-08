// The messages between the page and the move search in src/ai-worker.ts, and the page side of the search.
// Each side checks every message, so a bad message fails loudly instead of playing a wrong cell.
// A Worker does not exist in Node, so the tests drive these functions with a fake worker.
import { isCount, isRecord } from './guards.ts';
import { type Difficulty, DIFFICULTIES, chooseMove } from './ai.ts';
import { type Board, type Player, CELL_COUNT } from './game.ts';
import { type Tuning, parseTuning } from './tuning.ts';

export type SearchRequest = { id: number; board: Board; player: Player; difficulty: Difficulty; tuning: Tuning };
export type SearchAnswer = { id: number; cell: number } | { id: number; error: string };

// The first message of the worker, when its script loaded.
export const WORKER_READY = 'ready';
// The service worker keeps the worker script for offline play. Some browsers (WebKit) do not let the
// service worker serve a worker script, so offline the load fails or never ends. Without the ready
// message in this time, every search of this page runs on the main thread.
export const WORKER_START_MS = 3000;

const isPlayer = (value: unknown): value is Player => value === 'X' || value === 'O';
const isDifficulty = (value: unknown): value is Difficulty => DIFFICULTIES.some((level) => level === value);
const isBoard = (value: unknown): value is Board =>
  Array.isArray(value) && value.length === CELL_COUNT && value.every((mark) => mark === null || isPlayer(mark));

export function parseRequest(value: unknown): SearchRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { id, board, player, difficulty, tuning } = value;
  if (!isCount(id) || !isBoard(board) || !isPlayer(player) || !isDifficulty(difficulty)) return undefined;
  // The page sends its own checked settings, so parseTuning changes nothing in normal use.
  return { id, board, player, difficulty, tuning: parseTuning(tuning) };
}

// The worker's whole job: one answer for each message. An error goes back to the page, which shows it.
export function answerRequest(value: unknown): SearchAnswer {
  const request = parseRequest(value);
  if (request === undefined) return { id: isRecord(value) && isCount(value.id) ? value.id : -1, error: 'invalid search request' };
  try {
    return { id: request.id, cell: chooseMove(request.board, request.player, request.difficulty, Math.random, request.tuning) };
  } catch (error) {
    return { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
}

export function parseAnswer(value: unknown): SearchAnswer | undefined {
  if (!isRecord(value)) return undefined;
  const { id, cell, error } = value;
  if (!isCount(id) && id !== -1) return undefined;
  if (typeof cell === 'number' && error === undefined) return { id, cell };
  if (typeof error === 'string' && cell === undefined) return { id, error };
  return undefined;
}

// The cell, if it is an empty cell of the board. Anything else is a bug in the search or the protocol.
function legalCell(board: Board, cell: number): number {
  if (!Number.isInteger(cell) || cell < 0 || cell >= CELL_COUNT || board[cell] !== null) {
    throw new Error(`the computer chose cell ${cell}, which is not an empty cell`);
  }
  return cell;
}

// The part of a Worker that the search uses. A fake with the same shape tests it in Node.
export type SearchWorker = {
  postMessage(request: SearchRequest): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: () => void): void;
  terminate(): void;
};

export type Search = (board: Board, player: Player, difficulty: Difficulty, tuning: Tuning) => Promise<number>;

const searchHere = ({ board, player, difficulty, tuning }: Omit<SearchRequest, 'id'>): number =>
  legalCell(board, chooseMove(board, player, difficulty, Math.random, tuning));

type Waiting = { request: SearchRequest; resolve: (cell: number) => void; reject: (error: Error) => void };

// One long-lived worker, made on the first search. Answers carry the request id, because a search for
// an old game can still run when the page asks for the next move.
// If `start` throws (a browser without module workers), or the worker script does not load (WORKER_START_MS),
// every search runs on the main thread, and the page waits during the search. If a loaded worker fails
// later, the open searches fail and the next search makes a new worker.
export function createSearch(start: () => SearchWorker): Search {
  let worker: SearchWorker | undefined;
  let loaded = false;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let noWorker = false;
  let nextId = 0;
  const pending = new Map<number, Waiting>();

  const stopWorker = () => {
    clearTimeout(startTimer);
    worker?.terminate();
    worker = undefined;
  };

  const failAll = (message: string) => {
    for (const { reject } of pending.values()) reject(new Error(message));
    pending.clear();
    stopWorker();
  };

  // The worker script did not load: the open searches and every later search run on the main thread.
  const useMainThread = (reason: string) => {
    console.warn(`The move search runs on the main thread: ${reason}`);
    noWorker = true;
    stopWorker();
    const waiting = [...pending.values()];
    pending.clear();
    for (const { request, resolve, reject } of waiting) {
      try {
        resolve(searchHere(request));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };

  const onMessage = ({ data }: { data: unknown }) => {
    if (data === WORKER_READY) {
      loaded = true;
      clearTimeout(startTimer);
      return;
    }
    const answer = parseAnswer(data);
    if (answer === undefined) return failAll('invalid answer from the move search');
    const waiting = pending.get(answer.id);
    if (waiting === undefined) return failAll(`answer for unknown search ${answer.id}`);
    pending.delete(answer.id);
    if ('error' in answer) return waiting.reject(new Error(`move search failed: ${answer.error}`));
    try {
      waiting.resolve(legalCell(waiting.request.board, answer.cell));
    } catch (error) {
      waiting.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const ready = (): SearchWorker | undefined => {
    if (worker !== undefined || noWorker) return worker;
    try {
      worker = start();
    } catch {
      noWorker = true;
      return undefined;
    }
    loaded = false;
    startTimer = setTimeout(() => useMainThread('the worker script did not load in time'), WORKER_START_MS);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', () => (loaded ? failAll('the move search stopped') : useMainThread('the worker script did not load')));
    worker.addEventListener('messageerror', () => failAll('the move search sent an unreadable message'));
    return worker;
  };

  return (board, player, difficulty, tuning) => {
    const current = ready();
    if (current === undefined) return Promise.resolve().then(() => searchHere({ board, player, difficulty, tuning }));
    const request = { id: nextId++, board, player, difficulty, tuning };
    return new Promise((resolve, reject) => {
      pending.set(request.id, { request, resolve, reject });
      current.postMessage(request);
    });
  };
}
