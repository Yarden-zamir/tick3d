import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asHostId } from '../src/nearby/lobby.ts';
import { decodeSignal } from '../src/nearby/signal.ts';
import type { PlayerToken } from '../src/protocol.ts';
import { ROUTES } from './api-docs.ts';
import { LobbyError, createLobby, networkOf } from './lobby.ts';

const HOST = 'host-aaaaaaaaaaaaaaaa' as PlayerToken;
const GUEST = 'guest-bbbbbbbbbbbbbbbb' as PlayerToken;
const HOME = '203.0.113.7';
const OTHER = '198.51.100.9';
const WAIT_MS = 25_000;
const GRACE_MS = 10_000;
const hello = { device: 'computer', name: 'Laptop' } as const;

const newLobby = (limits: { perNetwork?: number; total?: number } = {}) =>
  createLobby({ perNetwork: limits.perNetwork ?? 3, total: limits.total ?? 10, waitMs: WAIT_MS, graceMs: GRACE_MS });

function announce(lobby: ReturnType<typeof newLobby>, fields: { network?: string; token?: PlayerToken; offer?: string; id?: string } = {}) {
  const left = new AbortController();
  const id = fields.id === undefined ? undefined : asHostId(fields.id);
  const held = lobby.announce(
    { id, token: fields.token ?? HOST, network: fields.network ?? HOME, hello, offer: fields.offer ?? 'T3A1.offer-1' },
    left.signal,
  );
  return { ...held, leave: () => left.abort() };
}

// A host as the page runs it: a new announcement, then a held request with the id.
function hold(lobby: ReturnType<typeof newLobby>, fields: { network?: string; token?: PlayerToken; offer?: string } = {}) {
  const { id } = announce(lobby, fields);
  return announce(lobby, { ...fields, id });
}

const status = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof LobbyError) return error.status;
    throw error;
  }
  return 'ok';
};

describe('networkOf', () => {
  it('matches an IPv4 address exactly', () => {
    expect(networkOf('203.0.113.8')).not.toBe(networkOf(HOME));
    // An IPv4 client on an IPv6 socket is the same client.
    expect(networkOf(`::ffff:${HOME}`)).toBe(networkOf(HOME));
  });

  it('matches IPv6 addresses by their /64 prefix, in any notation', () => {
    const phone = networkOf('2001:db8:aa:1:1111:2222:3333:4444');
    expect(networkOf('2001:0DB8:00aa:0001::9')).toBe(phone);
    expect(networkOf('2001:db8:aa:1::1%eth0')).toBe(phone);
    expect(networkOf('2001:db8:aa:2:1111:2222:3333:4444')).not.toBe(phone);
    expect(networkOf('2001:db8::1')).toBe(networkOf('2001:db8:0:0:ffff::2'));
    expect(networkOf('64:ff9b::192.0.2.1')).toBe(networkOf('64:ff9b::1'));
  });

  it('knows no network for a value that is not an address', () => {
    expect(networkOf('unknown')).toBeUndefined();
    expect(networkOf('')).toBeUndefined();
  });
});

