import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CELL_COUNT } from './game.ts';
import { type Position, chooseMove } from './ai.ts';
import {
  answerRequest,
  createSearch,
  parseAnswer,
  parseRequest,
  type SearchRequest,
  type SearchWorker,
  WORKER_READY,
  WORKER_START_MS,
} from './move-search.ts';
import { DEFAULT_TUNING } from './tuning.ts';

// O wins at once on cell 3, so every level answers 3.
const winning: Position = { moves: [0, 20, 1, 21, 2, 22], first: 'O' };
const request: SearchRequest = { id: 7, ...winning, difficulty: 'easy', tuning: DEFAULT_TUNING };

// A worker that answers only when the test tells it to, in any order.
function fakeWorker() {
  const listeners: Record<string, ((event: { data: unknown }) => void)[]> = {};
  const sent: SearchRequest[] = [];
  let terminated = 0;
  const worker: SearchWorker = {
    postMessage: (message) => sent.push(message),
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => (listeners[type] ??= []).push(listener),
    terminate: () => terminated++,
  };
  const emit = (type: string, data?: unknown) => listeners[type]?.forEach((listener) => listener({ data }));
  return { worker, sent, emit, terminated: () => terminated };
}

describe('the worker side', () => {
  it('answers a valid request with the cell that chooseMove picks', () => {
    expect(answerRequest(request)).toEqual({ id: 7, cell: 3 });
  });

  it('answers an invalid request with an error and keeps its id when it can', () => {
    expect(answerRequest({ ...request, first: 'Z' })).toMatchObject({ id: 7, error: expect.any(String) });
    expect(answerRequest({ ...request, difficulty: 'expert' })).toMatchObject({ id: 7, error: expect.any(String) });
    expect(answerRequest('hello')).toMatchObject({ id: -1, error: expect.any(String) });
  });

  it('rejects a moves field that is not a list of cells', () => {
    for (const moves of [undefined, '0,1', [0, -1], [0, 1.5], [0, CELL_COUNT], ['0'], Array.from({ length: CELL_COUNT + 1 }, () => 0)]) {
      expect(parseRequest({ ...request, moves })).toBeUndefined();
      expect(answerRequest({ ...request, moves })).toMatchObject({ id: 7, error: 'invalid search request' });
    }
  });

  it('answers moves that are not a legal game, or a finished game, with an error instead of throwing', () => {
    expect(answerRequest({ ...request, moves: [0, 0] })).toMatchObject({ id: 7, error: expect.any(String) });
    expect(answerRequest({ ...request, moves: [...winning.moves, 3] })).toMatchObject({ id: 7, error: expect.any(String) });
  });

  it('keeps checked tuning and replaces a bad value with the default', () => {
    const hard = { ...DEFAULT_TUNING.hard, budgetMs: 5000 };
    expect(parseRequest({ ...request, tuning: { ...DEFAULT_TUNING, hard } })?.tuning).toEqual(DEFAULT_TUNING);
  });
});

describe('parseAnswer', () => {
  it('accepts a cell or an error, not both and not neither', () => {
    expect(parseAnswer({ id: 1, cell: 5 })).toEqual({ id: 1, cell: 5 });
    expect(parseAnswer({ id: 1, error: 'x' })).toEqual({ id: 1, error: 'x' });
    expect(parseAnswer({ id: 1, cell: 5, error: 'x' })).toBeUndefined();
    expect(parseAnswer({ id: 1 })).toBeUndefined();
    expect(parseAnswer({ id: '1', cell: 5 })).toBeUndefined();
    expect(parseAnswer(null)).toBeUndefined();
  });
});

