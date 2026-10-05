import { describe, expect, it } from 'vitest';
import { replay } from './game.ts';
import {
  normalizeChat,
  normalizeCode,
  parsePlayerInfo,
  parseResultUpload,
  parseClientEvent,
  parseGameId,
  parseHistoryPage,
  parseMetrics,
  parsePublicGame,
  newGameId,
  onlineGameId,
  type Code,
  parseSessionUpdate,
  parseSessionView,
  toRecord,
} from './protocol.ts';

describe('normalizeCode', () => {
  it('accepts 4 characters from the alphabet in any case', () => {
    expect(normalizeCode(' ab3k ')).toBe('AB3K');
  });

  it.each(['ABC', 'ABCDE', 'AB-K', 'AB0K', 'ABOK', ''])('rejects %j', (input) => {
    expect(normalizeCode(input)).toBeUndefined();
  });
});

describe('parseSessionView', () => {
  const valid = {
    code: 'AB3K',
    name: 'Match',
    games: [{ moves: [0, 1], times: [10, 20], clock: { perMove: null, perGame: 300 }, timedOut: false }],
    seats: { X: true, O: false },
    you: 'X',
    options: { hideBoard: true, hideHistory: false },
    locked: false,
    clock: { perMove: 30, perGame: 300 },
    now: 30,
    version: 2,
    chat: [{ id: 7, from: 'O', text: 'good luck', at: 1_700_000_000_000 }],
    presence: { X: true, O: false },
    players: { X: { login: 'octo', avatar: 'https://avatars.githubusercontent.com/u/7?v=4' }, O: null },
    turn: 'X',
    status: { kind: 'playing' },
  };

  it('accepts a valid view', () => {
    expect(parseSessionView(valid)).toEqual(valid);
  });

  it('fills turn and status from the moves when a sender has no such fields', () => {
    const { turn: _turn, status: _status, ...older } = valid;
    expect(parseSessionView(older)).toEqual(valid);
    const won = { ...older, games: [{ ...valid.games[0], moves: [0, 1, 16, 2, 32, 3, 48], times: [1, 2, 3, 4, 5, 6, 7] }] };
    expect(parseSessionView(won)).toMatchObject({ turn: null, status: { kind: 'won', winner: 'X', line: [0, 16, 32, 48] } });
  });

  it.each([
    ['games', { ...valid, games: [{ ...valid.games[0], moves: [64], times: [1] }] }],
    ['game times', { ...valid, games: [{ ...valid.games[0], times: [1] }] }],
    ['game clock', { ...valid, games: [{ ...valid.games[0], clock: { perMove: 1, perGame: null } }] }],
    ['clock', { ...valid, clock: { perMove: null, perGame: 7 } }],
    ['you', { ...valid, you: 'Z' }],
    ['seats', { ...valid, seats: {} }],
    ['options', { ...valid, options: { hideBoard: 'yes', hideHistory: false } }],
    ['locked', { ...valid, locked: undefined }],
    ['chat', { ...valid, chat: undefined }],
    ['chat', { ...valid, chat: [{ id: 1, from: 'Z', text: 'hi', at: 0 }] }],
    ['chat', { ...valid, chat: [{ id: 1, from: 'X', text: '', at: 0 }] }],
    ['turn', { ...valid, turn: 'O' }],
    ['status', { ...valid, status: { kind: 'won', winner: 'X', line: [0, 1, 2, 3] } }],
    ['status', { ...valid, status: { kind: 'playing', winner: 'X' } }],
    ['games', { ...valid, games: [{ ...valid.games[0], moves: [0, 0], times: [1, 2] }] }],
  ])('throws on a bad %s field', (_, input) => {
    expect(() => parseSessionView(input)).toThrow();
  });
});

describe('parseSessionUpdate', () => {
  it('accepts a name and match options', () => {
    expect(parseSessionUpdate({ name: ' Rematch ', hideBoard: true })).toEqual({ name: 'Rematch', hideBoard: true });
    expect(parseSessionUpdate({ hideHistory: false })).toEqual({ hideHistory: false });
    expect(parseSessionUpdate({ clock: { perMove: 30, perGame: null } })).toEqual({ clock: { perMove: 30, perGame: null } });
  });

  it.each([{}, { name: '' }, { hideBoard: 'true' }, { locked: true }, { clock: { perMove: 2, perGame: null } }, null])('rejects %j', (input) => {
    expect(parseSessionUpdate(input)).toBeUndefined();
  });
});

