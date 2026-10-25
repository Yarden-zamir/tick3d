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
});
