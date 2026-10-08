import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_KEY_MAX_LENGTH, createIdempotency, parseIdempotencyKey } from './idempotency.ts';

const answer = { status: 200, body: '{"version":3}', headers: {} };

describe('parseIdempotencyKey', () => {
  it('reads a Structured Field String and a bare key', () => {
    expect(parseIdempotencyKey('"8e03978e-40d5-43e8-bc93-6894a57f9324"')).toBe('8e03978e-40d5-43e8-bc93-6894a57f9324');
    expect(parseIdempotencyKey('move-7')).toBe('move-7');
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
  });

  it('refuses an empty, long, repeated or non-ASCII key', () => {
    for (const bad of ['', '""', 'a b', 'ключ', 'x'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1), ['a', 'b']]) {
      expect(parseIdempotencyKey(bad), String(bad)).toBeInstanceOf(Error);
    }
  });
});

describe('createIdempotency', () => {
  it('runs a new key once, and replays its answer for a repeat', () => {
    const keys = createIdempotency({ ttlMs: 1000, max: 10 });
    const first = keys.claim('player /moves', 'k1', 'POST body-a', 0);
    if (first.kind !== 'run') throw new Error(`expected run, got ${first.kind}`);
    expect(keys.claim('player /moves', 'k1', 'POST body-a', 1).kind).toBe('running');
    first.finish(answer);
    expect(keys.claim('player /moves', 'k1', 'POST body-a', 2)).toEqual({ kind: 'replay', answer });
  });

  it('refuses the same key with another request', () => {
    const keys = createIdempotency({ ttlMs: 1000, max: 10 });
    const first = keys.claim('player /moves', 'k1', 'POST body-a', 0);
    if (first.kind !== 'run') throw new Error(`expected run, got ${first.kind}`);
    first.finish(answer);
    expect(keys.claim('player /moves', 'k1', 'POST body-b', 1).kind).toBe('mismatch');
  });

  it('keeps the keys of each scope apart', () => {
    const keys = createIdempotency({ ttlMs: 1000, max: 10 });
    keys.claim('alice /moves', 'k1', 'POST body-a', 0);
    expect(keys.claim('bob /moves', 'k1', 'POST body-a', 0).kind).toBe('run');
  });

  it('forgets a key after its time, and runs it again', () => {
    const keys = createIdempotency({ ttlMs: 1000, max: 10 });
    const first = keys.claim('player /moves', 'k1', 'POST body-a', 0);
    if (first.kind !== 'run') throw new Error(`expected run, got ${first.kind}`);
    first.finish(answer);
    expect(keys.claim('player /moves', 'k1', 'POST body-a', 999).kind).toBe('replay');
    expect(keys.claim('player /moves', 'k1', 'POST body-b', 1000).kind).toBe('run');
  });

  it('runs a key again after the first request ended without an answer', () => {
    const keys = createIdempotency({ ttlMs: 1000, max: 10 });
    const first = keys.claim('player /moves', 'k1', 'POST body-a', 0);
    if (first.kind !== 'run') throw new Error(`expected run, got ${first.kind}`);
    first.abandon();
    expect(keys.claim('player /moves', 'k1', 'POST body-a', 1).kind).toBe('run');
  });

  it('keeps at most max keys and forgets the oldest first', () => {
    const keys = createIdempotency({ ttlMs: 1000, max: 2 });
    for (const key of ['k1', 'k2', 'k3']) keys.claim('player /moves', key, 'POST', 0);
    expect(keys.size()).toBe(2);
    expect(keys.claim('player /moves', 'k1', 'POST', 1).kind).toBe('run');
  });
});
