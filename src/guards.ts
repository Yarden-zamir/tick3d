// Type guards for values from outside: network JSON, storage, worker and channel messages.

// A plain object. An array is not a record.
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A whole number from 0 up that stays exact: a count, an index or an id.
export const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// Array.isArray narrows to any[]. This keeps the items unknown, so each one needs its own check.
export const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

// The keys of a table that the code declares. Object.keys gives string[], so this is the one cast for it.
// Only for tables written in the code: an object from outside can hold more keys than its type says.
export const keysOf = <K extends string>(table: Readonly<Record<K, unknown>>): K[] => Object.keys(table) as K[];
