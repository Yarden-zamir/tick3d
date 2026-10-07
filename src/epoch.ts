// A point in time: whole milliseconds since 1970-01-01 UTC. A duration stays a plain number.
// DuckDB make_timestamptz takes whole microseconds, so a fraction of a millisecond never reaches SQL.
export type EpochMs = number & { readonly __brand: 'EpochMs' };

export const isEpochMs = (value: unknown): value is EpochMs => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// For a time that the code computes. Input from outside goes through isEpochMs instead.
export function toEpochMs(value: number): EpochMs {
  if (!isEpochMs(value)) throw new RangeError(`not a time in whole milliseconds: ${value}`);
  return value;
}

export const epochNow = (): EpochMs => toEpochMs(Date.now());

// The largest time: a bound for a check that a stored time passed already when it arrived.
export const MAX_EPOCH_MS = toEpochMs(Number.MAX_SAFE_INTEGER);
