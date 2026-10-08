import { describe, expect, it } from 'vitest';
import { PLAYOFF_COUNTDOWN_MS, PLAYOFF_TARGETS, type Playoff, PlayoffError, applyPlayoff, parsePlayoff, parsePlayoffRequest, playoffWinner } from './playoff.ts';

const start = { action: 'start', preset: 'normal', seed: 99 } as const;

function running(): Playoff {
  const started = applyPlayoff(null, 'X', true, start, 0);
  const joined = applyPlayoff(started, 'O', true, { action: 'join', id: 1 }, 1000);
  if (joined === null) throw new Error('no playoff');
  return joined;
}

function hitAll(playoff: Playoff, seat: 'X' | 'O', ms: number, at: number): Playoff {
  let next: Playoff | null = playoff;
  for (let index = 0; index < PLAYOFF_TARGETS; index++) next = applyPlayoff(next, seat, true, { action: 'hit', id: playoff.id, index, ms }, at);
  if (next === null) throw new Error('no playoff');
  return next;
}

describe('playoff rules', () => {
  it('starts with the starter joined, and counts down once both joined', () => {
    const started = applyPlayoff(null, 'X', true, start, 0);
    expect(started).toMatchObject({ id: 1, seed: 99, preset: 'normal', by: 'X', startAt: null, ended: null });
    expect(started?.seats).toEqual({ X: { joined: true, times: [] }, O: { joined: false, times: [] } });
    expect(running().startAt).toBe(1000 + PLAYOFF_COUNTDOWN_MS);
    expect(() => applyPlayoff(null, 'X', false, start, 0)).toThrow(PlayoffError);
  });

  it('takes hits in order after the start, and the faster total wins', () => {
    const playoff = running();
    const at = (playoff.startAt ?? 0) + 1;
    expect(() => applyPlayoff(playoff, 'X', true, { action: 'hit', id: 1, index: 0, ms: 900 }, 2000)).toThrow(PlayoffError);
    expect(() => applyPlayoff(playoff, 'X', true, { action: 'hit', id: 1, index: 1, ms: 900 }, at)).toThrow(PlayoffError);
    const xDone = hitAll(playoff, 'X', 900, at);
    expect(xDone.ended).toBeNull();
    // A repeat of a hit changes nothing.
    expect(applyPlayoff(xDone, 'X', true, { action: 'hit', id: 1, index: 0, ms: 5 }, at)).toBe(xDone);
    const done = hitAll(xDone, 'O', 1000, at);
    expect(done.ended).toBe('done');
    expect(playoffWinner(done)).toBe('X');
    expect(playoffWinner(xDone)).toBeNull();
  });

  it('ends as declined when the invited player says not now, and as left after a join', () => {
    const started = applyPlayoff(null, 'X', true, start, 0);
    expect(applyPlayoff(started, 'O', true, { action: 'leave', id: 1 }, 10)?.ended).toBe('declined');
    expect(applyPlayoff(running(), 'O', true, { action: 'leave', id: 1 }, 10)?.ended).toBe('left');
  });

  it('ignores a request for an older playoff, and refuses a new start while one runs', () => {
    const playoff = running();
    expect(applyPlayoff(playoff, 'O', true, { action: 'leave', id: 0 }, 10)).toBe(playoff);
    expect(() => applyPlayoff(playoff, 'O', true, start, 5000)).toThrow(PlayoffError);
    const ended = applyPlayoff(playoff, 'O', true, { action: 'leave', id: 1 }, 10);
    expect(applyPlayoff(ended, 'O', true, start, 20)?.id).toBe(2);
  });
});

describe('playoff checks', () => {
  it('reads back a playoff and refuses broken ones', () => {
    const playoff = running();
    expect(parsePlayoff(JSON.parse(JSON.stringify(playoff)))).toEqual(playoff);
    expect(parsePlayoff({ ...playoff, by: 'Z' })).toBeUndefined();
    expect(parsePlayoff({ ...playoff, seats: { X: { joined: true, times: [-1] }, O: playoff.seats.O } })).toBeUndefined();
  });

  it('takes only the four request shapes', () => {
    expect(parsePlayoffRequest(start)).toEqual(start);
    expect(parsePlayoffRequest({ action: 'hit', id: 1, index: 9, ms: 1500 })).toEqual({ action: 'hit', id: 1, index: 9, ms: 1500 });
    for (const bad of [null, {}, { action: 'cheat' }, { action: 'start', preset: 'normal' }, { action: 'join' }, { action: 'hit', id: 1, index: PLAYOFF_TARGETS, ms: 1 }]) {
      expect(parsePlayoffRequest(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
