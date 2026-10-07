import { describe, expect, it } from 'vitest';
import { toEpochMs as ms } from './epoch.ts';
import { replay } from './game.ts';
import {
  asPlayerToken,
  normalizeChat,
  normalizeCode,
  parsePlayerInfo,
  parsePreviews,
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
  parseCustomName,
  parseSeatAction,
  parseSeatAnswer,
  toRecord,
} from './protocol.ts';

describe('asPlayerToken', () => {
  it('accepts a browser token and refuses an account token, because a GitHub id is public', () => {
    expect(asPlayerToken('aaaaaaaa-0000-4000-8000-000000000001')).toBe('aaaaaaaa-0000-4000-8000-000000000001');
    expect(asPlayerToken('account-0000000000000101')).toBeUndefined();
  });
});

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
    options: { hideBoard: true, hideHistory: false, hideCoordinates: true },
    locked: false,
    clock: { perMove: 30, perGame: 300 },
    now: 30,
    version: 2,
    chat: [{ id: 7, from: 'O', text: 'good luck', at: 1_700_000_000_000 }],
    presence: { X: true, O: false },
    players: { X: { login: 'octo', avatar: 'https://avatars.githubusercontent.com/u/7?v=4' }, O: null },
    names: { X: 'braveOtter', O: null },
    watchers: [{ id: '0123456789abcdef', name: 'Carol', player: null }],
    youWatcher: '0123456789abcdef',
    seatRequest: { kind: 'replace', from: 'X', watcher: { name: 'Carol', player: null }, expiresAt: 90 },
    turn: 'X',
    status: { kind: 'playing' },
  };

  it('accepts a valid view', () => {
    expect(parseSessionView(valid)).toEqual(valid);
  });

  it('reads hideCoordinates as false when an older sender has no such field', () => {
    const older = { ...valid, options: { hideBoard: true, hideHistory: false } };
    expect(parseSessionView(older).options).toEqual({ hideBoard: true, hideHistory: false, hideCoordinates: false });
  });

  it('gives no names when a sender has no names field', () => {
    const { names: _names, ...older } = valid;
    expect(parseSessionView(older).names).toEqual({ X: null, O: null });
  });

  it('gives no watchers and no seat request when a sender is from before seat controls', () => {
    const { watchers: _watchers, youWatcher: _you, seatRequest: _request, ...older } = valid;
    expect(parseSessionView(older)).toMatchObject({ watchers: [], youWatcher: null, seatRequest: null });
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
    ['options', { ...valid, options: { hideBoard: true, hideHistory: false, hideCoordinates: 'yes' } }],
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
    ['names', { ...valid, names: { X: '', O: null } }],
    ['names', { ...valid, names: { X: 'a'.repeat(41), O: null } }],
    ['names', { ...valid, names: { X: 'braveOtter' } }],
    ['names', { ...valid, names: null }],
    // A watcher id is an opaque handle, never a player token.
    ['watchers', { ...valid, watchers: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Carol', player: null }] }],
    ['watchers', { ...valid, watchers: [{ id: '0123456789abcdef', name: '', player: null }] }],
    ['watchers', { ...valid, watchers: null }],
    ['youWatcher', { ...valid, youWatcher: 'aaaaaaaa-0000-4000-8000-000000000001' }],
    ['seatRequest', { ...valid, seatRequest: { ...valid.seatRequest, kind: 'leave' } }],
    ['seatRequest', { ...valid, seatRequest: { ...valid.seatRequest, watcher: null } }],
    ['seatRequest', { ...valid, seatRequest: { kind: 'swap', from: 'X', watcher: { name: 'Carol', player: null }, expiresAt: 90 } }],
  ])('throws on a bad %s field', (_, input) => {
    expect(() => parseSessionView(input)).toThrow();
  });
});

