// The messages between the page and the move search in src/ai-worker.ts, and the page side of the search.
// Each side checks every message, so a bad message fails loudly instead of playing a wrong cell.
// A Worker does not exist in Node, so the tests drive these functions with a fake worker.
import { isCount, isRecord } from './guards.ts';
import { type Difficulty, DIFFICULTIES, chooseMove } from './ai.ts';
import { type Board, type Player, CELL_COUNT } from './game.ts';
import { type Tuning, parseTuning } from './tuning.ts';

export type SearchRequest = { id: number; board: Board; player: Player; difficulty: Difficulty; tuning: Tuning };
export type SearchAnswer = { id: number; cell: number } | { id: number; error: string };

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

// One long-lived worker, made on the first search. Answers carry the request id, because a search for
// an old game can still run when the page asks for the next move.
// If `start` throws (a browser without module workers), every search runs on the main thread, and the
// page waits during the search. If the worker fails later, the open searches fail and the next search
// makes a new worker.
export function createSearch(start: () => SearchWorker): Search {
  let worker: SearchWorker | undefined;
  let noWorker = false;
  let nextId = 0;
  const pending = new Map<number, { board: Board; resolve: (cell: number) => void; reject: (error: Error) => void }>();

  const failAll = (message: string) => {
    for (const { reject } of pending.values()) reject(new Error(message));
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };

  const onMessage = ({ data }: { data: unknown }) => {
    const answer = parseAnswer(data);
    if (answer === undefined) return failAll('invalid answer from the move search');
    const waiting = pending.get(answer.id);
    if (waiting === undefined) return failAll(`answer for unknown search ${answer.id}`);
    pending.delete(answer.id);
    if ('error' in answer) return waiting.reject(new Error(`move search failed: ${answer.error}`));
    try {
      waiting.resolve(legalCell(waiting.board, answer.cell));
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
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', () => failAll('the move search stopped'));
    worker.addEventListener('messageerror', () => failAll('the move search sent an unreadable message'));
    return worker;
  };

  return (board, player, difficulty, tuning) => {
    const current = ready();
    if (current === undefined) return Promise.resolve().then(() => legalCell(board, chooseMove(board, player, difficulty, Math.random, tuning)));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { board, resolve, reject });
      current.postMessage({ id, board, player, difficulty, tuning });
    });
  };
}
