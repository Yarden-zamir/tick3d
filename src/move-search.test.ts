import { describe, expect, it } from 'vitest';
import { type Board, CELL_COUNT, type Mark } from './game.ts';
import { answerRequest, createSearch, parseAnswer, parseRequest, type SearchRequest, type SearchWorker } from './move-search.ts';
import { DEFAULT_TUNING } from './tuning.ts';

function boardWith(marks: Record<number, Mark>): Board {
  return Array.from({ length: CELL_COUNT }, (_, cell) => marks[cell] ?? null);
}

// O wins at once on cell 3, so every level answers 3.
const winning = boardWith({ 0: 'O', 1: 'O', 2: 'O', 20: 'X', 21: 'X', 22: 'X' });
const request: SearchRequest = { id: 7, board: winning, player: 'O', difficulty: 'easy', tuning: DEFAULT_TUNING };

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
    expect(answerRequest({ ...request, player: 'Z' })).toMatchObject({ id: 7, error: expect.any(String) });
    expect(answerRequest({ ...request, board: winning.slice(1) })).toMatchObject({ id: 7, error: expect.any(String) });
    expect(answerRequest({ ...request, difficulty: 'expert' })).toMatchObject({ id: 7, error: expect.any(String) });
    expect(answerRequest('hello')).toMatchObject({ id: -1, error: expect.any(String) });
  });

  it('answers a full board with an error instead of throwing', () => {
    const full = Array.from({ length: CELL_COUNT }, (_, cell): Mark => (cell % 2 === 0 ? 'X' : 'O'));
    expect(answerRequest({ ...request, board: full })).toMatchObject({ id: 7, error: expect.any(String) });
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
  it('starts one worker on the first search and matches answers to requests by id', async () => {
    const fake = fakeWorker();
    let starts = 0;
    const search = createSearch(() => (starts++, fake.worker));
    const first = search(winning, 'O', 'easy', DEFAULT_TUNING);
    const second = search(boardWith({ 5: 'X' }), 'O', 'hard', DEFAULT_TUNING);
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
    const taken = search(winning, 'O', 'easy', DEFAULT_TUNING);
    fake.emit('message', { id: fake.sent[0]?.id, cell: 0 });
    await expect(taken).rejects.toThrow('not an empty cell');
    const outside = search(winning, 'O', 'easy', DEFAULT_TUNING);
    fake.emit('message', { id: fake.sent[1]?.id, cell: CELL_COUNT });
    await expect(outside).rejects.toThrow('not an empty cell');
  });

  it('rejects with the error that the worker sends', async () => {
    const fake = fakeWorker();
    const search = createSearch(() => fake.worker);
    const result = search(winning, 'O', 'easy', DEFAULT_TUNING);
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
    const first = search(winning, 'O', 'easy', DEFAULT_TUNING);
    const second = search(winning, 'O', 'easy', DEFAULT_TUNING);
    fakes[0]?.emit('message', { nonsense: true });
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    expect(fakes[0]?.terminated()).toBe(1);

    const third = search(winning, 'O', 'easy', DEFAULT_TUNING);
    expect(starts).toBe(2);
    fakes[1]?.emit('error');
    await expect(third).rejects.toThrow('stopped');
  });

  it('searches on the main thread when no worker can start', async () => {
    let starts = 0;
    const search = createSearch(() => {
      starts++;
      throw new Error('module workers are not supported');
    });
    await expect(search(winning, 'O', 'hard', DEFAULT_TUNING)).resolves.toBe(3);
    await expect(search(winning, 'O', 'easy', DEFAULT_TUNING)).resolves.toBe(3);
    expect(starts).toBe(1);
  });
});