describe('parseSessionUpdate', () => {
  it('accepts a name and match options', () => {
    expect(parseSessionUpdate({ name: ' Rematch ', hideBoard: true })).toEqual({ name: 'Rematch', hideBoard: true });
    expect(parseSessionUpdate({ hideHistory: false })).toEqual({ hideHistory: false });
    expect(parseSessionUpdate({ hideCoordinates: true })).toEqual({ hideCoordinates: true });
    expect(parseSessionUpdate({ clock: { perMove: 30, perGame: null } })).toEqual({ clock: { perMove: 30, perGame: null } });
  });

  it.each([{}, { name: '' }, { hideBoard: 'true' }, { hideCoordinates: 1 }, { locked: true }, { clock: { perMove: 2, perGame: null } }, null])('rejects %j', (input) => {
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
    expect(parseResultUpload(valid, ms(now))).toEqual({ ...valid, publicId: null, options: { hideBoard: false, hideHistory: false, hideCoordinates: false }, tuned: false, metrics: null, guest: null });
    expect(parseResultUpload({ ...valid, mode: 'friend', you: null, difficulty: null }, ms(now))).toBeDefined();
    expect(parseResultUpload({ ...valid, finishedAt: now + day }, ms(now))).toBeDefined();
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
    ['a finish time with a fraction of a millisecond', { ...valid, finishedAt: 1.5 }],
  ])('refuses %s', (_, value) => {
    expect(parseResultUpload(value, ms(now))).toBeUndefined();
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
    expect(parseResultUpload({ ...upload, metrics: valid }, ms(10))).toBeDefined();
    expect(parseResultUpload({ ...upload, metrics: { ...valid, extra: true } }, ms(10))).toBeUndefined();
  });
});

describe('parseResultUpload, the guest of a Nearby host', () => {
  const game = toRecord(replay([0, 1, 16, 2, 32, 3, 48]));
  const guest = 'bbbbbbbb-0000-4000-8000-000000000002';
  const nearby = { id: 'aaaaaaaa-0000-4000-8000-000000000001-ab3k-0', mode: 'nearby', game, you: 'X', difficulty: null, finishedAt: 5 };

  it('keeps the guest token of a Nearby game', () => {
    expect(parseResultUpload({ ...nearby, guest }, ms(10))?.guest).toBe(guest);
  });

  it.each([
    ['a guest in a computer game', { ...nearby, mode: 'computer', difficulty: 'easy', guest }],
    ['a guest in a friend game', { ...nearby, mode: 'friend', you: null, guest }],
    ['a guest that is not a token', { ...nearby, guest: 'Not a token!' }],
  ])('refuses %s', (_, value) => {
    expect(parseResultUpload(value, ms(10))).toBeUndefined();
  });
});

describe('parseResultUpload, game link fields', () => {
  const game = toRecord(replay([0, 1, 16, 2, 32, 3, 48]));
  const valid = { id: 'aaaaaaaa-0000-4000-8000-000000000001-ab3k-0', mode: 'computer', game, you: 'X', difficulty: 'easy', finishedAt: 5 };

  it('keeps a device id, the hide options and the tuned flag', () => {
    const options = { hideBoard: true, hideHistory: false, hideCoordinates: true };
    expect(parseResultUpload({ ...valid, publicId: 'ABCDEFGH', options, tuned: true }, ms(10))).toMatchObject({ publicId: 'ABCDEFGH', options, tuned: true });
  });

  it('reads hide options from an older device, without hideCoordinates, as not hidden', () => {
    const older = { ...valid, options: { hideBoard: true, hideHistory: false } };
    expect(parseResultUpload(older, ms(10))?.options).toEqual({ hideBoard: true, hideHistory: false, hideCoordinates: false });
  });

  it.each([
    ['an online id', { ...valid, publicId: 'AB3K-1' }],
    ['a lower-case id', { ...valid, publicId: 'abcdefgh' }],
    ['a tuned friend game', { ...valid, mode: 'friend', you: null, difficulty: null, tuned: true }],
    ['bad options', { ...valid, options: { hideBoard: 'yes', hideHistory: false } }],
    ['an unknown key', { ...valid, token: 'x' }],
  ])('refuses %s', (_, value) => {
    expect(parseResultUpload(value, ms(10))).toBeUndefined();
  });
});

