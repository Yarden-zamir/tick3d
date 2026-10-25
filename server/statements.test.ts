import { DuckDBInstance } from '@duckdb/node-api';
import { afterEach, describe, expect, it } from 'vitest';
import { type Statements, isRead, statements } from './statements.ts';

let db: Statements | undefined;
afterEach(() => db?.closeSync());

async function open(onWrite: (sql: string) => void = () => undefined): Promise<Statements> {
  db = statements(await (await DuckDBInstance.create(':memory:')).connect(), onWrite);
  await db.run('CREATE TABLE names (token VARCHAR PRIMARY KEY, name VARCHAR)');
  return db;
}

describe('isRead', () => {
  it('counts only plain reads as reads', () => {
    expect(isRead('FROM names SELECT name WHERE token = $token')).toBe(true);
    expect(isRead('  SELECT 1')).toBe(true);
    expect(isRead('WITH t AS (FROM names) FROM t SELECT updated_at')).toBe(true);
  });

  it('counts every statement that can change data as a write', () => {
    expect(isRead('INSERT INTO names VALUES ($token, $name)')).toBe(false);
    expect(isRead('delete from names')).toBe(false);
    expect(isRead('WITH gone AS (FROM names) DELETE FROM names WHERE token IN (FROM gone SELECT token)')).toBe(false);
    expect(isRead('ROLLBACK')).toBe(false);
    expect(isRead('CHECKPOINT')).toBe(false);
  });
});

describe('statements', () => {
  it('reports each write after it ran, also a failed one, and no read', async () => {
    const writes: string[] = [];
    const store = await open((sql) => writes.push(sql));
    writes.length = 0;
    await store.run('INSERT INTO names VALUES ($token, $name)', { token: 'a', name: 'Ann' });
    await store.runAndReadAll('FROM names SELECT name WHERE token = $token', { token: 'a' });
    await expect(store.run('INSERT INTO names VALUES ($token, $name)', { token: 'a', name: 'Ann' })).rejects.toThrow('Duplicate key');
    expect(writes).toEqual(['INSERT INTO names VALUES ($token, $name)', 'INSERT INTO names VALUES ($token, $name)']);
  });

  it('gives each call the rows of its own values, also for two calls at once', async () => {
    const store = await open();
    await store.run('INSERT INTO names VALUES ($token, $name)', { token: 'a', name: 'Ann' });
    await store.run('INSERT INTO names VALUES ($token, $name)', { token: 'b', name: 'Bo' });
    const read = async (token: string) => (await store.runAndReadAll('FROM names SELECT name WHERE token = $token', { token })).getRowObjectsJS();
    expect(await read('a')).toEqual([{ name: 'Ann' }]);
    expect(await read('b')).toEqual([{ name: 'Bo' }]);
    expect(await Promise.all([read('a'), read('b'), read('c')])).toEqual([[{ name: 'Ann' }], [{ name: 'Bo' }], []]);
  });

  it('runs SQL with several statements when it has no values', async () => {
    const store = await open();
    await store.run("INSERT INTO names VALUES ('a', 'Ann'); INSERT INTO names VALUES ('b', 'Bo')");
    expect((await store.runAndReadAll('SELECT count(*)::INTEGER AS n FROM names')).getRowObjectsJS()).toEqual([{ n: 2 }]);
  });

  it('plans a statement again after a schema change, also when a view becomes a table', async () => {
    const store = await open();
    await store.run("INSERT INTO names VALUES ('a', 'Ann')");
    const count = async () => (await store.runAndReadAll('WITH n AS NOT MATERIALIZED (FROM sample) SELECT count(*)::INTEGER AS n FROM n', {})).getRowObjectsJS();
    await store.run('CREATE OR REPLACE TEMP VIEW sample AS FROM names', {});
    expect(await count()).toEqual([{ n: 1 }]);
    await store.run('DROP VIEW sample', {});
    await store.run('CREATE OR REPLACE TEMP TABLE sample AS FROM names WHERE token = $token', { token: 'b' });
    expect(await count()).toEqual([{ n: 0 }]);
  });

  it('reads the new text after an update, also with a query without parameters', async () => {
    const store = await open();
    await store.run("INSERT INTO names VALUES ('a', NULL), ('b', 'Tom')");
    const names = async () => (await store.runAndReadAll('FROM names SELECT name ORDER BY token', {})).getRowObjectsJS();
    expect(await names()).toEqual([{ name: null }, { name: 'Tom' }]);
    await store.run('UPDATE names SET name = $name WHERE token = $token', { name: 'Dana Levi with a longer name', token: 'a' });
    expect(await names()).toEqual([{ name: 'Dana Levi with a longer name' }, { name: 'Tom' }]);
  });
});
