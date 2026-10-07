import { describe, expect, it } from 'vitest';
import { bigId, epoch, int, nullable, oneOf, readRow, text } from './sql.ts';

describe('readRow', () => {
  it('keeps only the columns of the shape, read by their guards', () => {
    const row = readRow({ name: 'alice', games: 3n, at: 1_700_000_000_000n, token: 'secret' }, { name: text, games: int, at: epoch });
    expect(row).toEqual({ name: 'alice', games: 3, at: 1_700_000_000_000 });
  });

  it('throws for a column that the query does not have, also for a nullable one', () => {
    expect(() => readRow({}, { name: nullable(text) })).toThrow('the query has no column name');
  });

  it('names the column of a value that its guard refuses', () => {
    expect(() => readRow({ games: 1.5 }, { games: int })).toThrow('column games');
    expect(() => readRow({ mode: 'chess' }, { mode: oneOf(['online', 'computer'] as const) })).toThrow('column mode');
    expect(readRow({ mode: null }, { mode: nullable(oneOf(['online'] as const)) })).toEqual({ mode: null });
  });
});

describe('column guards', () => {
  it('reads a BIGINT id beyond a safe integer exactly', () => {
    expect(bigId(2n ** 60n)).toBe(2n ** 60n);
    expect(bigId(7)).toBe(7n);
    expect(() => bigId(1.5)).toThrow();
  });

  it('refuses a whole number that a double cannot hold exactly', () => {
    expect(() => int(2n ** 60n)).toThrow();
  });
});
