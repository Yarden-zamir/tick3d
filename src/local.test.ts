import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDeviceDb } from './device-db.ts';
import { createLocalBackend } from './local.ts';
import type { Code, PlayerToken } from './protocol.ts';

const token = 'aaaaaaaa-0000-4000-8000-000000000001' as PlayerToken;
const clock = { perMove: null, perGame: null };

async function setup() {
  const db = await openDeviceDb(new IDBFactory(), 'local');
  return { db, local: createLocalBackend(db, token, () => null) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLocalBackend', () => {
  it('lists the sessions that parse and leaves out a damaged one', async () => {
    const { db, local } = await setup();
    const friend = await local.create({ mode: 'friend', name: 'Friend game', clock, human: 'X' });
    await db.put('sessions', { code: 'ZZZZ' as Code, doc: { format: 'garbage' }, version: 1, updatedAt: Date.now() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const list = await local.list();
    expect(list.map((entry) => entry.code)).toEqual([friend.code]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('prunes old sessions without a move, except played, fresh and kept ones', async () => {
    const { db, local } = await setup();
    const age = 9 * 3_600_000;
    const make = async (moves: boolean, old: boolean) => {
      const view = await local.create({ mode: 'friend', name: 'Friend game', clock, human: 'X' });
      if (moves) await local.move(view.code, { game: 0, moveCount: 0, cell: 5 });
      const row = await db.get('sessions', view.code);
      if (row === undefined) throw new Error('the session was not stored');
      if (old) await db.put('sessions', { ...row, updatedAt: Date.now() - age - 1000 });
      return view.code;
    };
    const emptyOld = await make(false, true);
    const playedOld = await make(true, true);
    const emptyFresh = await make(false, false);
    const kept = await make(false, true);
    await local.pruneEmpty(age, kept);
    const left = (await local.list()).map((entry) => entry.code).sort();
    expect(left).toEqual([playedOld, emptyFresh, kept].sort());
    expect(left).not.toContain(emptyOld);
  });

  it('finds one session by its code', async () => {
    const { local } = await setup();
    const computer = await local.create({ mode: 'computer', name: 'Computer game', clock, human: 'O', difficulty: 'easy' });
    expect(await local.summary(computer.code)).toMatchObject({ code: computer.code, mode: 'computer', name: 'Computer game' });
    expect(await local.summary('QQQQ' as Code)).toBeUndefined();
  });

  it('applies a raw change and returns the new version', async () => {
    const { local } = await setup();
    const view = await local.create({ mode: 'friend', name: 'Friend game', clock, human: 'X' });
    const same = await local.change(view.code, (doc) => doc);
    expect(same.version).toBe(view.version);
    const renamed = await local.change(view.code, (doc) => ({ ...doc, name: 'Renamed' }));
    expect(renamed).toMatchObject({ version: view.version + 1, doc: { name: 'Renamed' } });
    expect((await local.load(view.code)).name).toBe('Renamed');
  });
});