describe('normalizeChat', () => {
  it('trims a message', () => {
    expect(normalizeChat('  gg  ')).toBe('gg');
  });

  it.each(['', '   ', 'x'.repeat(201), 42, null])('rejects %j', (input) => {
    expect(normalizeChat(input)).toBeUndefined();
  });
});

describe('parsePlayerInfo', () => {
  it('accepts a GitHub login with a GitHub avatar only', () => {
    const avatar = 'https://avatars.githubusercontent.com/u/7?v=4';
    expect(parsePlayerInfo({ login: 'octo-cat', avatar })).toEqual({ login: 'octo-cat', avatar });
    expect(parsePlayerInfo({ login: 'octo', avatar: 'https://evil.example.org/a.png' })).toBeUndefined();
    expect(parsePlayerInfo({ login: '<script>', avatar })).toBeUndefined();
    expect(parsePlayerInfo({ login: 'x'.repeat(40), avatar })).toBeUndefined();
  });
});

describe('parseResultUpload', () => {
  const X_WINS = [0, 1, 16, 2, 32, 3, 48];
  const finished = toRecord(replay(X_WINS));
  const valid = { id: 'aaaaaaaa-0000-4000-8000-000000000001-ab3k-0', mode: 'computer', game: finished, you: 'X', difficulty: 'hard', finishedAt: 5 };
  const now = 1_000_000;
  const day = 86_400_000;

  it('accepts a finished game with a matching mode, seat and level', () => {
    expect(parseResultUpload(valid, now)).toEqual({ ...valid, publicId: null, options: { hideBoard: false, hideHistory: false }, tuned: false, metrics: null });
    expect(parseResultUpload({ ...valid, mode: 'friend', you: null, difficulty: null }, now)).toBeDefined();
    expect(parseResultUpload({ ...valid, finishedAt: now + day }, now)).toBeDefined();
  });

  it.each([
    ['an unfinished game', { ...valid, game: toRecord(replay([0, 1])) }],
    ['an illegal game', { ...valid, game: { ...finished, moves: [0, 0, 1, 2, 3, 4, 5] } }],
    ['a friend game with a seat', { ...valid, mode: 'friend', you: 'X', difficulty: null }],
    ['a computer game without a level', { ...valid, difficulty: null }],
    ['an online game', { ...valid, mode: 'online' }],
    ['a short id', { ...valid, id: 'short' }],
    ['a finish time of zero', { ...valid, finishedAt: 0 }],
    ['a finish time more than a day ahead', { ...valid, finishedAt: now + day + 1 }],
    ['a finish time the database cannot store', { ...valid, finishedAt: 1e300 }],
  ])('refuses %s', (_, value) => {
    expect(parseResultUpload(value, now)).toBeUndefined();
  });
});

describe('game ids', () => {
  it('makes device ids of 8 characters from the code alphabet, which parse back', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newGameId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(parseGameId(id)).toBe(id);
  });

  it('accepts both forms in any case', () => {
    expect(parseGameId(' abcdefgh ')).toBe('ABCDEFGH');
    expect(parseGameId('ab3k-12')).toBe('AB3K-12');
    expect(onlineGameId('AB3K' as Code, 0)).toBe('AB3K-1');
  });

  it.each(['ABCDEFG', 'ABCDEFGHJ', 'ABCDEFG0', 'AB3K-0', 'AB3K-01', 'AB3K-1e3', 'AB3K-1-2', 'AB0K-1', 'AB3K-', 42])('rejects %j', (input) => {
    expect(parseGameId(input)).toBeUndefined();
  });
});

describe('parseMetrics', () => {
  const valid = {
    device: 'phone',
    view: 'flat',
    layout: 'steps',
    theme: 'synthwave',
    input: { board: 10, keypad: 2 },
    refused: { occupied: 1, 'not-your-turn': 3 },
    undos: 0,
    thinkMs: [12.5, 600],
    offline: true,
    version: 'index-B2x9kQ',
    tuning: null,
    nearby: { role: 'host', other: 'tablet' },
  };

  it('accepts valid metrics', () => {
    expect(parseMetrics(valid)).toEqual(valid);
  });

  it.each([
    ['an unknown key', { ...valid, extra: 1 }],
    ['a missing key', { ...valid, undos: undefined }],
    ['an unknown refusal', { ...valid, refused: { boom: 1 } }],
    ['a negative count', { ...valid, input: { board: -1, keypad: 0 } }],
    ['an extra input key', { ...valid, input: { board: 1, keypad: 0, voice: 1 } }],
    ['too many think times', { ...valid, thinkMs: Array(65).fill(1) }],
    ['a think time out of range', { ...valid, thinkMs: [1e9] }],
    ['an unknown theme', { ...valid, theme: 'neon' }],
    ['a long version', { ...valid, version: 'x'.repeat(65) }],
    ['a version with odd characters', { ...valid, version: '<script>' }],
    ['a broken tuning', { ...valid, tuning: { easy: {} } }],
    ['an unknown Nearby role', { ...valid, nearby: { role: 'boss', other: null } }],
  ])('refuses %s', (_, value) => {
    expect(parseMetrics(value)).toBeUndefined();
  });

  it('refuses a whole upload with invalid metrics', () => {
    const game = toRecord(replay([0, 1, 16, 2, 32, 3, 48]));
    const upload = { id: 'aaaaaaaa-0000-4000-8000-000000000001-ab3k-0', mode: 'friend', game, you: null, difficulty: null, finishedAt: 5 };
    expect(parseResultUpload({ ...upload, metrics: valid }, 10)).toBeDefined();
    expect(parseResultUpload({ ...upload, metrics: { ...valid, extra: true } }, 10)).toBeUndefined();
  });
});

