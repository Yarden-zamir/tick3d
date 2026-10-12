// The fields of a stored game and of its metrics as plain columns. DuckDB reads a field of a VARIANT
// document hundreds of times slower than a plain column, and the stats, the leaderboard and the
// person view read every finished game. So each write copies the fields that queries need into
// columns. The document stays the source of truth.
// Measured on 50,000 results: reading `mode` takes about 1.4 s from the document, 4 ms from a column.
import { REFUSALS } from '../src/protocol.ts';

type Field = { column: string; type: string; path: string };

// From the document of a result (ResultUpload, or an online game in server/store.ts).
const GAME_FIELDS: readonly Field[] = [
  { column: 'mode', type: 'VARCHAR', path: '$.mode' },
  { column: 'level', type: 'VARCHAR', path: '$.difficulty' },
  { column: 'you', type: 'VARCHAR', path: '$.you' },
  { column: 'tuned', type: 'BOOLEAN', path: '$.tuned' },
  { column: 'hide_board', type: 'BOOLEAN', path: '$.options.hideBoard' },
  { column: 'hide_history', type: 'BOOLEAN', path: '$.options.hideHistory' },
  { column: 'hide_coordinates', type: 'BOOLEAN', path: '$.options.hideCoordinates' },
  { column: 'moves', type: 'INTEGER[]', path: '$.game.moves' },
  { column: 'times', type: 'DOUBLE[]', path: '$.game.times' },
  { column: 'per_game', type: 'INTEGER', path: '$.game.clock.perGame' },
  { column: 'per_move', type: 'INTEGER', path: '$.game.clock.perMove' },
  { column: 'timed_out', type: 'BOOLEAN', path: '$.game.timedOut' },
];

// A count per refusal reason (Metrics['refused']). A reason without a refusal is null.
const REFUSED_TYPE = `STRUCT(${REFUSALS.map((reason) => `"${reason}" INTEGER`).join(', ')})`;

// From the metrics of a device (Metrics in src/protocol.ts). Both results and seat_metrics have them.
const METRIC_FIELDS: readonly Field[] = [
  { column: 'device', type: 'VARCHAR', path: '$.device' },
  { column: 'view', type: 'VARCHAR', path: '$.view' },
  { column: 'layout', type: 'VARCHAR', path: '$.layout' },
  { column: 'theme', type: 'VARCHAR', path: '$.theme' },
  { column: 'input_board', type: 'INTEGER', path: '$.input.board' },
  { column: 'input_keypad', type: 'INTEGER', path: '$.input.keypad' },
  { column: 'refused', type: REFUSED_TYPE, path: '$.refused' },
  { column: 'undos', type: 'INTEGER', path: '$.undos' },
  { column: 'think_ms', type: 'DOUBLE[]', path: '$.thinkMs' },
  { column: 'offline', type: 'BOOLEAN', path: '$.offline' },
  { column: 'version', type: 'VARCHAR', path: '$.version' },
  { column: 'nearby_role', type: 'VARCHAR', path: '$.nearby.role' },
  { column: 'nearby_other', type: 'VARCHAR', path: '$.nearby.other' },
];

const METRIC_COLUMNS = METRIC_FIELDS.map((field) => field.column);

