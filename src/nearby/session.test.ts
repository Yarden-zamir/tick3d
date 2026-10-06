import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { openDeviceDb } from '../device-db.ts';
import { createLocalBackend } from '../local.ts';
import type { PlayerToken } from '../protocol.ts';
import { createNearbyGuest, createNearbyHost } from './session.ts';
import { channelPair } from './testing.ts';

const host = 'aaaaaaaa-0000-4000-8000-000000000001' as PlayerToken;
const guest = 'bbbbbbbb-0000-4000-8000-000000000002' as PlayerToken;
const watcher = 'cccccccc-0000-4000-8000-000000000003' as PlayerToken;
const phone = { device: 'phone' as const, name: 'Guest phone' };

async function setup() {
  const local = createLocalBackend(await openDeviceDb(new IDBFactory(), 'nearby'), host, () => null);
  const view = await local.create({ mode: 'nearby', name: 'Nearby', clock: { perMove: null, perGame: null }, human: 'X' });
  const nearby = createNearbyHost(local, view.code, host, () => 'Host laptop');
  const connect = (token: PlayerToken) => {
    const [hostSide, guestSide] = channelPair();
    nearby.addGuest(hostSide, phone);
    let bye = '';
    const backend = createNearbyGuest(guestSide, token, (reason) => (bye = reason));
    return { backend, bye: () => bye, close: () => guestSide.close() };
  };
  return { local, nearby, code: view.code, connect };
}

describe('Nearby host and guest', () => {
  it('seats the first guest as O, plays a game across the channel, and lets a second guest watch', async () => {
    const { local, nearby, code, connect } = await setup();
    const first = connect(guest);
    const joined = await first.backend.join(code);
    expect(joined.you).toBe('O');
    expect((await local.load(code)).presence).toEqual({ X: true, O: true });
    await local.move(code, { game: 0, moveCount: 0, cell: 0 });
    expect((await first.backend.move(code, { game: 0, moveCount: 1, cell: 1 })).games[0]?.moves).toEqual([0, 1]);
    expect(await nearby.guests()).toEqual([{ hello: phone, seat: 'O' }]);
    const second = connect(watcher);
    await expect(second.backend.join(code)).rejects.toMatchObject({ status: 409 });
    expect((await second.backend.load(code)).you).toBeNull();
  });

  it('never lets a guest act for the host seat, and refuses bad arguments', async () => {
    const { code, connect } = await setup();
    const sneaky = connect(host);
    await expect(sneaky.backend.join(code)).rejects.toMatchObject({ status: 400 });
    const first = connect(guest);
    await first.backend.join(code);
    await expect(first.backend.move(code, { game: 0, moveCount: 0, cell: 0 })).rejects.toMatchObject({ status: 409 });
    await expect(first.backend.move(code, { game: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(first.backend.update(code, { evil: true })).rejects.toMatchObject({ status: 400 });
  });

  it('tells guests about changes, and shows a guest as away once its channel closes', async () => {
    const { local, code, connect } = await setup();
    const first = connect(guest);
    await first.backend.join(code);
    let changes = 0;
    first.backend.subscribe(code, () => changes++);
    await local.chat(code, 'hello from the host');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changes).toBeGreaterThan(0);
    expect((await first.backend.load(code)).chat.at(-1)).toMatchObject({ from: 'X', text: 'hello from the host' });
    first.close();
    expect((await local.load(code)).presence).toEqual({ X: true, O: false });
  });

  it('says goodbye to guests when the host stops', async () => {
    const { nearby, code, connect } = await setup();
    const first = connect(guest);
    await first.backend.join(code);
    nearby.stop('The host ended the game.');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(first.bye()).toBe('The host ended the game.');
  });

  it('does not run a guest call that arrives after the host stops', async () => {
    const { local, nearby, code, connect } = await setup();
    const first = connect(guest);
    await first.backend.join(code);
    nearby.stop('The host ended the game.');
    await expect(first.backend.chat(code, 'too late')).rejects.toMatchObject({ status: 503 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await local.load(code)).chat.some((message) => message.text === 'too late')).toBe(false);
  });

  it('does not report a goodbye when the guest leaves on purpose', async () => {
    const { code, connect } = await setup();
    const first = connect(guest);
    await first.backend.join(code);
    first.backend.close();
    expect(first.bye()).toBe('');
  });

  it('lets players change seats over the channel, with the other player asked first, and lists watchers by device name', async () => {
    const { local, code, connect } = await setup();
    const first = connect(guest);
    await first.backend.join(code);
    const second = connect(watcher);
    const watching = await second.backend.load(code);
    expect(watching.you).toBeNull();
    const [listed] = (await local.load(code)).watchers;
    expect(listed).toEqual({ id: expect.stringMatching(/^[0-9a-f]{16}$/), name: phone.name, player: null });
    expect(JSON.stringify(watching)).not.toContain(watcher);
    // Each device sees its own watcher id only.
    expect((await second.backend.load(code)).youWatcher).toBe(listed?.id);
    expect((await first.backend.load(code)).youWatcher).toBeNull();
    expect((await local.load(code)).youWatcher).toBeNull();
    // The guest on O asks to swap. The host accepts.
    expect((await first.backend.seat(code, { action: 'swap' })).seatRequest).toMatchObject({ kind: 'swap', from: 'O' });
    expect((await local.answerSeat(code, true)).you).toBe('O');
    expect((await first.backend.load(code)).you).toBe('X');
    // The host gives its seat to the watcher without asking, and then watches.
    if (listed === undefined) throw new Error('no watcher');
    expect((await local.seat(code, { action: 'give', watcher: listed.id })).you).toBeNull();
    expect((await second.backend.load(code)).you).toBe('O');
    expect((await local.load(code)).names.O).toBe(phone.name);
    // The guest on X moves and asks to undo. The watcher on O now accepts over the channel.
    await first.backend.move(code, { game: 0, moveCount: 0, cell: 5 });
    expect((await first.backend.seat(code, { action: 'undo' })).seatRequest).toMatchObject({ kind: 'undo' });
    expect((await second.backend.answerSeat(code, true)).games[0]?.moves).toEqual([]);
    // A bad argument is refused, and an answer needs an open request.
    await expect(first.backend.seat(code, { action: 'kick' } as never)).rejects.toMatchObject({ status: 400 });
    await expect(first.backend.answerSeat(code, true)).rejects.toMatchObject({ status: 409 });
  });
});
