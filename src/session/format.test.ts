import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CURRENT_FORMAT, FormatError, type Upgrade, parseDoc } from './format.ts';

const formatOne: unknown = JSON.parse(readFileSync(new URL('./fixtures/format-1.json', import.meta.url), 'utf8'));

describe('parseDoc', () => {
  // A stored document of every released format must keep reading. Never edit a fixture; add one per format.
  it('reads a stored format 1 document', () => {
    const doc = parseDoc(formatOne);
    expect(doc.format).toBe(CURRENT_FORMAT);
    expect(doc.name).toBe('Friday rematch');
    expect(doc.games.map((game) => game.moves.length)).toEqual([7, 3, 0]);
    expect(doc.games[1]?.timedOut).toBe(true);
    expect(doc.seats.O).toBe('bbbbbbbb-0000-4000-8000-000000000002');
    // The fixture is from before hide coordinates: the missing field reads as false.
    expect(doc.options).toEqual({ hideBoard: true, hideHistory: false, hideCoordinates: false });
  });

  it('fills defaults for optional fields that an older writer left out', () => {
    const doc = parseDoc({ name: 'Minimal', games: [{ moves: [5] }], seats: {} });
    expect(doc).toEqual({
      format: CURRENT_FORMAT,
      mode: 'online',
      computer: null,
      chat: [],
      name: 'Minimal',
      games: [{ moves: [5], times: [0], clock: { perMove: null, perGame: null }, timedOut: false }],
      seats: { X: null, O: null },
      options: { hideBoard: false, hideHistory: false, hideCoordinates: false },
      lockedGame: null,
      clock: { perMove: null, perGame: null },
      playoff: null,
      seatRequest: null,
    });
  });

  it('reads a stored playoff, and refuses a broken one', () => {
    const playoff = { id: 1, seed: 7, preset: 'easy', by: 'X', seats: { X: { joined: true, times: [1200] }, O: { joined: true, times: [] } }, startAt: 5000, ended: null };
    expect(parseDoc({ name: 'With playoff', games: [{ moves: [] }], playoff }).playoff).toEqual(playoff);
    expect(() => parseDoc({ name: 'Broken', games: [{ moves: [] }], playoff: { ...playoff, preset: 'insane' } })).toThrow();
  });

  it('reads a seat request, and a stored document from before seat controls as having none', () => {
    expect(parseDoc(formatOne).seatRequest).toBeNull();
    const request = { kind: 'replace', from: 'X', watcher: 'cccccccc-0000-4000-8000-000000000003', at: 5 };
    expect(parseDoc({ ...(formatOne as object), seatRequest: request }).seatRequest).toEqual(request);
    expect(() => parseDoc({ ...(formatOne as object), seatRequest: { ...request, kind: 'leave' } })).toThrow(FormatError);
    expect(() => parseDoc({ ...(formatOne as object), seatRequest: { ...request, watcher: null } })).toThrow(FormatError);
  });

  it('runs the upgrade steps in order up to the current format', () => {
    // A pretend format 1 to 3 history: format 2 renamed `title` to `name`, format 3 added nothing.
    const steps: Record<number, Upgrade> = {
      1: ({ title, ...rest }) => ({ ...rest, name: title }),
      2: (doc) => doc,
    };
    const doc = parseDoc({ format: 1, title: 'Old name', games: [{ moves: [] }] }, steps, 3);
    expect(doc.name).toBe('Old name');
  });

  it('refuses a document from a newer version, so an old server never overwrites it', () => {
    expect(() => parseDoc({ ...(formatOne as object), format: CURRENT_FORMAT + 1 })).toThrow(FormatError);
  });

  it('refuses a stored game that does not replay, so it never breaks every later load', () => {
    const doc = formatOne as { games: object[] };
    const [won, ...rest] = doc.games;
    // The first game of the fixture is won by X. A timeout after the end is impossible.
    expect(() => parseDoc({ ...doc, games: [{ ...won, timedOut: true }, ...rest] })).toThrow(FormatError);
  });

  it.each([
    ['no name', { games: [{ moves: [] }] }],
    ['no games', { name: 'x', games: [] }],
    ['an illegal move list', { name: 'x', games: [{ moves: [64] }] }],
    ['a cell played twice', { name: 'x', games: [{ moves: [5, 5] }] }],
    ['an invalid clock', { name: 'x', games: [{ moves: [] }], clock: { perMove: 1, perGame: null } }],
  ])('throws on %s', (_, doc) => {
    expect(() => parseDoc(doc)).toThrow(FormatError);
  });
});
