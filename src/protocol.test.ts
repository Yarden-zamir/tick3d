import { describe, expect, it } from 'vitest';
import { replay } from './game.ts';
import {
  normalizeChat,
  normalizeCode,
  parsePlayerInfo,
  parseResultUpload,
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
    expect(parseResultUpload(valid, now)).toEqual(valid);
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