describe('parsePublicGame', () => {
  const valid = {
    id: 'ABCDEFGH',
    mode: 'computer',
    game: toRecord(replay([0, 1, 16, 2, 32, 3, 48])),
    options: { hideBoard: false, hideHistory: true, hideCoordinates: false },
    difficulty: 'hard',
    tuned: false,
    computer: 'O',
    players: { X: { login: 'octo', avatar: 'https://avatars.githubusercontent.com/u/7?v=4' }, O: null },
    names: { X: 'braveOtter', O: null },
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
    ['no names', { ...valid, names: undefined }],
    ['an empty name', { ...valid, names: { X: '', O: null } }],
  ])('throws on %s', (_, value) => {
    expect(() => parsePublicGame(value)).toThrow();
  });
});

describe('parseHistoryPage', () => {
  const entry = { id: 'AB3K-2', mode: 'online', difficulty: null, result: 'won', moves: 7, opponent: null, opponentName: 'braveOtter', finishedAt: 5 };

  it('accepts a page of games', () => {
    expect(parseHistoryPage({ games: [entry], more: false })).toEqual({ games: [entry], more: false });
  });

  it.each([
    ['an unknown result', { games: [{ ...entry, result: 'maybe' }], more: false }],
    ['no more flag', { games: [entry] }],
    ['an empty opponent name', { games: [{ ...entry, opponentName: '' }], more: false }],
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

describe('seat requests', () => {
  it('reads every action, with a watcher id where the action needs one', () => {
    expect(parseSeatAction({ action: 'swap' })).toEqual({ action: 'swap' });
    expect(parseSeatAction({ action: 'give', watcher: '0123456789abcdef' })).toEqual({ action: 'give', watcher: '0123456789abcdef' });
    expect(parseSeatAnswer({ accept: false })).toEqual({ accept: false });
  });

  it.each([
    { action: 'kick' },
    { action: 'swap', watcher: '0123456789abcdef' },
    { action: 'seat' },
    { action: 'replace', watcher: 'aaaaaaaa-0000-4000-8000-000000000001' },
    { action: 'leave', extra: true },
    null,
  ])('refuses the seat action %j', (input) => {
    expect(parseSeatAction(input)).toBeUndefined();
  });

  it.each([{}, { accept: 'yes' }, { accept: true, extra: 1 }])('refuses the answer %j', (input) => {
    expect(parseSeatAnswer(input)).toBeUndefined();
  });
});

describe('parseCustomName', () => {
  it('trims, joins inner spaces, and allows letters of any script, digits, "-" and "_"', () => {
    expect(parseCustomName('  Dana   the_3rd ')).toBe('Dana the_3rd');
    expect(parseCustomName('יַרְדֵּן')).toBe('יַרְדֵּן');
    expect(parseCustomName('Zoë-K')).toBe('Zoë-K');
    expect(parseCustomName('a'.repeat(24))).toBe('a'.repeat(24));
  });

  it.each(['a', 'a'.repeat(25), '<b>bold</b>', 'name!', '___', '  ', 42, null])('refuses %j', (input) => {
    expect(parseCustomName(input)).toBeUndefined();
  });
});

describe('parsePreviews', () => {
  const preview = (number: number, parent: unknown) => ({
    number,
    title: `Pull ${number}`,
    description: '',
    url: `https://github.com/octo/game/pull/${number}`,
    previewUrl: `https://pr.${number}.game.example.com`,
    updatedAt: 0,
    draft: false,
    contributors: [],
    parent,
  });
  const answer = (previews: unknown[]) => ({ main: 'https://game.example.com', previews, error: null });

  it('keeps the parent of a stacked pull request through a round trip', () => {
    const list = answer([preview(1, null), preview(2, 1)]);
    expect(parsePreviews(JSON.parse(JSON.stringify(parsePreviews(list))))).toEqual(list);
  });

  it.each([0, -1, 1.5, '1', 2])('refuses the parent %j', (parent) => {
    expect(() => parsePreviews(answer([preview(2, parent)]))).toThrow();
  });
});
