import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDeviceDb } from './device-db.ts';
import type { Code } from './protocol.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

// Writes a row past the typed put, like an older version or a hand edit does.
async function putRaw(factory: IDBFactory, store: string, row: unknown) {
  const open = factory.open('device');
  await new Promise((resolve) => (open.onsuccess = resolve));
  const tx = open.result.transaction(store, 'readwrite');
  tx.objectStore(store).put(row);
  await new Promise((resolve) => (tx.oncomplete = resolve));
  open.result.close();
}

describe('openDeviceDb', () => {
  it('reads back a valid row', async () => {
    const db = await openDeviceDb(new IDBFactory(), 'device');
    const row = { code: 'ABCD' as Code, doc: { any: 'document' }, version: 3, updatedAt: 1000 };
    await db.put('sessions', row);
    expect(await db.get('sessions', 'ABCD')).toEqual(row);
    expect(await db.all('sessions')).toEqual([row]);
  });

  it.each([
    ['a fractional version', { code: 'ABCD', doc: {}, version: 1.5, updatedAt: 1000 }],
    ['a code that is not normal', { code: 'abcd', doc: {}, version: 1, updatedAt: 1000 }],
    ['a negative time', { code: 'ABCD', doc: {}, version: 1, updatedAt: -1 }],
  ])('throws on a single read of %s and leaves it out of the list', async (_, bad) => {
    const factory = new IDBFactory();
    const db = await openDeviceDb(factory, 'device');
    const good = { code: 'WXYZ' as Code, doc: {}, version: 1, updatedAt: 1000 };
    await db.put('sessions', good);
    await putRaw(factory, 'sessions', bad);
    await expect(db.get('sessions', bad.code)).rejects.toThrow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await db.all('sessions')).toEqual([good]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('leaves out a result whose upload does not parse', async () => {
    const factory = new IDBFactory();
    const db = await openDeviceDb(factory, 'device');
    await putRaw(factory, 'results', { id: 'r1', upload: { id: 'short' }, sent: false });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await db.all('results')).toEqual([]);
    await expect(db.get('results', 'r1')).rejects.toThrow();
  });

  it('clears a store, also the rows that do not parse, and leaves the other stores', async () => {
    const factory = new IDBFactory();
    const db = await openDeviceDb(factory, 'device');
    const session = { code: 'WXYZ' as Code, doc: {}, version: 1, updatedAt: 1000 };
    await db.put('sessions', session);
    await putRaw(factory, 'results', { id: 'r1', upload: { id: 'short' }, sent: false });
    await db.clear('results');
    await expect(db.get('results', 'r1')).resolves.toBeUndefined();
    expect(await db.all('sessions')).toEqual([session]);
  });
});