const addColumns = (table: string, fields: readonly Field[]) =>
  fields.map((field) => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${field.column} ${field.type}`);

// The SQL value of each field, read from the JSON text `source`.
// A struct goes through json_transform, which leaves out unknown keys; a string through json_extract_string.
const value = (field: Field, source: string) => {
  if (field.type === 'VARCHAR') return `json_extract_string(${source}, '${field.path}')`;
  if (field.type === REFUSED_TYPE) {
    const shape = JSON.stringify(Object.fromEntries(REFUSALS.map((reason) => [reason, 'INTEGER'])));
    return `json_transform(json_extract(${source}, '${field.path}'), '${shape}')`;
  }
  return `json_extract(${source}, '${field.path}')::${field.type}`;
};
const values = (fields: readonly Field[], source: string) => fields.map((field) => value(field, source));
const assignments = (fields: readonly Field[], source: string) => fields.map((field) => `${field.column} = ${value(field, source)}`).join(', ');

export const GAME_COLUMN_LIST = GAME_FIELDS.map((field) => field.column).join(', ');
export const METRIC_COLUMN_LIST = METRIC_COLUMNS.join(', ');
// The values for an INSERT, from the bound JSON text parameters $doc and $metrics.
export const GAME_VALUES = values(GAME_FIELDS, '$doc::JSON').join(', ');
export const METRIC_VALUES = values(METRIC_FIELDS, '$metrics::JSON').join(', ');

// Schema statements: the columns, then a copy of the fields of the rows from before the columns.
// Every document has a mode and every metrics object has a device, so a null there marks a row to fill.
// MIGRATION: the UPDATE statements run once, at the first start after the deploy. Remove them after that
// deploy, as Yarden asked on pull request #128, and move the columns into the CREATE TABLE statements.
// The copy takes about 2 ms per old row; production had 490 results and 23 sessions.
// The seats of a session, as plain columns: My games and a logout find the sessions of a player through them.
// The values for an INSERT or an UPDATE, from the bound JSON text parameter $doc.
export const SESSION_SEAT_VALUES = `json_extract_string($doc::JSON, '$.seats.X'), json_extract_string($doc::JSON, '$.seats.O')`;
export const SESSION_SEAT_SET = `seat_x = json_extract_string($doc::JSON, '$.seats.X'), seat_o = json_extract_string($doc::JSON, '$.seats.O')`;

export const FIELD_SCHEMA = [
  ...addColumns('results', GAME_FIELDS),
  ...addColumns('results', METRIC_FIELDS),
  ...addColumns('seat_metrics', METRIC_FIELDS),
  'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS seat_x VARCHAR',
  'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS seat_o VARCHAR',
  `UPDATE results SET ${assignments(GAME_FIELDS, 'doc::JSON')} WHERE mode IS NULL`,
  `UPDATE results SET ${assignments(METRIC_FIELDS, 'metrics::JSON')} WHERE metrics IS NOT NULL AND device IS NULL`,
  `UPDATE seat_metrics SET ${assignments(METRIC_FIELDS, 'metrics::JSON')} WHERE device IS NULL`,
  // A row from before game links names its uploader (`token`) only: the uploader holds the seat `you`, or
  // both seats in a friend game. After this, player_x and player_o name every seat.
  `UPDATE results SET player_x = CASE WHEN you IS DISTINCT FROM 'O' THEN token END, player_o = CASE WHEN you IS DISTINCT FROM 'X' THEN token END
   WHERE public_id IS NULL AND player_x IS NULL AND player_o IS NULL`,
  `UPDATE sessions SET seat_x = doc.seats.X::VARCHAR, seat_o = doc.seats.O::VARCHAR
   WHERE seat_x IS NULL AND seat_o IS NULL AND (doc.seats.X IS NOT NULL OR doc.seats.O IS NOT NULL)`,
  // The games and the sessions of one player are index lookups (seatedRows in server/stats.ts).
  'CREATE INDEX IF NOT EXISTS results_player_x ON results (player_x)',
  'CREATE INDEX IF NOT EXISTS results_player_o ON results (player_o)',
  'CREATE INDEX IF NOT EXISTS sessions_seat_x ON sessions (seat_x)',
  'CREATE INDEX IF NOT EXISTS sessions_seat_o ON sessions (seat_o)',
];

// The metrics as a struct with the shape of Metrics, built from the columns of `table`, so a query can
// read `metrics.input.board` as from the document. Null for a row without metrics.
export const metricsStruct = (table: string) => `CASE WHEN ${table}.device IS NULL THEN NULL ELSE {
    'device': ${table}.device, 'view': ${table}.view, 'layout': ${table}.layout, 'theme': ${table}.theme,
    'input': {'board': ${table}.input_board, 'keypad': ${table}.input_keypad}, 'refused': ${table}.refused,
    'undos': ${table}.undos, 'thinkMs': ${table}.think_ms, 'offline': ${table}.offline, 'version': ${table}.version,
    'nearby': CASE WHEN ${table}.nearby_role IS NULL THEN NULL ELSE {'role': ${table}.nearby_role, 'other': ${table}.nearby_other} END
  } END`;
