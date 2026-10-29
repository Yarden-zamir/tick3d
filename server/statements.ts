// A database connection that tells the store about each statement that can change data, so the
// store caches can drop what a write changed. It keeps one prepared statement per SQL text: a store call runs
// several small statements, and DuckDB spends about as long to parse and plan each one as to run it (#228).
import type { DuckDBAppender, DuckDBConnection, DuckDBPreparedStatement, DuckDBResultReader, DuckDBValue } from '@duckdb/node-api';

type Values = Record<string, DuckDBValue>;

export type Statements = {
  run(sql: string, values?: Values): Promise<void>;
  runAndReadAll(sql: string, values?: Values): Promise<DuckDBResultReader>;
  // Bulk rows into a temporary table, past the hooks: the statement that moves them on runs through them.
  appendTo(table: string): Promise<DuckDBAppender>;
  closeSync(): void;
};

// Runs after each statement that can change data: anything but a plain read, also a ROLLBACK.
export type OnWrite = (sql: string, values: Values | undefined) => void;
// Runs before each statement, and can refuse it with an error.
export type BeforeStatement = (sql: string, values: Values | undefined) => void;

const WRITE_WORDS = ['INSERT ', 'UPDATE ', 'DELETE ', 'ALTER ', 'DROP ', 'CREATE '];

// True for a statement that only reads. Anything else counts as a write, so a cache never misses a change.
export function isRead(sql: string): boolean {
  const upper = sql.trim().toUpperCase();
  const reads = upper.startsWith('FROM ') || upper.startsWith('SELECT ') || upper.startsWith('WITH ');
  return reads && !WRITE_WORDS.some((word) => upper.includes(word));
}

const MAX_PREPARED = 500;

// CREATE, DROP and ALTER (also CREATE OR REPLACE of a temporary table or view).
function changesSchema(sql: string): boolean {
  const upper = sql.trim().toUpperCase();
  return ['CREATE ', 'DROP ', 'ALTER '].some((word) => upper.startsWith(word));
}

export function statements(connection: DuckDBConnection, onWrite: OnWrite = () => undefined, before: BeforeStatement = () => undefined): Statements {
  // Limit: one entry per distinct SQL text. Some queries put values into their SQL text (the stats filters), so the
  // map empties at MAX_PREPARED entries. Revisit if a profile shows that the hot statements keep missing.
  const prepared = new Map<string, DuckDBPreparedStatement>();
  // A prepared statement holds one set of values until it runs. A second call with the same SQL while the
  // first one runs takes a one-off statement instead.
  const running = new Set<string>();

  // A kept statement must not outlive a schema change: DuckDB 1.5.6 then plans it again, and that failed with an
  // internal error and once crashed the process (stats_sample changes between a table and a view).
  function forgetAll(): void {
    for (const [sql, statement] of prepared) {
      if (!running.has(sql)) statement.destroySync();
    }
    prepared.clear();
  }

  async function runPrepared(sql: string, values: Values): Promise<DuckDBResultReader> {
    running.add(sql);
    try {
      let statement = prepared.get(sql);
      if (statement === undefined) {
        if (prepared.size >= MAX_PREPARED) forgetAll();
        statement = await connection.prepare(sql);
        prepared.set(sql, statement);
      }
      statement.bind(values);
      return await statement.runAndReadAll();
    } finally {
      running.delete(sql);
    }
  }

  async function execute(sql: string, values: Values | undefined): Promise<DuckDBResultReader> {
    before(sql, values);
    try {
      // Without values, the SQL can hold several statements (the schema), which a prepared statement cannot.
      // A kept statement without parameters is never run again: on DuckDB 1.5.6 a second run of one returned
      // broken text after an UPDATE, and a longer text crashed the process. Revisit on a DuckDB upgrade.
      const kept = values !== undefined && Object.keys(values).length > 0 && !running.has(sql) && !changesSchema(sql);
      if (!kept) return await connection.runAndReadAll(sql, values);
      return await runPrepared(sql, values);
    } finally {
      if (changesSchema(sql)) forgetAll();
      // Also after a failed write: dropping a cache costs little, and a guess about what a failed statement changed can be wrong.
      if (!isRead(sql)) onWrite(sql, values);
    }
  }

  return {
    run: async (sql, values) => {
      await execute(sql, values);
    },
    runAndReadAll: execute,
    appendTo: (table) => connection.createAppender(table, 'main', 'temp'),
    closeSync: () => {
      for (const statement of prepared.values()) statement.destroySync();
      prepared.clear();
      connection.closeSync();
    },
  };
}