describe('createSearch', () => {
  // The start time limit of the worker uses a timer.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts one worker on the first search and matches answers to requests by id', async () => {
    const fake = fakeWorker();
    let starts = 0;
    const search = createSearch(() => (starts++, fake.worker));
    const first = search(winning, 'easy', DEFAULT_TUNING);
    const second = search({ moves: [5], first: 'X' }, 'hard', DEFAULT_TUNING);
    expect(starts).toBe(1);
    const [a, b] = fake.sent;
    if (a === undefined || b === undefined) throw new Error('two requests expected');
    // The answers come back in the other order.
    fake.emit('message', { id: b.id, cell: 10 });
    fake.emit('message', { id: a.id, cell: 3 });
    await expect(first).resolves.toBe(3);
    await expect(second).resolves.toBe(10);
  });

  it('rejects a cell that is not empty or not on the board', async () => {
    const fake = fakeWorker();
    const search = createSearch(() => fake.worker);
    const taken = search(winning, 'easy', DEFAULT_TUNING);
    fake.emit('message', { id: fake.sent[0]?.id, cell: 0 });
    await expect(taken).rejects.toThrow('not an empty cell');
    const outside = search(winning, 'easy', DEFAULT_TUNING);
    fake.emit('message', { id: fake.sent[1]?.id, cell: CELL_COUNT });
    await expect(outside).rejects.toThrow('not an empty cell');
  });

  it('rejects with the error that the worker sends', async () => {
    const fake = fakeWorker();
    const search = createSearch(() => fake.worker);
    const result = search(winning, 'easy', DEFAULT_TUNING);
    fake.emit('message', { id: fake.sent[0]?.id, error: 'no legal move' });
    await expect(result).rejects.toThrow('no legal move');
  });

  it('fails every open search on a bad answer or a worker error, and starts a new worker next time', async () => {
    const fakes = [fakeWorker(), fakeWorker()];
    let starts = 0;
    const search = createSearch(() => {
      const fake = fakes[starts++];
      if (fake === undefined) throw new Error('too many workers');
      return fake.worker;
    });
    const first = search(winning, 'easy', DEFAULT_TUNING);
    const second = search(winning, 'easy', DEFAULT_TUNING);
    fakes[0]?.emit('message', { nonsense: true });
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    expect(fakes[0]?.terminated()).toBe(1);

    const third = search(winning, 'easy', DEFAULT_TUNING);
    expect(starts).toBe(2);
    fakes[1]?.emit('message', WORKER_READY);
    fakes[1]?.emit('error');
    await expect(third).rejects.toThrow('stopped');
  });

  it('searches on the main thread when no worker can start', async () => {
    let starts = 0;
    const search = createSearch(() => {
      starts++;
      throw new Error('module workers are not supported');
    });
    await expect(search(winning, 'hard', DEFAULT_TUNING)).resolves.toBe(3);
    await expect(search(winning, 'easy', DEFAULT_TUNING)).resolves.toBe(3);
    expect(starts).toBe(1);
  });

  it('searches on the main thread when the worker script does not load', async () => {
    const fake = fakeWorker();
    let starts = 0;
    const search = createSearch(() => (starts++, fake.worker));
    const open = search(winning, 'hard', DEFAULT_TUNING);
    fake.emit('error');
    await expect(open).resolves.toBe(3);
    await expect(search(winning, 'easy', DEFAULT_TUNING)).resolves.toBe(3);
    expect(starts).toBe(1);
    expect(fake.terminated()).toBe(1);
  });

  it('searches on the main thread when the worker does not report ready in time', async () => {
    const fake = fakeWorker();
    const search = createSearch(() => fake.worker);
    const open = search(winning, 'easy', DEFAULT_TUNING);
    vi.advanceTimersByTime(WORKER_START_MS);
    await expect(open).resolves.toBe(3);
    expect(fake.terminated()).toBe(1);
  });

  it('keeps a worker that reports ready, however long the search takes', async () => {
    const fake = fakeWorker();
    const search = createSearch(() => fake.worker);
    const open = search(winning, 'easy', DEFAULT_TUNING);
    fake.emit('message', WORKER_READY);
    vi.advanceTimersByTime(WORKER_START_MS * 10);
    fake.emit('message', { id: fake.sent[0]?.id, cell: 3 });
    await expect(open).resolves.toBe(3);
    expect(fake.terminated()).toBe(0);
  });
});

// Issue #169: the flat view and the tower view only draw the same board in another way.
describe('the view', () => {
  // A midgame without a forced move, so the level's random choices decide the cell.
  const midgame: Position = { moves: [0, 21, 42, 5, 63, 10], first: 'X' };
  const seeded = (seed: number) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  it('never reaches the search: a request with view settings gives the same move', () => {
    for (const difficulty of ['easy', 'medium'] as const) {
      const plain = parseRequest({ id: 1, ...midgame, difficulty, tuning: DEFAULT_TUNING });
      const withView = parseRequest({ id: 1, ...midgame, difficulty, tuning: DEFAULT_TUNING, view: 'flat', layout: 'row' });
      if (plain === undefined || withView === undefined) throw new Error('both requests are valid');
      expect(withView).toEqual(plain);
      for (const seed of [1, 2, 3]) expect(chooseMove(withView, difficulty, seeded(seed))).toBe(chooseMove(plain, difficulty, seeded(seed)));
    }
  });

  it('the page sends the position, the level and the tuning, and nothing else', () => {
    const fake = fakeWorker();
    const search = createSearch(() => fake.worker);
    const game = { ...midgame, view: 'flat' };
    void search(game, 'hard', DEFAULT_TUNING);
    expect(Object.keys(fake.sent[0] ?? {}).sort()).toEqual(['difficulty', 'first', 'id', 'moves', 'tuning']);
  });
});
