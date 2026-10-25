// A database connection that tells the store about each statement that can change data, so the
// store caches can drop what a write changed.
import type { DuckDBConnection, DuckDBResultReader, DuckDBValue } from '@duckdb/node-api';

type Values = Record<string, DuckDBValue>;

export type Statements = {
  run(sql: string, values?: Values): Promise<void>;
  runAndReadAll(sql: string, values?: Values): Promise<DuckDBResultReader>;
  closeSync(): void;
};

// Runs after each statement that can change data: anything but a plain read, also a ROLLBACK.
export type OnWrite = (sql: string, values: Values | undefined) => void;

const WRITE_WORDS = ['INSERT ', 'UPDATE ', 'DELETE ', 'ALTER ', 'DROP ', 'CREATE '];

// True for a statement that only reads. Anything else counts as a write, so a cache never misses a change.
export function isRead(sql: string): boolean {
  const upper = sql.trim().toUpperCase();
  const reads = upper.startsWith('FROM ') || upper.startsWith('SELECT ') || upper.startsWith('WITH ');
  return reads && !WRITE_WORDS.some((word) => upper.includes(word));
}

export function statements(connection: DuckDBConnection, onWrite: OnWrite = () => undefined): Statements {
  async function execute(sql: string, values: Values | undefined): Promise<DuckDBResultReader> {
    try {
      return await connection.runAndReadAll(sql, values);
    } finally {
      // Also after a failed write: dropping a cache costs little, and a guess about what a failed statement changed can be wrong.
      if (!isRead(sql)) onWrite(sql, values);
    }
  }

  return {
    run: async (sql, values) => {
      await execute(sql, values);
    },
    runAndReadAll: execute,
    closeSync: () => connection.closeSync(),
  };
}