describe('parseResultUpload, game link fields', () => {
  const game = toRecord(replay([0, 1, 16, 2, 32, 3, 48]));
  const valid = { id: 'aaaaaaaa-0000-4000-8000-000000000001-ab3k-0', mode: 'computer', game, you: 'X', difficulty: 'easy', finishedAt: 5 };

  it('keeps a device id, the hide options and the tuned flag', () => {
    const options = { hideBoard: true, hideHistory: false };
    expect(parseResultUpload({ ...valid, publicId: 'ABCDEFGH', options, tuned: true }, 10)).toMatchObject({ publicId: 'ABCDEFGH', options, tuned: true });
  });

  it.each([
    ['an online id', { ...valid, publicId: 'AB3K-1' }],
    ['a lower-case id', { ...valid, publicId: 'abcdefgh' }],
    ['a tuned friend game', { ...valid, mode: 'friend', you: null, difficulty: null, tuned: true }],
    ['bad options', { ...valid, options: { hideBoard: 'yes', hideHistory: false } }],
    ['an unknown key', { ...valid, token: 'x' }],
  ])('refuses %s', (_, value) => {
    expect(parseResultUpload(value, 10)).toBeUndefined();
  });
});

describe('parsePublicGame', () => {
  const valid = {
    id: 'ABCDEFGH',
    mode: 'computer',
    game: toRecord(replay([0, 1, 16, 2, 32, 3, 48])),
    options: { hideBoard: false, hideHistory: true },
    difficulty: 'hard',
    tuned: false,
    computer: 'O',
    players: { X: { login: 'octo', avatar: 'https://avatars.githubusercontent.com/u/7?v=4' }, O: null },
    finishedAt: 1_700_000_000_000,
  };

  it('accepts a finished game', () => {
    expect(parsePublicGame(valid)).toEqual(valid);
  });

  it.each([
    ['an extra field, such as a token', { ...valid, token: 'aaaaaaaa-0000-4000-8000-000000000001' }],
    ['an unfinished game', { ...valid, game: toRecord(replay([0, 1])) }],
    ['a computer game without the computer seat', { ...valid, computer: null }],
    ['a lower-case id', { ...valid, id: 'abcdefgh' }],
  ])('throws on %s', (_, value) => {
    expect(() => parsePublicGame(value)).toThrow();
  });
});

describe('parseHistoryPage', () => {
  const entry = { id: 'AB3K-2', mode: 'online', difficulty: null, result: 'won', moves: 7, opponent: null, finishedAt: 5 };

  it('accepts a page of games', () => {
    expect(parseHistoryPage({ games: [entry], more: false })).toEqual({ games: [entry], more: false });
  });

  it.each([
    ['an unknown result', { games: [{ ...entry, result: 'maybe' }], more: false }],
    ['no more flag', { games: [entry] }],
  ])('throws on %s', (_, value) => {
    expect(() => parseHistoryPage(value)).toThrow();
  });
});

describe('parseClientEvent', () => {
  it('accepts a short fault report', () => {
    const event = { kind: 'rejection', message: 'TypeError: boom', version: 'index-abc' };
    expect(parseClientEvent(event)).toEqual(event);
  });

  it.each([
    { kind: 'crash', message: 'x', version: 'v' },
    { kind: 'error', message: '', version: 'v' },
    { kind: 'error', message: 'x'.repeat(301), version: 'v' },
    { kind: 'error', message: 'x', version: 'v', token: 'secret' },
  ])('refuses %j', (value) => {
    expect(parseClientEvent(value)).toBeUndefined();
  });
});
