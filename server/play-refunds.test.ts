import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DuckDBInstance } from '@duckdb/node-api';
import { expect, it } from 'vitest';
import { openStore } from './store.ts';
import type { PlayerToken } from '../src/protocol.ts';

it('persists a revoked device without revoking the other proved devices of its account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tick3d-refund-'));
  const path = join(directory, 'copies.duckdb');
  const phone = 'aaaaaaaa-0000-4000-8000-000000000001' as PlayerToken;
  const otherPhone = 'aaaaaaaa-0000-4000-8000-000000000002' as PlayerToken;
  const unknownPhone = 'aaaaaaaa-0000-4000-8000-000000000003' as PlayerToken;
  const buyer = { id: 1001, login: 'buyer', avatar: 'https://avatars.githubusercontent.com/u/1001' };
  const store = await openStore(path);
  try {
    for (const token of [phone, otherPhone]) {
      await store.linkToken(token, buyer);
      await store.reportAppOpen(token, null, true);
    }
    expect(await store.revokePlayCopy(phone)).toBe(true); // The other phone still holds a proved copy.
    await store.revokePlayCopy(unknownPhone); // A failed purchase never creates a copy.
  } finally {
    await store.close();
  }
  const instance = await DuckDBInstance.create(path);
  const db = await instance.connect();
  try {
    expect((await db.runAndReadAll('FROM app_copies SELECT token, proved ORDER BY token')).getRowObjectsJS()).toEqual([
      { token: phone, proved: false }, { token: otherPhone, proved: true },
    ]);
  } finally {
    db.closeSync();
    instance.closeSync();
    await rm(directory, { recursive: true, force: true });
  }
});