describe('the Nearby lobby', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists a host only on its own network, never to the host itself, and never with a player id', () => {
    const lobby = newLobby();
    const { id } = announce(lobby);
    expect(lobby.list(HOME, GUEST)).toEqual([{ id, name: 'Laptop', device: 'computer', age: 0, offer: 'T3A1.offer-1' }]);
    expect(lobby.list(HOME, undefined)).toHaveLength(1);
    expect(lobby.list(OTHER, GUEST)).toEqual([]);
    expect(lobby.list(HOME, HOST)).toEqual([]);
    expect(JSON.stringify(lobby.list(HOME, GUEST))).not.toContain(HOST);
  });

  it('answers a new announcement at once with its id, and holds the next request', async () => {
    const lobby = newLobby();
    const first = announce(lobby);
    expect(await first.answer).toBeNull();
    let answered = false;
    void announce(lobby, { id: first.id }).answer.then(() => (answered = true));
    await vi.advanceTimersByTimeAsync(WAIT_MS - 1);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(answered).toBe(true);
  });

  it('removes a host at once when its held request closes early', () => {
    const lobby = newLobby();
    const host = hold(lobby);
    host.leave();
    expect(lobby.list(HOME, GUEST)).toEqual([]);
    expect(lobby.count()).toBe(0);
  });

  it('keeps a host for the grace time after a wait ends, and then removes it', async () => {
    const lobby = newLobby();
    const host = hold(lobby);
    vi.advanceTimersByTime(WAIT_MS);
    expect(await host.answer).toBeNull();
    vi.advanceTimersByTime(GRACE_MS - 1000);
    expect(lobby.list(HOME, GUEST)).toHaveLength(1);
    expect(lobby.list(HOME, GUEST)[0]?.age).toBe((WAIT_MS + GRACE_MS - 1000) / 1000);
    vi.advanceTimersByTime(1000);
    expect(lobby.list(HOME, GUEST)).toEqual([]);
    // The host comes back too late: its id is gone, so it announces again without one.
    expect(status(() => announce(lobby, { id: host.id }))).toBe(404);
  });

  it('keeps the entry and its id while the host sends its next request in time', async () => {
    const lobby = newLobby();
    const first = hold(lobby);
    vi.advanceTimersByTime(WAIT_MS);
    await first.answer;
    vi.advanceTimersByTime(GRACE_MS - 1);
    const next = announce(lobby, { id: first.id });
    expect(next.id).toBe(first.id);
    vi.advanceTimersByTime(WAIT_MS - 1);
    expect(lobby.list(HOME, GUEST)).toHaveLength(1);
  });

  it('passes an answer to the open request, and hides the used offer until a fresh one comes', async () => {
    const lobby = newLobby();
    const host = hold(lobby);
    lobby.answer(host.id, HOME, 'T3A1.offer-1', 'T3B1.answer-1');
    expect(await host.answer).toBe('T3B1.answer-1');
    expect(lobby.list(HOME, GUEST)).toEqual([]);
    expect(status(() => lobby.answer(host.id, HOME, 'T3A1.offer-1', 'T3B1.answer-2'))).toBe(409);
    // The same offer again does not count as fresh.
    announce(lobby, { id: host.id });
    expect(lobby.list(HOME, GUEST)).toEqual([]);
    announce(lobby, { id: host.id, offer: 'T3A1.offer-2' });
    expect(lobby.list(HOME, GUEST).map((entry) => entry.offer)).toEqual(['T3A1.offer-2']);
    // An answer to the old offer cannot connect, so the fresh offer stays free for the next guest.
    expect(status(() => lobby.answer(host.id, HOME, 'T3A1.offer-1', 'T3B1.answer-3'))).toBe(409);
    expect(lobby.list(HOME, GUEST)).toHaveLength(1);
  });

  it('keeps an answer that comes between two requests for the next request', async () => {
    const lobby = newLobby();
    const first = hold(lobby);
    vi.advanceTimersByTime(WAIT_MS);
    await first.answer;
    lobby.answer(first.id, HOME, 'T3A1.offer-1', 'T3B1.answer-1');
    expect(await announce(lobby, { id: first.id }).answer).toBe('T3B1.answer-1');
  });

  it('refuses an answer from another network, and a host id of another player', () => {
    const lobby = newLobby();
    const host = announce(lobby);
    expect(status(() => lobby.answer(host.id, OTHER, 'T3A1.offer-1', 'T3B1.answer-1'))).toBe(404);
    expect(status(() => announce(lobby, { id: host.id, token: GUEST }))).toBe(404);
    expect(status(() => announce(lobby, { id: host.id, network: OTHER }))).toBe(404);
    expect(lobby.list(HOME, GUEST)).toHaveLength(1);
  });

  it('caps the games per network and in total', () => {
    const lobby = newLobby({ perNetwork: 2, total: 3 });
    announce(lobby);
    announce(lobby);
    expect(status(() => announce(lobby))).toBe(429);
    announce(lobby, { network: OTHER });
    expect(status(() => announce(lobby, { network: '192.0.2.1' }))).toBe(503);
    expect(lobby.count()).toBe(3);
  });

  it('ends an open request when the same host sends a new one', async () => {
    const lobby = newLobby();
    const first = hold(lobby);
    const second = announce(lobby, { id: first.id });
    expect(await first.answer).toBeNull();
    // The first request closes after the second one replaced it. That does not remove the host.
    first.leave();
    lobby.answer(second.id, HOME, 'T3A1.offer-1', 'T3B1.answer-1');
    expect(await second.answer).toBe('T3B1.answer-1');
  });
});

describe('the documented Nearby examples', () => {
  it('are real signal codes', async () => {
    const offer = ROUTES['POST /api/nearby/hosts'].body.example.offer;
    const answer = ROUTES['POST /api/nearby/hosts/{host}/answer'].body.example.answer;
    expect((await decodeSignal(offer)).kind).toBe('offer');
    expect((await decodeSignal(answer)).kind).toBe('answer');
    const listed = ROUTES['GET /api/nearby/hosts'].response.example.hosts[0];
    expect((await decodeSignal(listed?.offer ?? '')).hello).toEqual({ device: listed?.device, name: listed?.name });
  });
});
