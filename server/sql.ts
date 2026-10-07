// Typed reads of DuckDB query rows. Each query names its columns and a guard for each one (a shape).
// The rows come back typed from the shape, and a column with an unexpected value throws.
import type { DuckDBValue } from '@duckdb/node-api';
import { type EpochMs, toEpochMs } from '../src/epoch.ts';
import { type Code, type DeviceGameId, type GameId, normalizeCode, parseDeviceGameId, parseGameId } from '../src/protocol.ts';

// Reads one column value, or throws.
export type Column<T> = (value: unknown) => T;
export type Shape = Readonly<Record<string, Column<unknown>>>;
export type RowOf<S extends Shape> = { -readonly [K in keyof S]: ReturnType<S[K]> };

// Runs one query and reads its rows with `shape`. Columns that the shape does not name are left out.
export type Rows = <S extends Shape>(sql: string, values: Record<string, DuckDBValue>, shape: S) => Promise<RowOf<S>[]>;

export function readRow<S extends Shape>(row: Readonly<Record<string, unknown>>, shape: S): RowOf<S> {
  const read = Object.entries(shape).map(([name, column]) => {
    // A missing column is a typo in the query or in the shape, not a null value.
    if (!(name in row)) throw new Error(`the query has no column ${name}`);
    try {
      return [name, column(row[name])];
    } catch (error) {
      throw new Error(`column ${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  });
  // Object.fromEntries gives a record of unknown values. Each value passed the guard of its column above.
  return Object.fromEntries(read) as RowOf<S>;
}

// A finite number. DuckDB gives BIGINT columns (count(*), epoch_ms, len) as bigint.
export function num(value: unknown): number {
  const result = typeof value === 'bigint' ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error(`not a number: ${String(value)}`);
  return result;
}

// A whole number that stays exact.
export function int(value: unknown): number {
  const result = num(value);
  if (!Number.isSafeInteger(result)) throw new Error(`not a whole number: ${result}`);
  return result;
}

// A BIGINT id that can exceed a safe integer, such as a GitHub id.
export function bigId(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`not a whole number: ${String(value)}`);
}

export function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`not text: ${String(value)}`);
  return value;
}

export function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error(`not a boolean: ${String(value)}`);
  return value;
}

// A `doc::JSON` column: DuckDB gives the JSON as text.
export const json = (value: unknown): unknown => JSON.parse(text(value));

// An `epoch_ms(...)` column.
export const epoch = (value: unknown): EpochMs => toEpochMs(int(value));

export function code(value: unknown): Code {
  const found = text(value);
  const parsed = normalizeCode(found);
  if (parsed === undefined || parsed !== found) throw new Error(`not a session code: ${found}`);
  return parsed;
}

export function gameId(value: unknown): GameId {
  const found = text(value);
  const parsed = parseGameId(found);
  if (parsed === undefined || parsed !== found) throw new Error(`not a game id: ${found}`);
  return parsed;
}

// The public id of an uploaded result: only the exact form that a device makes.
export function deviceGameId(value: unknown): DeviceGameId {
  const found = text(value);
  const parsed = parseDeviceGameId(found);
  if (parsed === undefined) throw new Error(`not a device game id: ${found}`);
  return parsed;
}

export const oneOf =
  <T extends string>(options: readonly T[]): Column<T> =>
  (value) => {
    const found = options.find((option) => option === value);
    if (found === undefined) throw new Error(`unexpected value ${String(value)}`);
    return found;
  };

// The column guard, or null for a SQL NULL.
export const nullable =
  <T>(column: Column<T>): Column<T | null> =>
  (value) =>
    value === null ? null : column(value);
