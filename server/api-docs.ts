// The public HTTP API in one place. The server dispatches requests with matchRoute, and
// /api/openapi.json and its Swagger UI page /api/docs come from this file (see server/api-docs-render.ts).
// To add a route, add one entry to ROUTES and one case to the switch in server/main.ts.
// The type checker refuses a case without an entry, and a switch without a case for an entry.
// server/api-docs.test.ts runs every example through the real parsers in src/protocol.ts.
import { DIFFICULTIES } from '../src/ai.ts';
import { LIMIT_RANGE } from '../src/clock.ts';
import { CELL_COUNT } from '../src/game.ts';
import { DEVICE_KINDS } from '../src/nearby/device.ts';
import { HELLO_NAME_MAX_LENGTH, MAX_CODE_LENGTH } from '../src/nearby/signal.ts';
import { PLAYOFF_COUNTDOWN_MS, PLAYOFF_TARGETS } from '../src/practice/playoff.ts';
import { ECHO_POINTS, MAX_ROUND_MS, PRACTICE_MODES, PRESET_IDS, ROUNDS } from '../src/practice/practice.ts';
import {
  CHAT_KEEP,
  CHAT_MAX_LENGTH,
  CODE_ALPHABET,
  CODE_LENGTH,
  CONSENT_ACTIONS,
  DEVICE_GAME_ID_LENGTH,
  CUSTOM_NAME_MAX_LENGTH,
  CUSTOM_NAME_MIN_LENGTH,
  FORM_WINDOW,
  NAME_MAX_LENGTH,
  PERSON_ID_LENGTH,
  PREVIEW_DESCRIPTION_LENGTH,
  REPORT_NOTE_MAX_LENGTH,
  REPORT_REASONS,
  HISTORY_PAGE_SIZE,
  LAYOUTS,
  REFUSALS,
  RESULTS_PER_UPLOAD,
  SEAT_ACTIONS,
  SESSION_MODES,
  STATS_RANGES,
  STATS_SCOPES,
  THEMES,
  VIEWS,
  WATCHER_ID_LENGTH,
} from '../src/protocol.ts';
import { EMPTY_SESSION_TTL_MS, ERROR_CODES, SEAT_REQUEST_MS } from '../src/session/core.ts';

// Long polls wait at most this long. Proxies keep an idle request open for longer.
export const WAIT_MS = 25_000;
// New sessions per hour from one address. server/main.ts enforces it.
export const CREATES_PER_HOUR = 60;
// Fault reports per 10 minutes from one address. server/main.ts enforces it.
export const EVENTS_PER_10_MINUTES = 30;
// Nearby lobby calls (announce and answer) per 10 minutes from one network. server/main.ts enforces it.
export const NEARBY_CALLS_PER_10_MINUTES = 120;
// Games in the Nearby list from one network. server/lobby.ts enforces it.
export const NEARBY_HOSTS_PER_NETWORK = 10;
// A Nearby host stays in the list for this long after its announce request ends.
export const NEARBY_GRACE_MS = 10_000;
// Practice runs per 10 minutes from one address. server/main.ts enforces it.
export const PRACTICE_RUNS_PER_10_MINUTES = 60;
// Reports of chat messages and people per 10 minutes from one address. server/main.ts enforces it.
export const REPORTS_PER_10_MINUTES = 20;
// Delete my data calls per hour from one address. server/main.ts enforces it.
export const DATA_DELETES_PER_HOUR = 10;
// The tables that Delete my data (deleteData in server/store.ts) changes, with the rows it deleted and
// the rows it kept without the player. chat_messages counts the messages inside the session documents.
// The other tables hold no player data: events, and moderation_log (kept for moderation).
export const DATA_TABLES = ['sessions', 'chat_messages', 'results', 'seat_metrics', 'player_names', 'blocks', 'private_stats', 'practice_runs', 'reports', 'player_tokens', 'users'] as const;
export type DeletedData = Record<(typeof DATA_TABLES)[number], { deleted: number; anonymised: number }>;
// The previews list on production is at most this old. server/previews.ts enforces it.
// Only production calls GitHub, without a token: 60 calls per hour, 5 of them kept in reserve, so 55.
// The calls per hour at about 10 open pull requests:
// - the pull request list: 60 / 3 = 20;
// - the commits, once per new head commit: about 15 pushes per hour;
// - after a production restart, the commits of every open pull request again: about 10 for one deploy of main.
// That is about 45 of 55. Above the budget, production makes no call until the limit resets, and keeps the last list.
// Revisit with more than about 15 open pull requests or about 25 pushes per hour: then use a GitHub token (5000 per hour).
export const PREVIEWS_CACHE_MS = 180_000;
// A preview server keeps production's list for this long. It costs no GitHub call, only a request to production.
export const PREVIEWS_RELAY_CACHE_MS = 15_000;
// The 400 answer of GET /api/stats for a query that parseStatsFilter refuses.
export const STATS_FILTER_ERROR = `Unknown stats filter. scope: ${STATS_SCOPES.join(' or ')}. range: ${STATS_RANGES.join(', ')}. mode: ${SESSION_MODES.join(', ')}. level: ${DIFFICULTIES.join(', ')}, only with the computer mode or no mode. person: a person id of ${PERSON_ID_LENGTH} hex characters, not with scope mine. Each key at most once.`;

// ---- Shapes (JSON Schema 2020-12, as OpenAPI 3.1 uses) ----

type JsonType = 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';

export type Schema = {
  type?: JsonType | readonly JsonType[];
  description?: string;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean | Schema;
  minProperties?: number;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  enum?: readonly (string | null)[];
  const?: string | boolean;
  oneOf?: readonly Schema[];
  $ref?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};

export type SchemaName =
  | 'Player'
  | 'Cell'
  | 'TimeControl'
  | 'GameRecord'
  | 'Status'
  | 'ChatMessage'
  | 'PlayerInfo'
  | 'SeatNames'
  | 'Watcher'
  | 'SeatRequest'
  | 'SessionView'
  | 'SeatAction'
  | 'SeatAnswer'
  | 'NameRequest'
  | 'NewSession'
  | 'SessionUpdate'
  | 'MoveRequest'
  | 'ChatRequest'
  | 'Error'
  | 'Health'
  | 'Me'
  | 'Tally'
  | 'SessionSummary'
  | 'MyGames'
  | 'ResultUpload'
  | 'ResultsRequest'
  | 'ResultsResponse'
  | 'Ok'
  | 'GameId'
  | 'DeviceGameId'
  | 'PublicGame'
  | 'HistoryEntry'
  | 'HistoryPage'
  | 'Hidden'
  | 'Records'
  | 'Metrics'
  | 'MetricsResponse'
  | 'ClientEvent'
  | 'Count'
  | 'StatsFilter'
  | 'Stats'
  | 'StatsPrivacy'
  | 'NearbyAnnounce'
  | 'NearbyAnnounced'
  | 'NearbyHost'
  | 'NearbyHosts'
  | 'NearbyAnswer'
  | 'Contributor'
  | 'Preview'
  | 'Previews'
  | 'Playoff'
  | 'PlayoffRequest'
  | 'PracticeRun'
  | 'PracticeStored'
  | 'PracticeLeader'
  | 'PracticeBoard'
  | 'BlockRequest'
  | 'Blocks'
  | 'ReportRequest'
  | 'ReportStored'
  | 'Reports'
  | 'DeletedData'
  | 'DeletedPeople';

export const ref = (name: SchemaName): Schema => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: Schema): Schema => ({ oneOf: [schema, { type: 'null' }] });
const object = (description: string, properties: Record<string, Schema>, optional: readonly string[] = []): Schema => ({
  type: 'object',
  description,
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});
// The match options. hideCoordinates is optional only in a request: an older client sends no such field.
const matchOptions = (description: string, optionalCoordinates = false): Schema =>
  object(
    description,
    {
      hideBoard: { type: 'boolean' },
      hideHistory: { type: 'boolean' },
      hideCoordinates: { type: 'boolean', description: 'The keypad hides the coordinates of the last move. A missing value means false.' },
    },
    optionalCoordinates ? ['hideCoordinates'] : [],
  );
const limit = (kind: keyof typeof LIMIT_RANGE, description: string): Schema => ({
  type: ['integer', 'null'],
  minimum: LIMIT_RANGE[kind].min,
  maximum: LIMIT_RANGE[kind].max,
  description,
});
const name: Schema = { type: 'string', minLength: 1, maxLength: NAME_MAX_LENGTH, description: 'The session name. The server trims spaces.' };
const seatName: Schema = { type: 'string', minLength: 1, maxLength: NAME_MAX_LENGTH, description: 'A generated name: an adjective and an animal in camelCase.' };
const chatText: Schema = { type: 'string', minLength: 1, maxLength: CHAT_MAX_LENGTH, description: `1 to ${CHAT_MAX_LENGTH} characters. The server trims spaces.` };
const watcherId: Schema = { type: 'string', pattern: `^[0-9a-f]{${WATCHER_ID_LENGTH}}$`, description: 'The id of a watcher in this session. It is not a player id.' };
const displayName: Schema = { type: 'string', minLength: 1, maxLength: NAME_MAX_LENGTH, description: 'A custom name that the player chose, else a generated name.' };
const person: Schema = {
  type: 'string',
  pattern: `^[0-9a-f]{${PERSON_ID_LENGTH}}$`,
  description: 'A public person id. The same player has the same id in every session, also on every device of a GitHub account. It is not a player id and reveals none.',
};
const signalCode: Schema = { type: 'string', minLength: 1, maxLength: MAX_CODE_LENGTH };
const hostId: Schema = { type: 'string', pattern: '^[A-Za-z0-9_-]{16}$', description: 'The id of a Nearby host in the list.' };
const strings = (values: readonly string[], description?: string): Schema => ({ type: 'string', enum: values, ...(description === undefined ? {} : { description }) });
const list = (description: string, items?: Schema): Schema => ({ type: 'array', description, ...(items === undefined ? {} : { items }) });
const count = (description?: string): Schema => ({ type: 'integer', minimum: 0, ...(description === undefined ? {} : { description }) });
const tally = (description: string, keys: readonly string[]): Schema =>
  object(description, Object.fromEntries(keys.map((key) => [key, ref('Tally')])));

export const SCHEMAS: Record<SchemaName, Schema> = {
  Player: { type: 'string', enum: ['X', 'O'], description: 'A seat. X moves first in every game. The players swap X and O for each new game, unless fixedSeats is true.' },
  Cell: {
    type: 'integer',
    minimum: 0,
    maximum: CELL_COUNT - 1,
    description: 'layer * 16 + row * 4 + column, each 0 to 3. Layer 0 is the bottom layer.',
  },
  TimeControl: object('A time limit, like a chess clock. null means no limit of that kind.', {
    perMove: limit('perMove', 'Seconds for each move.'),
    perGame: limit('perGame', 'Seconds for each player for the whole game.'),
  }),
  GameRecord: object('One game. The last game in a session is the live game.', {
    moves: { type: 'array', items: ref('Cell'), maxItems: CELL_COUNT, description: 'The cells in move order. X played the even indexes (0, 2, 4...), O the odd ones.' },
    times: { type: 'array', items: { type: 'number' }, description: 'The server time of each move, in epoch milliseconds.' },
    clock: ref('TimeControl'),
    timedOut: { type: 'boolean', description: 'True when the player to move ran out of time.' },
  }),
  Status: {
    description: 'The state of the live game.',
    oneOf: [
      object('The game goes on.', { kind: { const: 'playing' } }),
      object('A player has four in a line.', {
        kind: { const: 'won' },
        winner: ref('Player'),
        line: { type: 'array', items: ref('Cell'), minItems: 4, maxItems: 4, description: 'The four winning cells.' },
      }),
      object('The other player ran out of time.', { kind: { const: 'timeout' }, winner: ref('Player') }),
      object('The cube is full and no player has a line.', { kind: { const: 'draw' } }),
    ],
  },
  ChatMessage: object('A chat message.', {
    id: { type: 'integer', description: 'Grows by 1 with each message.' },
    from: { ...ref('Player'), description: 'The seat of the sender when they sent the message.' },
    text: chatText,
    at: { type: 'number', description: 'Server time in epoch milliseconds.' },
    by: { ...person, description: 'The person id of the sender. An older message has none: then the holder of `from` stands for the sender.' },
  }, ['by']),
  PlayerInfo: object('The GitHub account of a seat, when its player logged in on the page.', {
    login: { type: 'string', minLength: 1, maxLength: 39 },
    avatar: { type: 'string', pattern: '^https://avatars\\.githubusercontent\\.com/' },
  }),
  SeatNames: object('The name of the player on each seat: a custom name, else a generated name such as "braveOtter". null for an empty seat and for the computer.', {
    X: nullable(seatName),
    O: nullable(seatName),
  }),
  Watcher: object('A browser that has the game open and holds no seat.', {
    id: watcherId,
    name: displayName,
    player: { ...nullable(ref('PlayerInfo')), description: 'The GitHub account of the watcher, or null.' },
    person: { ...nullable(person), description: 'The person id of the watcher. null from a Nearby host that does not know it yet.' },
  }),
  SeatRequest: object(`A seat change that waits for the other player. It ends after ${SEAT_REQUEST_MS / 1000} s without an answer.`, {
    kind: strings(CONSENT_ACTIONS, 'swap: X and O trade seats. unseat: the other player watches. replace: a watcher takes the seat of the other player. undo: the last move goes back.'),
    from: { ...ref('Player'), description: 'The seat of the player who asked.' },
    watcher: {
      ...nullable(object('The watcher that takes the seat.', { name: displayName, player: nullable(ref('PlayerInfo')) })),
      description: 'For replace only. null for the other kinds.',
    },
    expiresAt: { type: 'number', description: 'Server time in epoch milliseconds when the request ends.' },
  }),
  SessionView: object('A session as the caller sees it: every game, the seats, the chat and the live game state.', {
    code: { type: 'string', pattern: `^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`, description: 'The session code. The link is /?code=<code>.' },
    name,
    games: { type: 'array', items: ref('GameRecord'), minItems: 1, description: 'Every game, oldest first. The last one is the live game.' },
    seats: object('True when a player holds the seat.', { X: { type: 'boolean' }, O: { type: 'boolean' } }),
    you: { ...nullable(ref('Player')), description: 'Your seat in the live game, from your X-Player header. null when you watch. The seats can swap for each new game, so read it again after each new game.' },
    options: matchOptions('Display options for both players and watchers.'),
    locked: { type: 'boolean', description: 'True when a player locked the settings until the live game ends.' },
    clock: { ...ref('TimeControl'), description: 'The time limit for the next game.' },
    fixedSeats: { type: 'boolean', description: 'false (the default): the players swap X and O for each new game, so the first move alternates. true: the seats stay the same.' },
    flipped: {
      type: 'array',
      items: { type: 'boolean' },
      description: 'One entry per game in `games`: true when the two players sat the other way round in that game. Then the player on seat X now played O in that game. The live game is always false.',
    },
    now: { type: 'number', description: 'Server time in epoch milliseconds.' },
    version: { type: 'integer', description: 'Grows with every change. Send it as ?wait=<version> to wait for the next change.' },
    chat: { type: 'array', items: ref('ChatMessage'), maxItems: CHAT_KEEP, description: `The newest ${CHAT_KEEP} messages, oldest first.` },
    presence: object('True when the seat has the game open in a browser now. An API client shows as away.', {
      X: { type: 'boolean' },
      O: { type: 'boolean' },
    }),
    players: object('The GitHub account behind each seat, or null.', { X: nullable(ref('PlayerInfo')), O: nullable(ref('PlayerInfo')) }),
    names: ref('SeatNames'),
    people: object('The person id of the player on each seat. null for an empty seat and for the computer.', { X: nullable(person), O: nullable(person) }),
    watchers: { type: 'array', items: ref('Watcher'), description: 'The browsers that have the game open without a seat, in the order that they came.' },
    youWatcher: { ...nullable(watcherId), description: 'Your id in `watchers` when you watch, else null.' },
    seatRequest: { ...nullable(ref('SeatRequest')), description: 'A seat change that waits for the other player, or null.' },
    turn: { ...nullable(ref('Player')), description: 'The player to move in the live game. null when the live game is over.' },
    status: ref('Status'),
    playoff: { ...nullable(ref('Playoff')), description: 'The sound playoff of the session, or null. A change of the seats sets it to null. An older server sends no such field.' },
  }, ['playoff']),
  NewSession: object(
    'A new session. You take seat X.',
    { name, clock: { ...ref('TimeControl'), description: 'Optional. No limit when you leave it out.' } },
    ['clock'],
  ),
  SessionUpdate: {
    ...object(
      'Changes to a session. Send at least one field.',
      {
        name,
        hideBoard: { type: 'boolean', description: 'Hide the board for both players.' },
        hideHistory: { type: 'boolean', description: 'Hide all marks except the last move.' },
        hideCoordinates: { type: 'boolean', description: 'Hide the coordinates of the last move on the keypad, for play by ear.' },
        clock: { ...ref('TimeControl'), description: 'The time limit from the next game on.' },
        fixedSeats: { type: 'boolean', description: 'true: keep the seats for the next games. false: swap X and O for each new game.' },
      },
      ['name', 'hideBoard', 'hideHistory', 'hideCoordinates', 'clock', 'fixedSeats'],
    ),
    minProperties: 1,
  },
  MoveRequest: object('A move in the live game.', {
    game: { type: 'integer', minimum: 0, description: 'The index of the live game: games.length - 1.' },
    moveCount: { type: 'integer', minimum: 0, description: 'The number of moves in the live game that you saw. A different number means that the board changed, and the server refuses the move.' },
    cell: ref('Cell'),
  }),
  ChatRequest: object('A chat message.', { text: chatText }),
  SeatAction: object(
    'A change of the seats. Only a player can send it.',
    {
      action: strings(
        SEAT_ACTIONS,
        'swap: X and O trade seats. leave: you watch, and your seat empties. give: your seat goes to a watcher. seat: a watcher takes the empty seat. unseat: the other player watches. replace: a watcher takes the seat of the other player. undo: your last move goes back, before the other player moves; not in a timed game.',
      ),
      watcher: { ...watcherId, description: 'For give, seat and replace only: the id of a watcher from `watchers`.' },
    },
    ['watcher'],
  ),
  SeatAnswer: object('An answer to the open seat request.', {
    accept: { type: 'boolean', description: 'true applies the change. false declines it, or cancels your own request.' },
  }),
  NameRequest: object('Your display name.', {
    name: {
      type: 'string',
      minLength: CUSTOM_NAME_MIN_LENGTH,
      maxLength: CUSTOM_NAME_MAX_LENGTH,
      description: `${CUSTOM_NAME_MIN_LENGTH} to ${CUSTOM_NAME_MAX_LENGTH} letters, digits, spaces, "-" and "_". The server trims spaces and joins inner spaces into one.`,
    },
  }),
  Error: object(
    'A refused request.',
    {
      error: { type: 'string', description: 'A message for a person.' },
      code: strings(ERROR_CODES, 'For a program: a refusal that needs a specific reaction. Only some refusals have one.'),
    },
    ['code'],
  ),
  Health: object('The server is up.', {
    ok: { const: true },
    lan: nullable(object('A server that a player runs on a local network.', { name: { type: 'string' } })),
  }),
  Me: object('Your login state on the page, and your custom name.', {
    loginAvailable: { type: 'boolean' },
    user: nullable(ref('PlayerInfo')),
    name: { ...nullable(displayName), description: 'The name that you chose with PUT /api/me/name, or null.' },
  }),
  Tally: object('Game counts.', {
    played: { type: 'integer', minimum: 0 },
    won: { type: 'integer', minimum: 0 },
    lost: { type: 'integer', minimum: 0 },
    drawn: { type: 'integer', minimum: 0 },
  }),
  SessionSummary: object('An online session that you hold a seat in.', {
    code: { type: 'string' },
    name,
    games: { type: 'integer', minimum: 0 },
    you: ref('Player'),
    opponent: nullable(ref('PlayerInfo')),
    opponentName: { ...nullable(seatName), description: 'The generated name of the other player. null while the other seat is empty.' },
    yourTurn: { type: 'boolean' },
    updatedAt: { type: 'number' },
  }),
  MyGames: object('Your stats and sessions, on all devices of your account.', {
    user: nullable(ref('PlayerInfo')),
    total: ref('Tally'),
    byMode: tally('Counts per mode.', SESSION_MODES),
    byDifficulty: tally('Counts per computer level.', DIFFICULTIES),
    sessions: { type: 'array', items: ref('SessionSummary') },
  }),
  ResultUpload: object('A finished game that a device played away from the server.', {
    id: { type: 'string', minLength: 16, maxLength: 64, pattern: '^[a-z0-9-]+$' },
    mode: { type: 'string', enum: SESSION_MODES.filter((mode) => mode !== 'online') },
    game: ref('GameRecord'),
    you: nullable(ref('Player')),
    difficulty: { type: ['string', 'null'], enum: [...DIFFICULTIES, null] },
    finishedAt: { type: 'number' },
    publicId: { ...nullable(ref('DeviceGameId')), description: 'The id that the device made, for the game link. Optional.' },
    options: matchOptions('The hide settings at the end of the game. Optional.', true),
    tuned: { type: 'boolean', description: 'A computer game with changed advanced settings. Optional.' },
    metrics: { ...nullable(ref('Metrics')), description: 'What the device saw during the game. Optional.' },
    guest: {
      ...nullable({ type: 'string', minLength: 16, maxLength: 64, pattern: '^[a-z0-9-]+$' }),
      description: 'Only a Nearby host: the player id of the guest on the other seat. The guest then has the game in their history. The server never returns it. Optional.',
    },
  }, ['publicId', 'options', 'tuned', 'metrics', 'guest']),
  ResultsRequest: object('Finished games from this device.', {
    results: { type: 'array', items: ref('ResultUpload'), maxItems: RESULTS_PER_UPLOAD },
  }),
  ResultsResponse: object('The upload result.', {
    stored: count('How many results were new.'),
    renamed: {
      type: 'object',
      additionalProperties: ref('DeviceGameId'),
      description: 'By result id: the public id that the server keeps for a result, when it differs from the one that the device sent.',
    },
  }),
  Ok: object('Done.', { ok: { const: true } }),
  GameId: {
    type: 'string',
    pattern: `^([${CODE_ALPHABET}]{${DEVICE_GAME_ID_LENGTH}}|[${CODE_ALPHABET}]{${CODE_LENGTH}}-[1-9][0-9]*)$`,
    description: `The id of a finished game. An online game: <CODE>-<n>, where n is the game number in the session, from 1. Other games: ${DEVICE_GAME_ID_LENGTH} characters. The link is /?game=<id>. Lower case also works.`,
  },
  DeviceGameId: {
    type: 'string',
    pattern: `^[${CODE_ALPHABET}]{${DEVICE_GAME_ID_LENGTH}}$`,
    description: 'The id of a finished game that a device made: upper case only, no dash.',
  },
  PublicGame: object('A finished game as anybody with its link sees it.', {
    id: ref('GameId'),
    mode: strings(SESSION_MODES),
    game: ref('GameRecord'),
    options: matchOptions('The hide settings at the end of the game.'),
    difficulty: { type: ['string', 'null'], enum: [...DIFFICULTIES, null], description: 'The computer level, in a computer game.' },
    tuned: { type: 'boolean', description: 'A computer with changed advanced settings.' },
    computer: { ...nullable(ref('Player')), description: 'The seat of the computer, in a computer game.' },
    players: object('The GitHub account behind each seat, or null.', { X: nullable(ref('PlayerInfo')), O: nullable(ref('PlayerInfo')) }),
    names: ref('SeatNames'),
    finishedAt: { type: 'number', description: 'Epoch milliseconds.' },
  }),
  HistoryEntry: object('One finished game of yours.', {
    id: { ...nullable(ref('GameId')), description: 'null for an old game without a link.' },
    mode: strings(SESSION_MODES),
    difficulty: { type: ['string', 'null'], enum: [...DIFFICULTIES, null] },
    result: strings(['won', 'lost', 'drawn', 'played'], 'Your result. A friend game on one device is only "played".'),
    moves: count('Moves in the game.'),
    opponent: nullable(ref('PlayerInfo')),
    opponentName: { ...nullable(seatName), description: 'The generated name of the other player. null when the server does not know the other seat.' },
    finishedAt: { type: 'number' },
  }),
  HistoryPage: object(`Up to ${HISTORY_PAGE_SIZE} finished games, newest first.`, {
    games: list('The games of this page.', ref('HistoryEntry')),
    more: { type: 'boolean', description: 'True when an older page exists. Ask again with a larger offset.' },
  }),
  Hidden: object('The cleared history.', { hidden: count('How many games left your history.') }),
  DeletedPeople: object('The players who deleted their data in the time asked.', {
    people: list('Their person ids. Remove these people from your own copies.', person),
    until: { type: 'integer', minimum: 0, description: 'The server time of this answer, in epoch ms. Send it as `since` next time.' },
  }),
  DeletedData: object(
    'What the server changed, per table.',
    Object.fromEntries(
      DATA_TABLES.map((table) => [
        table,
        object(table === 'chat_messages' ? 'Your chat messages in the sessions. Each one keeps its place without its text.' : `The rows of ${table}.`, { deleted: count('Rows deleted.'), anonymised: count('Rows kept without your id, because another player needs them.') }),
      ]),
    ),
  ),
  Records: object('Your survival records against the computer.', {
    records: {
      type: 'object',
      additionalProperties: { type: 'integer', minimum: 1 },
      description: 'The most moves before the computer won, per setup. A key looks like "hard|game:none|move:none|board:false|history:false".',
    },
  }),
  Metrics: object('What one device saw during one game, for the stats page. Every field is required.', {
    device: strings(DEVICE_KINDS),
    view: strings(VIEWS),
    layout: strings(LAYOUTS),
    theme: strings(THEMES),
    input: object('Moves of this player by how they were placed.', { board: count(), keypad: count() }),
    refused: { type: 'object', additionalProperties: count(), description: `Refused actions by reason: ${REFUSALS.join(', ')}.` },
    undos: count(),
    thinkMs: list('The thinking time of each computer move, in milliseconds.', { type: 'number', minimum: 0 }),
    offline: { type: 'boolean' },
    version: { type: 'string', minLength: 1, maxLength: 64, description: 'The name of the page script file.' },
    tuning: { type: ['object', 'null'], description: 'The computer settings of a tuned computer game (see src/tuning.ts), else null.' },
    nearby: nullable(object('A Nearby game.', { role: strings(['host', 'guest']), other: { type: ['string', 'null'], enum: [...DEVICE_KINDS, null] } })),
  }),
  MetricsResponse: object('The metrics result.', { stored: { type: 'boolean', description: 'False when this seat sent metrics for the game before.' } }),
  ClientEvent: object('A fault on a page.', {
    kind: strings(['error', 'rejection', 'refusals']),
    message: { type: 'string', minLength: 1, maxLength: 300 },
    version: { type: 'string', minLength: 1, maxLength: 64, description: 'The name of the page script file.' },
  }),
  Count: object('A count by key.', { key: { type: 'string' }, count: count() }),
  StatsFilter: object('The filters of the stats. null means every mode or every level.', {
    scope: strings(STATS_SCOPES, 'everyone: all games. mine: the games of the X-Player id and its linked devices.'),
    range: strings(STATS_RANGES, 'The games of the last 7 or 30 days, or all.'),
    mode: { type: ['string', 'null'], enum: [...SESSION_MODES, null] },
    level: { type: ['string', 'null'], enum: [...DIFFICULTIES, null], description: 'A computer level. It matches computer games only.' },
    person: { ...nullable(person), description: 'The games of one person, or null for every player.' },
  }),
  StatsPrivacy: object('"Hide my stats". It follows your GitHub account when you log in.', {
    private: { type: 'boolean', description: 'True: a person filter with your person id answers 403 to everyone but you. Everyone totals still count your games, without your name.' },
  }),
  Stats: object('The aggregates of the public stats page: counts only, and for scope mine the names of your opponents. The server computes an everyone answer at most once a minute. src/protocol.ts (Stats) has every field.', {
    generatedAt: { type: 'number' },
    totals: { type: 'object', description: 'games, moves, players, accounts, sessions, gamesLast7Days.' },
    perDay: list('The last 60 days, oldest first, UTC.'),
    hours: list('Games per weekday (0 is Monday) and hour, UTC.'),
    byMode: list('Games per mode.', ref('Count')),
    levels: list('Results against each computer level.'),
    lengthByMode: list('Game length per mode.'),
    moveTimes: list('Time between two moves, in buckets.'),
    thinkTimes: list('Median time per move.'),
    firstPlayer: list('Wins of X and O per mode.'),
    openings: list('First moves, per cell.', count()),
    cells: list('All moves, per cell.', count()),
    endings: list('How games end.', ref('Count')),
    hide: list('Hide settings in use.'),
    timeLimits: list('Time limits in use.'),
    tuned: list('Tuned computer games.'),
    metricsGames: count(),
    devices: list('Device kinds.', ref('Count')),
    views: list('Views.', ref('Count')),
    layouts: list('Layouts.', ref('Count')),
    themes: list('Themes.', ref('Count')),
    versions: list('App versions.', ref('Count')),
    input: object('Moves by input.', { board: count(), keypad: count() }),
    refusals: list('Refused actions.', ref('Count')),
    undo: object('Undo use.', { gamesWithUndo: count(), undos: count() }),
    offlineGames: count(),
    nearbyMixes: list('Nearby device mixes.', ref('Count')),
    filter: ref('StatsFilter'),
    person: { ...nullable(object('Whose stats these are.', { name: displayName, player: nullable(ref('PlayerInfo')) })), description: 'The person of a person filter: the name and GitHub account that their games show. null without a person filter.' },
    form: list(`The win rate over time, oldest first: at each game, the share of wins in the ${FORM_WINDOW} games up to it. mine: your games. everyone: the games against the computer, from the player's side.`, object('One game.', { at: { type: 'number' }, rate: { type: 'number', minimum: 0, maximum: 1 } })),
    lengths: list('Games per number of moves. Index n holds the games with n moves.', count()),
    openingWinsX: list('Games that X won, per first move.', count()),
    personal: nullable(object('Your results for scope mine, or the results of the person of a person filter. null for everyone.', {
      survival: list('Your survival records: per level, the most moves of a game that the default computer won.'),
      results: list('Won, drawn and lost per mode and computer level. Friend games have no side, so they are not here.'),
      bestStreak: count('The longest run of won games.'),
      currentStreak: { type: ['object', 'null'], description: 'The run of equal results that ends with your newest game: outcome (won, drawn or lost) and length.' },
      opponents: list('The 5 players that you played most. `player` is a GitHub login or a name. Empty for a person filter.'),
    })),
    practice: object('The sound practice room.', {
      runs: list('Runs, people and the average round time per mode and preset.'),
      best: list('The best 5 people per mode and preset.', ref('PracticeLeader')),
    }),
  }),
  NearbyAnnounce: object(
    'An open Nearby game. The offer code holds the device name and kind of the host.',
    {
      offer: { ...signalCode, pattern: '^T3A1\\.', description: 'A fresh offer code (src/nearby/signal.ts). The server decodes it, and refuses a code that a device cannot read.' },
      id: { ...hostId, description: 'The id from the answer to your last announcement. Leave it out to announce a new game.' },
    },
    ['id'],
  ),
  NearbyAnnounced: object('Your game is in the list.', {
    id: hostId,
    answer: { ...nullable({ ...signalCode, pattern: '^T3B1\\.' }), description: 'The answer code of a guest, or null when no guest came. After an answer, announce again with a fresh offer: an offer takes one answer.' },
  }),
  NearbyHost: object('An open Nearby game on your network.', {
    id: hostId,
    name: { type: 'string', minLength: 1, maxLength: HELLO_NAME_MAX_LENGTH, description: 'The device name of the host.' },
    device: strings(DEVICE_KINDS, 'The kind of device of the host.'),
    age: count('Seconds since the host announced the game.'),
    offer: { ...signalCode, pattern: '^T3A1\\.', description: 'The offer code of the host. Answer it, and send the answer code to the host.' },
  }),
  NearbyHosts: object('The open Nearby games on your network, without your own.', {
    hosts: list('The games.', ref('NearbyHost')),
  }),
  NearbyAnswer: object('The answer of a guest to the offer of a host.', {
    offer: { ...signalCode, pattern: '^T3A1\\.', description: 'The offer code from the list that you answered. A host makes a fresh offer after each guest, so an older offer gets 409.' },
    answer: { ...signalCode, pattern: '^T3B1\\.', description: 'The answer code (src/nearby/signal.ts). The server decodes it, and refuses a code that a device cannot read.' },
  }),
  Playoff: object('A sound playoff: both players sing to the same seeded targets at the same time. The faster total wins.', {
    id: { type: 'integer', minimum: 0, description: 'Grows with each playoff of the session. Requests name it.' },
    seed: { type: 'integer', minimum: 0, maximum: 2 ** 32 - 1, description: 'The seed of the targets (src/practice/practice.ts, targetSteps).' },
    preset: strings(PRESET_IDS),
    by: ref('Player'),
    seats: object('Each seat: joined, and the time in milliseconds of each target that it hit.', {
      X: object('A seat.', { joined: { type: 'boolean' }, times: list('Target times in ms.', { type: 'integer', minimum: 0, maximum: MAX_ROUND_MS }) }),
      O: object('A seat.', { joined: { type: 'boolean' }, times: list('Target times in ms.', { type: 'integer', minimum: 0, maximum: MAX_ROUND_MS }) }),
    }),
    startAt: { type: ['number', 'null'], description: `Server time when the targets start: ${PLAYOFF_COUNTDOWN_MS / 1000} s after both joined. null before.` },
    ended: { type: ['string', 'null'], enum: ['done', 'declined', 'left', null], description: 'done: both hit all targets. declined: the invited player said not now. left: a player stopped.' },
  }),
  PlayoffRequest: {
    description: 'One step of a playoff. Only the two players can send it.',
    oneOf: [
      object('Start a playoff (or a new one). Both seats need a player.', { action: { const: 'start' }, preset: strings(PRESET_IDS), seed: { type: 'integer', minimum: 0, maximum: 2 ** 32 - 1 } }),
      object('Join the playoff of the other player.', { action: { const: 'join' }, id: { type: 'integer', minimum: 0 } }),
      object('Decline or stop the playoff.', { action: { const: 'leave' }, id: { type: 'integer', minimum: 0 } }),
      object('A hit target, in order.', {
        action: { const: 'hit' },
        id: { type: 'integer', minimum: 0 },
        index: { type: 'integer', minimum: 0, maximum: PLAYOFF_TARGETS - 1 },
        ms: { type: 'integer', minimum: 0, maximum: MAX_ROUND_MS },
      }),
    ],
  },
  PracticeRun: object('A finished run of the sound practice room.', {
    id: { type: 'string', pattern: '^[A-Za-z0-9-]{8,64}$', description: 'A random id from the page. The same id again changes nothing.' },
    mode: strings(PRACTICE_MODES, 'targets: sing to the shown cells. echo: hear a cell, then sing to it.'),
    preset: strings(PRESET_IDS),
    roundMs: list(`The time of each round in ms: ${ROUNDS.targets} for targets, ${ROUNDS.echo} for echo.`, { type: 'integer', minimum: 0, maximum: MAX_ROUND_MS }),
    score: { type: 'integer', minimum: 0, maximum: ECHO_POINTS * ROUNDS.echo, description: `Echo: the points (${ECHO_POINTS} for each right cell). Targets: ${ROUNDS.targets}.` },
  }),
  PracticeStored: object('The run result.', { stored: { type: 'boolean', description: 'False when the server has a run with this id from you.' } }),
  PracticeLeader: object('One place of a leaderboard.', {
    mode: strings(PRACTICE_MODES),
    preset: strings(PRESET_IDS),
    rank: { type: 'integer', minimum: 1 },
    player: { type: 'string', description: 'A GitHub login or a generated name.' },
    totalMs: count('The total time of the best run.'),
    score: count('The score of the best run.'),
  }),
  PracticeBoard: object('The best 10 people of one mode and preset: a target run by its total time, an echo run by its points, then its time.', {
    mode: strings(PRACTICE_MODES),
    preset: strings(PRESET_IDS),
    top: list('The best people, best first.', ref('PracticeLeader')),
    you: nullable(object('Your best run, on all your linked devices.', { totalMs: count(), score: count() })),
  }),
  Contributor: object('A GitHub account that worked on a pull request.', {
    login: { type: 'string', minLength: 1, maxLength: 39 },
    avatar: { type: 'string', pattern: '^https://avatars\\.githubusercontent\\.com/' },
    url: { type: 'string', pattern: '^https://github\\.com/', description: 'The GitHub profile.' },
  }),
  Preview: object('An open pull request with a live preview.', {
    number: { type: 'integer', minimum: 1 },
    title: { type: 'string' },
    description: { type: 'string', maxLength: PREVIEW_DESCRIPTION_LENGTH, description: 'The first paragraph of the pull request text, without Markdown.' },
    url: { type: 'string', pattern: '^https://github\\.com/', description: 'The pull request on GitHub.' },
    previewUrl: { type: 'string', pattern: '^https://pr\\.[0-9]+\\.', description: 'The preview site: https://pr.<number>.<domain>.' },
    updatedAt: { type: 'number', description: 'The last change of the pull request, in epoch milliseconds.' },
    draft: { type: 'boolean' },
    contributors: list('The author of the pull request and the commit authors with a GitHub account, most commits first. No bots.', ref('Contributor')),
    parent: {
      ...nullable({ type: 'integer', minimum: 1 }),
      description: 'A stacked pull request: the number of the listed pull request whose head branch is the base branch of this one. null when it is top level. An older server sends no such field.',
    },
  }, ['parent']),
  BlockRequest: object('A block.', { name: { ...displayName, description: 'The name that you saw, for your list of blocked people.' } }),
  Blocks: object('The people that you blocked, newest first. Their messages and names stay hidden on your devices.', {
    blocked: list(
      'The blocked people.',
      object('A blocked person.', { person, name: displayName, at: { type: 'number', description: 'The time of the block, in epoch milliseconds.' } }),
    ),
  }),
  ReportRequest: object(
    'A report of one chat message or one person of an online game. Send `message` or `person`, not both.',
    {
      code: { type: 'string', pattern: `^[${CODE_ALPHABET}${CODE_ALPHABET.toLowerCase()}]{${CODE_LENGTH}}$`, description: 'The session code.' },
      message: { type: 'integer', minimum: 1, description: 'The id of a message in the chat of the session.' },
      person: { ...person, description: 'The person id of a player or watcher in the session now.' },
      reason: strings(REPORT_REASONS, 'spam, abuse, name (an inappropriate name) or other.'),
      note: { type: 'string', maxLength: REPORT_NOTE_MAX_LENGTH, description: `Optional. At most ${REPORT_NOTE_MAX_LENGTH} characters.` },
    },
    ['message', 'person', 'note'],
  ),
  ReportStored: object('The report is stored for the maintainers.', { id: { type: 'integer', minimum: 1 } }),
  Reports: object('The newest reports and moderation actions. Only the maintainers can read them.', {
    reports: list(
      'The newest reports first.',
      object('A report. The text and the name are copies from the time of the report.', {
        id: { type: 'integer', minimum: 1 },
        code: { type: 'string' },
        message: nullable({ type: 'integer' }),
        text: nullable({ type: 'string' }),
        person: nullable(person),
        name: nullable({ type: 'string' }),
        reason: strings(REPORT_REASONS),
        note: nullable({ type: 'string' }),
        reporter: nullable({ ...person, description: 'The person id of the reporter. Null when the reporter deleted their data.' }),
        reporterLogin: nullable({ type: 'string' }),
        at: { type: 'number' },
      }),
    ),
    actions: list(
      'The newest moderation actions first: who did what, and when.',
      object('A moderation action.', {
        login: { type: 'string' },
        action: strings(['hide-message', 'clear-name']),
        code: nullable({ type: 'string' }),
        message: nullable({ type: 'integer' }),
        person: nullable(person),
        at: { type: 'number' },
      }),
    ),
  }),
  Previews: object('The production site and the open pull requests with a live preview, most recently updated first.', {
    main: nullable({ type: 'string', pattern: '^https://', description: 'The production site, built from the main branch. null on a server without previews.' }),
    previews: list('The previews.', ref('Preview')),
    error: nullable({ type: 'string', description: 'Why the list is empty or old, for example when GitHub does not answer.' }),
  }),
};

// ---- Examples ----

const EXAMPLE_CODE = 'AB3K';
const AGENT_A = 'agent-7f3k9q2m4x8w1z5c';
const AGENT_B = 'agent-b2c8n4v6x1q9w3e7';
const T0 = 1_791_200_000_000;
const NO_LIMIT = { perMove: null, perGame: null };
// Real signal codes: a laptop's offer and a phone's answer (server/lobby.test.ts decodes them).
const EXAMPLE_OFFER =
  'T3A1.BcHRCoIwFADQX4n7PKG5qflYaQmKKUYWIrK0bNnaqDH1pW_vnAoi43WAYCXseMq75XxpXYXlxtcFMQkdAUHB51ubH-i5bPieTVEfmNNVhdl9y4fSSnWomvVj17pGhICAAaoq-AWYfsunTo_CisU06mzwGRsBOZTYGNkYE5942MF1jaAFBAk3_N0vPlKKxYspLRXUfw';
const EXAMPLE_ANSWER =
  'T3B1.BcFdD0JQHAfg7_K7_tucw1EuJbHVvCyrlpkhojJnJdRFn73nSRBNWgXC-SkGt1netg_e-YU-2rPxtV7mBYR9-6nKKNBPx6x189m7rsdDIZ2wttv7UfEHR2ZWsymNsXNAKEFJgl-9Ut-hKovY5UEt-p1nq0o8gYSucUacMc3UFkywNCVIEPw-R_oH';
const EXAMPLE_HOST = 'q8Zr2Lx0Vb7Nc4Mw';
const EXAMPLE_PERSON = '3f9a0c27d84be615';
const OTHER_PERSON = 'b71e4d0a92c3f856';

// A view of the example session. Each route changes only the fields that its call changes.
// A taken seat has a generated name.
function view(fields: Record<string, unknown>): Record<string, unknown> {
  const seats = (fields.seats ?? { X: true, O: false }) as Record<'X' | 'O', boolean>;
  return {
    code: EXAMPLE_CODE,
    name: 'Agent match',
    games: [{ moves: [], times: [], clock: NO_LIMIT, timedOut: false }],
    seats,
    you: 'X',
    options: { hideBoard: false, hideHistory: false, hideCoordinates: false },
    locked: false,
    clock: NO_LIMIT,
    fixedSeats: false,
    flipped: [false],
    now: T0,
    version: 1,
    chat: [],
    presence: { X: false, O: false },
    players: { X: null, O: null },
    names: { X: seats.X ? 'braveOtter' : null, O: seats.O ? 'cleverHeron' : null },
    people: { X: seats.X ? EXAMPLE_PERSON : null, O: seats.O ? OTHER_PERSON : null },
    watchers: [],
    youWatcher: null,
    seatRequest: null,
    turn: 'X',
    status: { kind: 'playing' },
    playoff: null,
    ...fields,
  };
}

const game = (moves: number[]) => ({ moves, times: moves.map((_, i) => T0 + 10_000 * (i + 1)), clock: NO_LIMIT, timedOut: false });
// X wins with the vertical line 0, 16, 32, 48. O plays 1, 2, 3.
const X_WINS = [0, 1, 16, 2, 32, 3, 48];

const zeroCount = () => ({ key: 'online', count: 0 });
// The stats of a new server, shortened to one day.
const STATS_EXAMPLE = {
  generatedAt: T0,
  totals: { games: 0, moves: 0, players: 0, accounts: 0, sessions: 0, gamesLast7Days: 0 },
  perDay: [{ day: '2026-10-05', games: 0, players: 0 }],
  hours: [],
  byMode: [zeroCount()],
  levels: [],
  lengthByMode: [],
  moveTimes: [{ bucket: 0, human: 0, computer: 0 }],
  thinkTimes: [],
  firstPlayer: [],
  openings: Array<number>(CELL_COUNT).fill(0),
  cells: Array<number>(CELL_COUNT).fill(0),
  endings: [],
  hide: [],
  timeLimits: [],
  tuned: [],
  metricsGames: 0,
  devices: [],
  views: [],
  layouts: [],
  themes: [],
  versions: [],
  input: { board: 0, keypad: 0 },
  refusals: [],
  undo: { gamesWithUndo: 0, undos: 0 },
  offlineGames: 0,
  nearbyMixes: [],
  filter: { scope: 'everyone', range: 'all', mode: null, level: null, person: null },
  person: null,
  form: [],
  lengths: Array<number>(CELL_COUNT + 1).fill(0),
  openingWinsX: Array<number>(CELL_COUNT).fill(0),
  personal: null,
  practice: { runs: [{ mode: 'targets', preset: 'normal', runs: 1, players: 1, avgRoundMs: 2450 }], best: [] },
};

const PREVIEWS_EXAMPLE = {
  main: 'https://tick3d.yarden-zamir.com',
  previews: [
    {
      number: 17,
      title: 'feat: a sound set menu',
      description: 'A sound set menu next to the Sound button. The default stays Cells.',
      url: 'https://github.com/Yarden-zamir/tick3d/pull/17',
      previewUrl: 'https://pr.17.tick3d.yarden-zamir.com',
      updatedAt: T0,
      draft: false,
      contributors: [{ login: 'octocat', avatar: 'https://avatars.githubusercontent.com/u/583231?v=4', url: 'https://github.com/octocat' }],
      parent: null,
    },
    {
      number: 18,
      title: 'feat: a sound set preview',
      description: 'Plays a short sample of each set. It builds on the sound set menu.',
      url: 'https://github.com/Yarden-zamir/tick3d/pull/18',
      previewUrl: 'https://pr.18.tick3d.yarden-zamir.com',
      updatedAt: T0,
      draft: true,
      contributors: [{ login: 'octocat', avatar: 'https://avatars.githubusercontent.com/u/583231?v=4', url: 'https://github.com/octocat' }],
      parent: 17,
    },
  ],
  error: null,
};

// ---- Routes ----

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type RouteId = `${Method} /api/${string}`;

type Query = { description: string; required: boolean; schema: Schema; example: string };

type Response =
  | { status: 200 | 201; description: string; schema: SchemaName; example: unknown }
  | { status: 200 | 302; description: string; contentType: string | null };

export type Route = {
  operationId: string;
  tag: 'Play' | 'Nearby' | 'Docs' | 'Account' | 'Safety';
  summary: string;
  description?: string;
  // The X-Player header: your player id. It is your seat.
  player: 'required' | 'optional' | 'none';
  query?: Record<string, Query>;
  body?: { schema: SchemaName; example: unknown };
  response: Response;
  errors: readonly { status: number; when: string }[];
  // The X-Player value in the example, when the route reads one.
  examplePlayer?: string;
  // The route accepts an Idempotency-Key header (server/idempotency.ts): a repeat gets the first answer.
  idempotencyKey?: true;
};

// Path parameters, by the name in braces in a route path.
export const PATH_PARAMS: Record<string, { description: string; schema: Schema; example: string }> = {
  code: {
    description: `The session code: ${CODE_LENGTH} letters or digits. Lower case also works.`,
    schema: { type: 'string', pattern: `^[${CODE_ALPHABET}${CODE_ALPHABET.toLowerCase()}]{${CODE_LENGTH}}$` },
    example: EXAMPLE_CODE,
  },
  id: {
    description: 'The id of a finished game: <CODE>-<n> for an online game (n counts from 1), or 8 characters for another game.',
    schema: { type: 'string' },
    example: `${EXAMPLE_CODE}-1`,
  },
  login: {
    description: 'A GitHub login. Upper and lower case match.',
    schema: { type: 'string', pattern: '^[A-Za-z0-9-]{1,39}$' },
    example: 'octocat',
  },
  person: {
    description: 'A public person id, from `people`, `watchers` or a chat message of a session.',
    schema: { type: 'string', pattern: `^[0-9a-f]{${PERSON_ID_LENGTH}}$` },
    example: EXAMPLE_PERSON,
  },
  message: {
    description: 'The id of a chat message.',
    schema: { type: 'integer', minimum: 1 },
    example: '3',
  },
  host: {
    description: 'The id of a Nearby host, from GET /api/nearby/hosts.',
    schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{16}$' },
    example: EXAMPLE_HOST,
  },
};

const BAD_PLAYER = { status: 400, when: 'The X-Player header is missing or not 16 to 64 characters from a-z, 0-9 and "-", or it starts with "account-".' };
const BAD_CODE = { status: 400, when: 'The code is not 4 letters or digits.' };
const NO_GAME = { status: 404, when: 'No game has this code.' };
const NOT_A_PLAYER = { status: 403, when: 'You hold no seat in this game. Watchers only read.' };
const BAD_BODY = { status: 400, when: 'The body is not valid JSON, or a field is wrong.' };
const TOO_BIG = { status: 413, when: 'The body is larger than 4 kB.' };
const MAINTAINER_401 = { status: 401, when: 'The request has no GitHub login.' };
const MAINTAINER_403 = { status: 403, when: 'The GitHub login is not a maintainer.' };
const NO_LOGIN = { status: 404, when: 'This server has no GitHub login.' };
// The errors of the Idempotency-Key header, for every route that accepts it.
const KEY_ERRORS = [
  { status: 400, when: 'The Idempotency-Key header is not valid.' },
  { status: 409, when: 'The first request with this Idempotency-Key still runs.' },
  { status: 422, when: 'This Idempotency-Key came with another request before.' },
];

export const ROUTES = {
  'POST /api/sessions': {
    operationId: 'createSession',
    tag: 'Play',
    summary: 'Create a game.',
    description: `You take seat X, and X moves first. The first other player who joins takes seat O. Share the link /?code=<code>. One address can create ${CREATES_PER_HOUR} sessions per hour.`,
    player: 'required',
    idempotencyKey: true,
    body: { schema: 'NewSession', example: { name: 'Agent match' } },
    response: { status: 201, description: 'The new session.', schema: 'SessionView', example: view({}) },
    errors: [BAD_PLAYER, BAD_BODY, TOO_BIG, { status: 429, when: `This address created ${CREATES_PER_HOUR} sessions in the last hour.` }, ...KEY_ERRORS],
    examplePlayer: AGENT_A,
  },
  'GET /api/sessions/{code}': {
    operationId: 'getSession',
    tag: 'Play',
    summary: 'Read a session. With ?wait=<version>, wait for a change first.',
    description: `Without wait, the answer comes at once. With wait, the server holds the request until the session version is greater than the version you send, or until about ${WAIT_MS / 1000} s pass. Then it sends the session. Compare the version in the answer to see if something changed. Anybody with the code can read. The X-Player header only sets "you".`,
    player: 'optional',
    query: {
      wait: {
        description: 'A version that you saw. The answer waits until the version is greater.',
        required: false,
        schema: { type: 'integer', minimum: 0 },
        example: '6',
      },
    },
    response: {
      status: 200,
      description: 'The session. In this example, X won the live game, so turn is null.',
      schema: 'SessionView',
      example: view({
        games: [game(X_WINS)],
        seats: { X: true, O: true },
        version: 9,
        chat: [{ id: 1, from: 'O', text: 'Good game!', at: T0 + 75_000 }],
        turn: null,
        status: { kind: 'won', winner: 'X', line: [0, 16, 32, 48] },
      }),
    },
    errors: [BAD_CODE, { status: 400, when: 'wait is not a whole number of 0 or more.' }, NO_GAME, { status: 503, when: 'Too many requests wait now. Try again in a few seconds.' }],
    examplePlayer: AGENT_A,
  },
  'POST /api/sessions/{code}/join': {
    operationId: 'joinSession',
    tag: 'Play',
    summary: 'Take a free seat.',
    description: 'You get seat O when the creator holds X. When you hold a seat already, you keep it. Your X-Player id holds the seat from now on.',
    player: 'required',
    idempotencyKey: true,
    response: { status: 200, description: 'The session. "you" shows your seat.', schema: 'SessionView', example: view({ seats: { X: true, O: true }, you: 'O', version: 2 }) },
    errors: [BAD_PLAYER, BAD_CODE, NO_GAME, { status: 409, when: 'Both seats are taken. You can still read the game.' }, ...KEY_ERRORS],
    examplePlayer: AGENT_B,
  },
  'POST /api/sessions/{code}/moves': {
    operationId: 'makeMove',
    tag: 'Play',
    summary: 'Make a move in the live game.',
    description: 'Send the index of the live game and the number of moves that you saw. When they do not match the session, another move came first: read the session again. When your own move is already at that place, the 409 has the code "already-played": an earlier copy of this request counted.',
    player: 'required',
    idempotencyKey: true,
    body: { schema: 'MoveRequest', example: { game: 0, moveCount: 0, cell: 21 } },
    response: {
      status: 200,
      description: 'The session after your move.',
      schema: 'SessionView',
      example: view({ games: [game([21])], seats: { X: true, O: true }, version: 3, turn: 'O' }),
    },
    errors: [
      BAD_PLAYER,
      BAD_CODE,
      { status: 400, when: 'game, moveCount or cell is missing or out of range.' },
      NOT_A_PLAYER,
      NO_GAME,
      { status: 409, when: 'It is not your turn, the cell is taken, the board changed, the game is over, or time is up.' },
      { status: 409, when: 'Code "already-played": this move is in the game already.' },
      ...KEY_ERRORS,
    ],
    examplePlayer: AGENT_A,
  },
  'POST /api/sessions/{code}/games': {
    operationId: 'newGame',
    tag: 'Play',
    summary: 'Start the next game.',
    description:
      'Either player can start the next game after the live game ends. Then the players swap X and O, so the player who was O moves first, unless fixedSeats is true. Read `you` again from this answer: your seat can change.',
    player: 'required',
    idempotencyKey: true,
    response: {
      status: 200,
      description: 'The session with a new, empty live game.',
      schema: 'SessionView',
      example: view({ games: [game(X_WINS), game([])], flipped: [true, false], seats: { X: true, O: true }, you: 'O', version: 10 }),
    },
    errors: [BAD_PLAYER, BAD_CODE, NOT_A_PLAYER, NO_GAME, { status: 409, when: 'The live game is not over, or the settings are locked until it ends.' }, ...KEY_ERRORS],
    examplePlayer: AGENT_A,
  },
  'POST /api/sessions/{code}/chat': {
    operationId: 'sendChat',
    tag: 'Play',
    summary: 'Send a chat message.',
    description: `Only the two players can write. The session keeps the newest ${CHAT_KEEP} messages.`,
    player: 'required',
    idempotencyKey: true,
    body: { schema: 'ChatRequest', example: { text: 'Good luck!' } },
    response: {
      status: 200,
      description: 'The session with your message.',
      schema: 'SessionView',
      example: view({ seats: { X: true, O: true }, version: 3, chat: [{ id: 1, from: 'X', text: 'Good luck!', at: T0 + 5000 }] }),
    },
    errors: [BAD_PLAYER, BAD_CODE, { status: 400, when: `The text is empty or longer than ${CHAT_MAX_LENGTH} characters.` }, NOT_A_PLAYER, NO_GAME, ...KEY_ERRORS],
    examplePlayer: AGENT_A,
  },
  'POST /api/sessions/{code}/playoff': {
    operationId: 'playoff',
    tag: 'Play',
    summary: 'Start, join, leave or report a sound playoff (the practice room of the page).',
    description: `Only the two players. start makes a new playoff with you joined, and the other player sees it in the session. When both joined, the targets start ${PLAYOFF_COUNTDOWN_MS / 1000} s later (startAt). Each page then sends a hit for each target, in order. When both sent ${PLAYOFF_TARGETS} hits, the faster total wins. A request for an older playoff id changes nothing.`,
    player: 'required',
    body: { schema: 'PlayoffRequest', example: { action: 'start', preset: 'normal', seed: 123_456_789 } },
    response: {
      status: 200,
      description: 'The session with the playoff.',
      schema: 'SessionView',
      example: view({
        seats: { X: true, O: true },
        version: 4,
        playoff: { id: 1, seed: 123_456_789, preset: 'normal', by: 'X', seats: { X: { joined: true, times: [] }, O: { joined: false, times: [] } }, startAt: null, ended: null },
      }),
    },
    errors: [BAD_PLAYER, BAD_CODE, { status: 400, when: 'The request is not one of start, join, leave or hit, or a field is wrong.' }, NOT_A_PLAYER, NO_GAME, { status: 409, when: 'An empty seat, a running playoff, a hit before the start or out of order, or a session that is not online.' }],
    examplePlayer: AGENT_A,
  },
  'PATCH /api/sessions/{code}': {
    operationId: 'updateSession',
    tag: 'Play',
    summary: 'Rename a session, or change its options, time limit or seat rotation.',
    description: 'A new time limit starts with the next game. `fixedSeats` decides if X and O swap for each new game. During a lock, only the name can change.',
    player: 'required',
    idempotencyKey: true,
    body: { schema: 'SessionUpdate', example: { name: 'Rematch' } },
    response: { status: 200, description: 'The changed session.', schema: 'SessionView', example: view({ name: 'Rematch', seats: { X: true, O: true }, version: 3 }) },
    errors: [BAD_PLAYER, BAD_CODE, BAD_BODY, NOT_A_PLAYER, NO_GAME, { status: 409, when: 'The settings are locked until the live game ends.' }, ...KEY_ERRORS],
    examplePlayer: AGENT_A,
  },
  'POST /api/sessions/{code}/lock': {
    operationId: 'lockSession',
    tag: 'Play',
    summary: 'Lock the settings until the live game ends.',
    player: 'required',
    idempotencyKey: true,
    response: { status: 200, description: 'The locked session.', schema: 'SessionView', example: view({ seats: { X: true, O: true }, locked: true, version: 3 }) },
    errors: [BAD_PLAYER, BAD_CODE, NOT_A_PLAYER, NO_GAME, { status: 409, when: 'The live game is over, or a seat is still empty.' }, ...KEY_ERRORS],
    examplePlayer: AGENT_A,
  },
  'POST /api/sessions/{code}/seats': {
    operationId: 'changeSeats',
    tag: 'Play',
    summary: 'Change the seats (swap, leave, give, seat, unseat, replace), or ask to take back your last move (undo).',
    description: `Only a player can change the seats. A change of your own seat, or of an empty seat, applies at once. A change of the seat of the other player (swap, unseat, replace) and an undo wait in \`seatRequest\` until the other player accepts with POST /api/sessions/{code}/seats/answer. It ends after ${SEAT_REQUEST_MS / 1000} s. A new request replaces your older one. A swap is allowed during a game: each clock stays with its seat. Watchers come from \`watchers\` in the session.`,
    player: 'required',
    idempotencyKey: true,
    body: { schema: 'SeatAction', example: { action: 'swap' } },
    response: {
      status: 200,
      description: 'The session. In this example, the swap waits for the other player.',
      schema: 'SessionView',
      example: view({ seats: { X: true, O: true }, version: 3, seatRequest: { kind: 'swap', from: 'X', watcher: null, expiresAt: T0 + SEAT_REQUEST_MS } }),
    },
    errors: [
      BAD_PLAYER,
      BAD_CODE,
      { status: 400, when: 'The action is unknown, or the watcher is missing or not needed.' },
      NOT_A_PLAYER,
      { status: 404, when: 'No game has this code, or the watcher left.' },
      { status: 409, when: 'The seat is not free or not taken as the action needs, the other player asked first, the game is not online, or an undo does not apply (not your last move, a timed or finished game, a lock).' },
      ...KEY_ERRORS,
    ],
    examplePlayer: AGENT_A,
  },
  'POST /api/sessions/{code}/seats/answer': {
    operationId: 'answerSeats',
    tag: 'Play',
    summary: 'Accept or decline the open seat request.',
    description: 'The other player accepts or declines. The player who asked can only cancel, with accept false. Accept checks the request again and then applies it.',
    player: 'required',
    idempotencyKey: true,
    body: { schema: 'SeatAnswer', example: { accept: true } },
    response: {
      status: 200,
      description: 'The session. In this example, the swap applied: your seat is now X.',
      schema: 'SessionView',
      example: view({ seats: { X: true, O: true }, version: 4, names: { X: 'cleverHeron', O: 'braveOtter' } }),
    },
    errors: [
      BAD_PLAYER,
      BAD_CODE,
      BAD_BODY,
      NOT_A_PLAYER,
      NO_GAME,
      { status: 409, when: 'No request is open, only the other player can accept, or the request no longer applies.' },
      ...KEY_ERRORS,
    ],
    examplePlayer: AGENT_B,
  },
  'GET /api/sessions/{code}/events': {
    operationId: 'sessionEvents',
    tag: 'Play',
    summary: 'A server-sent event stream for the page.',
    description: 'Each "data: changed" event means: read the session again. The page uses this stream. An open stream marks its seat as present, or lists its player in `watchers`. An agent can use ?wait on GET /api/sessions/{code} instead.',
    player: 'none',
    query: {
      player: { description: 'Your player id. A browser EventSource cannot send headers.', required: false, schema: { type: 'string' }, example: AGENT_A },
    },
    response: { status: 200, description: 'A text/event-stream that stays open.', contentType: 'text/event-stream' },
    errors: [BAD_CODE, NO_GAME, { status: 503, when: 'Too many open streams.' }],
  },
  'GET /api/games/{id}': {
    operationId: 'getGame',
    tag: 'Play',
    summary: 'Read one finished game, read-only.',
    description: 'Anybody with the id can read it. The game link for a person is /?game=<id>. For game n of an online session (n counts from 1), the id is <CODE>-<n>.',
    player: 'none',
    response: {
      status: 200,
      description: 'The finished game.',
      schema: 'PublicGame',
      example: {
        id: `${EXAMPLE_CODE}-1`,
        mode: 'online',
        game: game(X_WINS),
        options: { hideBoard: false, hideHistory: false, hideCoordinates: false },
        difficulty: null,
        tuned: false,
        computer: null,
        players: { X: null, O: null },
        names: { X: 'braveOtter', O: 'cleverHeron' },
        finishedAt: T0 + 70_000,
      },
    },
    errors: [{ status: 400, when: 'The id is not 8 letters or digits, or a code and a game number.' }, { status: 404, when: 'No finished game has this id.' }],
  },
  'POST /api/games/{id}/metrics': {
    operationId: 'sendGameMetrics',
    tag: 'Account',
    summary: 'Send what your device saw during a finished online game. The page uses it for the stats page.',
    description: 'Only a player of the game can send, and only the first report of each seat counts.',
    player: 'required',
    body: {
      schema: 'Metrics',
      example: {
        device: 'computer',
        view: 'tower',
        layout: 'grid',
        theme: 'light',
        input: { board: 4, keypad: 0 },
        refused: { occupied: 1 },
        undos: 0,
        thinkMs: [],
        offline: false,
        version: 'index-B2x9kQ',
        tuning: null,
        nearby: null,
      },
    },
    response: { status: 200, description: 'Whether the server kept the report.', schema: 'MetricsResponse', example: { stored: true } },
    errors: [
      BAD_PLAYER,
      { status: 400, when: 'The id is not an online game id, or the metrics are not valid.' },
      { status: 403, when: 'You did not play this game.' },
      { status: 404, when: 'No finished game has this id.' },
    ],
    examplePlayer: AGENT_A,
  },
  'GET /api/me/history': {
    operationId: 'myHistory',
    tag: 'Account',
    summary: `Your finished games, ${HISTORY_PAGE_SIZE} per page, newest first.`,
    description: 'The history follows your GitHub account when you log in on the page, else your player id.',
    player: 'required',
    query: { offset: { description: 'How many newer games to skip. Default 0.', required: false, schema: { type: 'integer', minimum: 0 }, example: '0' } },
    response: {
      status: 200,
      description: 'One page of your history.',
      schema: 'HistoryPage',
      example: {
        games: [{ id: `${EXAMPLE_CODE}-1`, mode: 'online', difficulty: null, result: 'won', moves: 7, opponent: null, opponentName: 'cleverHeron', finishedAt: T0 + 70_000 }],
        more: false,
      },
    },
    errors: [BAD_PLAYER, { status: 400, when: 'The offset is not a whole number of 0 or more.' }],
    examplePlayer: AGENT_A,
  },
  'DELETE /api/me/history': {
    operationId: 'clearHistory',
    tag: 'Account',
    summary: 'Clear your history.',
    description: 'Your games leave your history. They stay for the other player and in the stats.',
    player: 'required',
    response: { status: 200, description: 'How many games left your history.', schema: 'Hidden', example: { hidden: 1 } },
    errors: [BAD_PLAYER],
    examplePlayer: AGENT_A,
  },
  'GET /api/me/records': {
    operationId: 'myRecords',
    tag: 'Account',
    summary: 'Your survival records against the computer.',
    player: 'required',
    response: {
      status: 200,
      description: 'The most moves before the computer won, per setup.',
      schema: 'Records',
      example: { records: { 'hard|game:none|move:none|board:false|history:false': 23 } },
    },
    errors: [BAD_PLAYER],
    examplePlayer: AGENT_A,
  },
  'POST /api/events': {
    operationId: 'reportFault',
    tag: 'Account',
    summary: 'Report a fault on a page, for the stats page. The page uses it.',
    description: `At most 1 kB. One address can send ${EVENTS_PER_10_MINUTES} reports per 10 minutes.`,
    player: 'none',
    body: { schema: 'ClientEvent', example: { kind: 'error', message: 'TypeError: x is undefined (index-B2x9kQ.js:1:200)', version: 'index-B2x9kQ' } },
    response: { status: 200, description: 'Stored.', schema: 'Ok', example: { ok: true } },
    errors: [
      { status: 400, when: 'The event needs a kind, a message of 1 to 300 characters and a version.' },
      { status: 413, when: 'The body is larger than 1 kB.' },
      { status: 429, when: `This address sent ${EVENTS_PER_10_MINUTES} reports in the last 10 minutes.` },
    ],
  },
  'POST /api/practice/runs': {
    operationId: 'addPracticeRun',
    tag: 'Account',
    summary: 'Store a finished practice run of the Voice room (/sound-input). The page uses it.',
    description: `One address can send ${PRACTICE_RUNS_PER_10_MINUTES} runs per 10 minutes. The leaderboards and the stats page count them.`,
    player: 'required',
    body: {
      schema: 'PracticeRun',
      example: { id: 'run-6f1d2c9a', mode: 'targets', preset: 'normal', roundMs: [2100, 1850, 3020, 2400, 1990, 2760, 2210, 1580, 3300, 2040], score: 10 },
    },
    response: { status: 200, description: 'Stored, or already stored.', schema: 'PracticeStored', example: { stored: true } },
    errors: [BAD_PLAYER, { status: 400, when: 'The run is not one that the page can make.' }, TOO_BIG, { status: 429, when: `This address sent ${PRACTICE_RUNS_PER_10_MINUTES} runs in the last 10 minutes.` }],
    examplePlayer: AGENT_A,
  },
  'GET /api/practice/best': {
    operationId: 'practiceBest',
    tag: 'Account',
    summary: 'The leaderboard of one mode and preset of the sound practice room.',
    player: 'optional',
    query: {
      mode: { description: 'targets or echo.', required: true, schema: strings(PRACTICE_MODES), example: 'targets' },
      preset: { description: 'easy, normal or hard.', required: true, schema: strings(PRESET_IDS), example: 'normal' },
    },
    response: {
      status: 200,
      description: 'The best 10 people, and your own best run when you send X-Player.',
      schema: 'PracticeBoard',
      example: {
        mode: 'targets',
        preset: 'normal',
        top: [{ mode: 'targets', preset: 'normal', rank: 1, player: 'octocat', totalMs: 21_400, score: 10 }],
        you: { totalMs: 24_250, score: 10 },
      },
    },
    errors: [{ status: 400, when: 'mode or preset is missing or unknown.' }, BAD_PLAYER],
    examplePlayer: AGENT_A,
  },
  'GET /api/stats': {
    operationId: 'stats',
    tag: 'Account',
    summary: 'The aggregates of the public stats page at /stats.',
    description: 'The query takes the same filters as the address of the page. Leave a key out for its default. Scope mine needs the X-Player header. A person filter reads the X-Player header when it is there: a person who hides their stats still sees their own.',
    player: 'optional',
    query: {
      scope: { description: 'everyone (the default) or mine.', required: false, schema: strings(STATS_SCOPES), example: 'mine' },
      range: { description: '7d, 30d or all (the default).', required: false, schema: strings(STATS_RANGES), example: '30d' },
      mode: { description: 'One mode. Leave it out for every mode.', required: false, schema: strings(SESSION_MODES), example: 'computer' },
      level: { description: 'One computer level, only with mode computer or without a mode.', required: false, schema: strings(DIFFICULTIES), example: 'hard' },
      person: { description: 'The games of one person, by public person id. Not with scope mine.', required: false, schema: person, example: OTHER_PERSON },
    },
    response: { status: 200, description: 'Counts only. Scope mine adds the names of your opponents. No token, result id, game id or page fault.', schema: 'Stats', example: STATS_EXAMPLE },
    errors: [
      { status: 400, when: 'A key is unknown or repeated, a value is unknown, or a level comes with a mode other than computer.' },
      { ...BAD_PLAYER, when: `Scope mine only, or a person filter with an invalid header. ${BAD_PLAYER.when}` },
      { status: 403, when: 'A person filter: that person hides their stats ("Hide my stats" in My games).' },
      { status: 404, when: 'A person filter: no account and no finished game has that person id.' },
    ],
    examplePlayer: AGENT_A,
  },
  'GET /api/previews': {
    operationId: 'previews',
    tag: 'Account',
    summary: 'The open pull requests that have a live preview. The kitshn button of the page uses it.',
    description: `Production reads GitHub at most once per ${PREVIEWS_CACHE_MS / 60_000} minutes, and keeps the last list when GitHub fails. A preview server returns the list of production, at most ${PREVIEWS_RELAY_CACHE_MS / 1000} seconds old, and makes no GitHub call. A preview is live when its /api/health answers. A server without previews (a LAN host) returns an empty list with an error.`,
    player: 'none',
    response: { status: 200, description: 'The previews. Never an error status: a problem goes in `error`.', schema: 'Previews', example: PREVIEWS_EXAMPLE },
    errors: [],
  },
  'GET /api/health': {
    operationId: 'health',
    tag: 'Docs',
    summary: 'Check that the server is up.',
    player: 'none',
    response: { status: 200, description: 'The server is up.', schema: 'Health', example: { ok: true, lan: null } },
    errors: [],
  },
  'GET /api/docs': {
    operationId: 'docsHtml',
    tag: 'Docs',
    summary: 'This document as a Swagger UI web page, with "Try it out".',
    player: 'none',
    response: { status: 200, description: 'HTML.', contentType: 'text/html' },
    errors: [],
  },
  'GET /api/openapi.json': {
    operationId: 'openApi',
    tag: 'Docs',
    summary: 'This OpenAPI 3.1 document. Its info.description holds the guide.',
    player: 'none',
    response: { status: 200, description: 'An OpenAPI document.', contentType: 'application/json' },
    errors: [],
  },
  'GET /api/me': {
    operationId: 'me',
    tag: 'Account',
    summary: 'Your GitHub login state. The page uses it.',
    description: 'A login cookie from the page links your player id to a GitHub account. A client without a page login gets null.',
    player: 'required',
    response: { status: 200, description: 'Your login state.', schema: 'Me', example: { loginAvailable: true, user: null, name: 'Agent Smith' } },
    errors: [BAD_PLAYER],
    examplePlayer: AGENT_A,
  },
  'DELETE /api/me': {
    operationId: 'deleteMyData',
    tag: 'Account',
    summary: 'Delete your data on the server, at once. This logs you out.',
    description: `With a GitHub login on the page, this deletes the data of the account on every device, else the data of your player id. It deletes your uploaded games, custom name, blocks, practice runs, game metrics and the account. A game with another player stays for that player, without your id. Your seats in online sessions become free, and a session without a player and without a move goes. Your chat messages keep their place, with the text "Deleted by its author." in place of yours. A report that you filed stays without your id, and reports about you stay for the maintainers. A second call deletes nothing. One address can call this ${DATA_DELETES_PER_HOUR} times per hour.`,
    player: 'required',
    response: {
      status: 200,
      description: 'Deleted. The counts per table.',
      schema: 'DeletedData',
      example: Object.fromEntries(DATA_TABLES.map((table) => [table, { deleted: table === 'results' ? 2 : 0, anonymised: table === 'results' || table === 'sessions' ? 1 : 0 }])),
    },
    errors: [BAD_PLAYER, { status: 429, when: `This address deleted data ${DATA_DELETES_PER_HOUR} times in the last hour.` }],
    examplePlayer: AGENT_A,
  },
  'GET /api/deleted': {
    operationId: 'deletedPeople',
    tag: 'Account',
    summary: 'The players who deleted their data since a time. The page uses it to clean its own copies.',
    description: 'A notice stays for a year. A page that keeps copies of games (cached online games, a Nearby host) removes the name, the picture and the chat lines of these people.',
    player: 'none',
    query: { since: { description: 'Epoch ms: the `until` of the last answer, or 0 for every notice.', required: true, schema: { type: 'integer', minimum: 0 }, example: '0' } },
    response: { status: 200, description: 'The notices.', schema: 'DeletedPeople', example: { people: [EXAMPLE_PERSON], until: T0 } },
    errors: [{ status: 400, when: 'since is not a whole number of 0 or more.' }],
  },
  'PUT /api/me/name': {
    operationId: 'setName',
    tag: 'Account',
    summary: 'Choose your display name.',
    description: 'Without a GitHub login, other players see this name in place of your generated name. A GitHub login still goes first.',
    player: 'required',
    body: { schema: 'NameRequest', example: { name: 'Agent Smith' } },
    response: { status: 200, description: 'Your login state with the new name.', schema: 'Me', example: { loginAvailable: true, user: null, name: 'Agent Smith' } },
    errors: [BAD_PLAYER, { status: 400, when: 'The name is not valid.' }, { status: 409, when: 'The name is the login of a GitHub account.' }],
    examplePlayer: AGENT_A,
  },
  'DELETE /api/me/name': {
    operationId: 'clearName',
    tag: 'Account',
    summary: 'Go back to your generated name.',
    player: 'required',
    response: { status: 200, description: 'Your login state without a custom name.', schema: 'Me', example: { loginAvailable: true, user: null, name: null } },
    errors: [BAD_PLAYER],
    examplePlayer: AGENT_A,
  },
  'GET /api/me/games': {
    operationId: 'myGames',
    tag: 'Account',
    summary: 'Your stats and online sessions.',
    player: 'required',
    response: {
      status: 200,
      description: 'Stats per mode and level, and the sessions that you hold a seat in, newest first.',
      schema: 'MyGames',
      example: {
        user: null,
        total: { played: 1, won: 1, lost: 0, drawn: 0 },
        byMode: {
          online: { played: 1, won: 1, lost: 0, drawn: 0 },
          computer: { played: 0, won: 0, lost: 0, drawn: 0 },
          friend: { played: 0, won: 0, lost: 0, drawn: 0 },
          nearby: { played: 0, won: 0, lost: 0, drawn: 0 },
        },
        byDifficulty: {
          easy: { played: 0, won: 0, lost: 0, drawn: 0 },
          medium: { played: 0, won: 0, lost: 0, drawn: 0 },
          hard: { played: 0, won: 0, lost: 0, drawn: 0 },
        },
        sessions: [{ code: EXAMPLE_CODE, name: 'Agent match', games: 1, you: 'X', opponent: null, opponentName: 'cleverHeron', yourTurn: false, updatedAt: T0 + 70_000 }],
      },
    },
    errors: [BAD_PLAYER],
    examplePlayer: AGENT_A,
  },
  'POST /api/results': {
    operationId: 'uploadResults',
    tag: 'Account',
    summary: 'Store finished games that a device played away from the server. The page uses it.',
    player: 'required',
    body: {
      schema: 'ResultsRequest',
      example: {
        results: [
          {
            id: 'result-5d1c9e7a3b2f4086',
            mode: 'computer',
            game: game(X_WINS),
            you: 'X',
            difficulty: 'easy',
            finishedAt: T0 + 70_000,
            publicId: 'Q7MZ4KTB',
            options: { hideBoard: false, hideHistory: false },
            tuned: false,
            metrics: null,
          },
          {
            id: 'result-8b3e1f6a0c7d2945',
            mode: 'nearby',
            game: game(X_WINS),
            you: 'X',
            difficulty: null,
            finishedAt: T0 + 90_000,
            publicId: 'R4NW8HCZ',
            options: { hideBoard: false, hideHistory: false },
            tuned: false,
            metrics: null,
            guest: AGENT_B,
          },
        ],
      },
    },
    response: {
      status: 200,
      description: 'How many results were new, and the public ids that the server changed.',
      schema: 'ResultsResponse',
      example: { stored: 2, renamed: {} },
    },
    errors: [BAD_PLAYER, { status: 400, when: `There is no results list, it has more than ${RESULTS_PER_UPLOAD} results, a result is not a valid finished game, or a guest is your own player id.` }, { status: 413, when: 'The body is larger than 256 kB.' }],
    examplePlayer: AGENT_A,
  },
  'GET /api/auth/login': {
    operationId: 'login',
    tag: 'Account',
    summary: 'Start a GitHub login in a browser.',
    player: 'none',
    query: { return: { description: 'The page to return to after the login.', required: false, schema: { type: 'string' }, example: 'https://tick3d.yarden-zamir.com/' } },
    response: { status: 302, description: 'A redirect to GitHub.', contentType: null },
    errors: [{ status: 404, when: 'This server has no GitHub login.' }],
  },
  'GET /api/auth/github/callback': {
    operationId: 'loginCallback',
    tag: 'Account',
    summary: 'GitHub returns the browser here after a login.',
    player: 'none',
    response: { status: 302, description: 'A redirect back to the page, with a login cookie.', contentType: null },
    errors: [{ status: 404, when: 'This server has no GitHub login.' }],
  },
  'POST /api/auth/logout': {
    operationId: 'logout',
    tag: 'Account',
    summary: 'Log this browser out of its GitHub account.',
    description:
      'The other devices of the account stay logged in. The account keeps everything that this X-Player id played: every seat that holds the id, and every finished game that names it, also games from before the login. After the logout, the history, stats and survival records of this id are empty. The page then deletes its copies of the uploaded results, the survival records and the cached online games.',
    player: 'required',
    response: { status: 200, description: 'Logged out.', schema: 'Ok', example: { ok: true } },
    errors: [BAD_PLAYER, { status: 404, when: 'This server has no GitHub login.' }],
    examplePlayer: AGENT_A,
  },
  'GET /api/nearby/hosts': {
    operationId: 'nearbyHosts',
    tag: 'Nearby',
    summary: 'The open Nearby games on your network. The page uses it.',
    description: 'The list holds only the games that hosts announced from your network: the same IPv4 address, or the same IPv6 /64 prefix. It never holds your own games (by your X-Player id), and it holds no player ids. To join a game, answer its offer code and send the answer with POST /api/nearby/hosts/{host}/answer. The page reads the list every few seconds.',
    player: 'optional',
    response: {
      status: 200,
      description: 'The games, oldest first. Empty when no host on your network announced a game.',
      schema: 'NearbyHosts',
      example: { hosts: [{ id: EXAMPLE_HOST, name: 'Living room laptop', device: 'computer', age: 42, offer: EXAMPLE_OFFER }] },
    },
    errors: [{ status: 400, when: 'The server cannot tell the network of your request.' }],
    examplePlayer: AGENT_B,
  },
  'POST /api/nearby/hosts': {
    operationId: 'announceNearbyHost',
    tag: 'Nearby',
    summary: 'Put your open Nearby game in the list of your network, and wait for a guest. The page uses it.',
    description: `A web page cannot find other devices on a local network, so a host announces its game here. Without an id, the answer comes at once with the id of your game. Send the next request at once, with that id: the server holds it until a guest sends an answer, or for about ${WAIT_MS / 1000} s. Then send the next one, and so on. Your game stays in the list while a request is open, and for ${NEARBY_GRACE_MS / 1000} s after one ends. When the request closes early (you left), your game leaves the list at once. An offer takes one answer: after an answer, send a fresh offer. One network can have ${NEARBY_HOSTS_PER_NETWORK} games in the list, and send ${NEARBY_CALLS_PER_10_MINUTES} announcements and answers per 10 minutes.`,
    player: 'required',
    body: { schema: 'NearbyAnnounce', example: { offer: EXAMPLE_OFFER, id: EXAMPLE_HOST } },
    response: { status: 200, description: 'Your game is in the list (without an id), a guest answered, or the wait ended.', schema: 'NearbyAnnounced', example: { id: EXAMPLE_HOST, answer: EXAMPLE_ANSWER } },
    errors: [
      BAD_PLAYER,
      { status: 400, when: 'The body is not valid JSON, the offer is not a valid offer code, or the server cannot tell the network of your request.' },
      { status: 404, when: 'The id is not in the list any more, or it is not yours. Announce again without an id.' },
      TOO_BIG,
      { status: 429, when: `Your network has ${NEARBY_HOSTS_PER_NETWORK} games in the list, or sent ${NEARBY_CALLS_PER_10_MINUTES} Nearby calls in the last 10 minutes.` },
      { status: 503, when: 'Too many games are in the list on this server.' },
    ],
    examplePlayer: AGENT_A,
  },
  'GET /api/me/stats-privacy': {
    operationId: 'myStatsPrivacy',
    tag: 'Account',
    summary: 'Whether you hide your stats from a person filter. My games uses it.',
    player: 'required',
    response: { status: 200, description: 'Your setting.', schema: 'StatsPrivacy', example: { private: false } },
    errors: [BAD_PLAYER],
    examplePlayer: AGENT_A,
  },
  'PUT /api/me/stats-privacy': {
    operationId: 'setStatsPrivacy',
    tag: 'Account',
    summary: 'Hide or show your stats for a person filter.',
    player: 'required',
    body: { schema: 'StatsPrivacy', example: { private: true } },
    response: { status: 200, description: 'Your setting after the change.', schema: 'StatsPrivacy', example: { private: true } },
    errors: [BAD_PLAYER, { status: 400, when: 'The body is not { "private": true or false }.' }, TOO_BIG],
    examplePlayer: AGENT_A,
  },
  'GET /api/me/blocks': {
    operationId: 'myBlocks',
    tag: 'Safety',
    summary: 'The people that you blocked. The page uses it.',
    description: 'A block follows your GitHub account when you log in. The page hides the messages of a blocked person, and shows a generated name and picture in place of theirs.',
    player: 'required',
    response: { status: 200, description: 'Your blocks.', schema: 'Blocks', example: { blocked: [{ person: OTHER_PERSON, name: 'cleverHeron', at: T0 }] } },
    errors: [BAD_PLAYER],
    examplePlayer: AGENT_A,
  },
  'PUT /api/me/blocks/{person}': {
    operationId: 'block',
    tag: 'Safety',
    summary: 'Block a person.',
    player: 'required',
    body: { schema: 'BlockRequest', example: { name: 'cleverHeron' } },
    response: { status: 200, description: 'Your blocks with the new one.', schema: 'Blocks', example: { blocked: [{ person: OTHER_PERSON, name: 'cleverHeron', at: T0 }] } },
    errors: [
      BAD_PLAYER,
      { status: 400, when: 'The person id or the name is not valid, or the person is you.' },
      { status: 409, when: 'You blocked 500 people already.' },
      TOO_BIG,
    ],
    examplePlayer: AGENT_A,
  },
  'DELETE /api/me/blocks/{person}': {
    operationId: 'unblock',
    tag: 'Safety',
    summary: 'Unblock a person.',
    player: 'required',
    response: { status: 200, description: 'Your blocks without that person.', schema: 'Blocks', example: { blocked: [] } },
    errors: [BAD_PLAYER, { status: 400, when: 'The person id is not valid.' }],
    examplePlayer: AGENT_A,
  },
  'POST /api/reports': {
    operationId: 'report',
    tag: 'Safety',
    summary: 'Report a chat message or a person of an online game to the maintainers.',
    description: `The server keeps a copy of the message or the name. One address can send ${REPORTS_PER_10_MINUTES} reports per 10 minutes.`,
    player: 'required',
    body: { schema: 'ReportRequest', example: { code: EXAMPLE_CODE, message: 3, reason: 'abuse', note: 'Insults after the game.' } },
    response: { status: 201, description: 'Stored.', schema: 'ReportStored', example: { id: 1 } },
    errors: [
      BAD_PLAYER,
      BAD_BODY,
      NO_GAME,
      { status: 404, when: 'The message is not in the chat any more, or the person is not in the game now.' },
      TOO_BIG,
      { status: 429, when: `This address sent ${REPORTS_PER_10_MINUTES} reports in the last 10 minutes.` },
    ],
    examplePlayer: AGENT_B,
  },
  'GET /api/reports': {
    operationId: 'reports',
    tag: 'Safety',
    summary: 'The newest reports and moderation actions. Maintainers only.',
    description: 'Needs the X-Player header and the login cookie of a maintainer (the GitHub logins Yarden-zamir and TomCohenDev).',
    player: 'required',
    response: {
      status: 200,
      description: 'At most 200 of each, newest first.',
      schema: 'Reports',
      example: {
        reports: [
          { id: 1, code: EXAMPLE_CODE, message: 3, text: 'You are bad at this', person: OTHER_PERSON, name: 'cleverHeron', reason: 'abuse', note: null, reporter: EXAMPLE_PERSON, reporterLogin: null, at: T0 },
        ],
        actions: [{ login: 'Yarden-zamir', action: 'hide-message', code: EXAMPLE_CODE, message: 3, person: null, at: T0 }],
      },
    },
    errors: [BAD_PLAYER, MAINTAINER_401, MAINTAINER_403, NO_LOGIN],
    examplePlayer: AGENT_A,
  },
  'DELETE /api/sessions/{code}/chat/{message}': {
    operationId: 'hideMessage',
    tag: 'Safety',
    summary: 'Hide a chat message for everyone. Maintainers only.',
    description: 'The text of the message becomes "A moderator removed this message." The reports list keeps the action.',
    player: 'required',
    response: { status: 200, description: 'Hidden.', schema: 'Ok', example: { ok: true } },
    errors: [BAD_PLAYER, BAD_CODE, { status: 400, when: 'The message id is not a whole number from 1.' }, MAINTAINER_401, MAINTAINER_403, { status: 404, when: 'No game has this code, the message is not in its chat, or this server has no GitHub login.' }],
    examplePlayer: AGENT_A,
  },
  'DELETE /api/players/{person}/name': {
    operationId: 'clearPlayerName',
    tag: 'Safety',
    summary: 'Clear the custom name of a person. Maintainers only.',
    description: 'The person shows with the generated name again. The reports list keeps the action.',
    player: 'required',
    response: { status: 200, description: 'Cleared.', schema: 'Ok', example: { ok: true } },
    errors: [BAD_PLAYER, { status: 400, when: 'The person id is not valid.' }, MAINTAINER_401, MAINTAINER_403, { status: 404, when: 'The person has no custom name, or this server has no GitHub login.' }],
    examplePlayer: AGENT_A,
  },
  'DELETE /api/players/{person}': {
    operationId: 'deletePlayerData',
    tag: 'Safety',
    summary: 'Delete the data of a person, for an email request. Maintainers only.',
    description: 'Runs the same deletion as DELETE /api/me for the player, so an email request takes one call. A person id of a logged-in player deletes the whole account.',
    player: 'required',
    response: { status: 200, description: 'Deleted. The counts per table.', schema: 'DeletedData', example: Object.fromEntries(DATA_TABLES.map((table) => [table, { deleted: 0, anonymised: 0 }])) },
    errors: [BAD_PLAYER, { status: 400, when: 'The person id is not valid.' }, MAINTAINER_401, MAINTAINER_403, { status: 404, when: 'Nobody has that person id, or this server has no GitHub login.' }],
    examplePlayer: AGENT_A,
  },
  'DELETE /api/accounts/{login}': {
    operationId: 'deleteAccountData',
    tag: 'Safety',
    summary: 'Delete the data of a GitHub account on every device, for an email request. Maintainers only.',
    description: 'Runs the same deletion as DELETE /api/me for a logged-in player, so an email request takes one call.',
    player: 'required',
    response: { status: 200, description: 'Deleted. The counts per table.', schema: 'DeletedData', example: Object.fromEntries(DATA_TABLES.map((table) => [table, { deleted: 0, anonymised: 0 }])) },
    errors: [BAD_PLAYER, { status: 400, when: 'The login is not a GitHub login.' }, MAINTAINER_401, MAINTAINER_403, { status: 404, when: 'No account has that login, or this server has no GitHub login.' }],
    examplePlayer: AGENT_A,
  },
  'POST /api/nearby/hosts/{host}/answer': {
    operationId: 'answerNearbyHost',
    tag: 'Nearby',
    summary: 'Send your answer to the offer of a Nearby host. The page uses it.',
    description: 'The server passes the answer to the open request of the host. The host then connects to you directly over WebRTC. The game leaves the list until the host announces a fresh offer.',
    player: 'required',
    body: { schema: 'NearbyAnswer', example: { answer: EXAMPLE_ANSWER, offer: EXAMPLE_OFFER } },
    response: { status: 200, description: 'The answer is on its way to the host.', schema: 'Ok', example: { ok: true } },
    errors: [
      BAD_PLAYER,
      { status: 400, when: 'The host id is not 16 characters, the body is not valid JSON or misses a code, the answer is not a valid answer code, or the server cannot tell the network of your request.' },
      { status: 404, when: 'No host on your network has this id.' },
      { status: 409, when: 'Another device answered this offer first, or the host has a newer offer. Read the list again in a few seconds.' },
      TOO_BIG,
      { status: 429, when: `Your network sent ${NEARBY_CALLS_PER_10_MINUTES} Nearby calls in the last 10 minutes.` },
    ],
    examplePlayer: AGENT_B,
  },
} as const satisfies Record<RouteId, Route>;

export type RouteName = keyof typeof ROUTES;
export const ROUTE_NAMES = Object.keys(ROUTES) as RouteName[];

export function splitRoute(route: RouteName): { method: Method; path: string } {
  const space = route.indexOf(' ');
  return { method: route.slice(0, space) as Method, path: route.slice(space + 1) };
}

export type RouteMatch = { route: RouteName; params: Record<string, string> };

// Finds the route of a request. 'wrong-method' means that the path exists, but not for this method.
export function matchRoute(method: string, pathname: string): RouteMatch | 'wrong-method' | undefined {
  const parts = pathname.split('/').filter(Boolean);
  let pathExists = false;
  for (const route of ROUTE_NAMES) {
    const pattern = splitRoute(route).path.split('/').filter(Boolean);
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const same = pattern.every((segment, i) => {
      const part = parts[i];
      if (part === undefined) return false;
      if (!segment.startsWith('{')) return segment === part;
      params[segment.slice(1, -1)] = part;
      return true;
    });
    if (!same) continue;
    if (splitRoute(route).method === method) return { route, params };
    pathExists = true;
  }
  return pathExists ? 'wrong-method' : undefined;
}

// ---- The guide ----

// A block of guide text. In `p` and `list`, text in backticks is code. {origin} is the site address.
export type Block = { p: string } | { code: string } | { list: readonly string[] };
export type Section = { title: string; blocks: readonly Block[] };

export const GUIDE_INTRO =
  'tick3d is 3D tic-tac-toe on a 4x4x4 cube. Two players take turns, and X moves first. Four marks in a straight line win. The tick3d HTTP API lets you create a game, take a seat, move, chat and watch. Plain HTTP is enough: curl works. Scripts and AI agents can use it too.';

export const GUIDE: readonly Section[] = [
  {
    title: 'Quick start',
    blocks: [
      { p: 'Act only on the request of your user. Do not create games, join games or start other agents unless your user asks.' },
      { p: 'Create a game as X, give the link to your opponent, then wait and move until the game ends.' },
      {
        code: `# 1. Pick your player id once and keep it. It is your seat.
ME=agent-$(LC_ALL=C tr -dc a-z0-9 </dev/urandom | head -c 16)

# 2. Create a game. The answer has "code" and "version". You are X.
curl -s -X POST {origin}/api/sessions -H "X-Player: $ME" \\
  -H 'content-type: application/json' -d '{"name":"Agent match"}'

# 3. Give the link {origin}/?code=CODE to your opponent.
#    A user opens it in a browser. Another agent joins with:
#    curl -s -X POST {origin}/api/sessions/CODE/join -H "X-Player: $OTHER"

# 4. When "turn" is not "you", wait. VERSION is the "version" of your last answer.
#    The answer comes when the version is greater, or after about ${WAIT_MS / 1000} s with the same version.
curl -s "{origin}/api/sessions/CODE?wait=VERSION" -H "X-Player: $ME"

# 5. When "turn" equals "you", move. game = games.length - 1, moveCount = games[game].moves.length.
curl -s -X POST {origin}/api/sessions/CODE/moves -H "X-Player: $ME" \\
  -H 'content-type: application/json' -d '{"game":0,"moveCount":0,"cell":21}'

# 6. Repeat 4 and 5 until status.kind is not "playing". Then POST /api/sessions/CODE/games starts the next game. The seats swap: read "you" again.`,
      },
    ],
  },
  {
    title: 'Your player id: no account and no key',
    blocks: [
      { p: 'The API has no accounts and no keys. Make a random player id: 16 to 64 characters from `a-z`, `0-9` and `-`. For example, use `agent-` and 16 random characters. An id that starts with `account-` is refused.' },
      { p: 'Send it as the `X-Player` header on every call. Keep it for the whole session: the id holds your seat. With a new id, you are a new player, and you cannot move for your old seat.' },
      { p: 'Keep the id secret. Anybody with your id can move for your seat.' },
    ],
  },
  {
    title: 'Join a game from a link',
    blocks: [
      { p: 'A game link looks like `{origin}/?code=AB3K`. The `code` value is the session code. Codes have 4 characters and no `0`, `O`, `1` or `I`. Lower case also works.' },
      { p: 'Take a seat: `POST /api/sessions/AB3K/join` with your `X-Player` header. The answer shows your seat in `you`. When both seats are taken, you get 409, and you can only watch.' },
      { p: 'A link with `&watch=1` asks to watch. `GET /api/sessions/AB3K` reads the session and never takes a seat.' },
    ],
  },
  {
    title: 'Create a game',
    blocks: [
      { p: '`POST /api/sessions` with a body like `{"name":"Agent match"}`. You take seat X. The name has 1 to 40 characters. An optional `clock` sets a time limit; leave it out for no limit.' },
      { p: 'Share the link `{origin}/?code=<code>` with the code from the answer. Your opponent takes seat O.' },
    ],
  },
  {
    title: 'Read the state',
    blocks: [
      { p: 'Every call that changes a game returns the full session: `SessionView` in `components.schemas` of this document. `GET /api/sessions/<code>` reads it. The fields that you need most:' },
      {
        list: [
          '`you`: your seat, "X" or "O". null means that you only watch.',
          '`seats`: true for each seat that a player holds. Wait for `seats.O` before you expect an answer move.',
          '`turn`: the player to move in the live game, or null when it is over.',
          '`status`: `{"kind":"playing"}`, `{"kind":"won","winner":"X","line":[...]}`, `{"kind":"timeout","winner":"O"}` or `{"kind":"draw"}`.',
          '`games`: every game, oldest first. The last one is the live game. `moves` lists its cells in order: X played moves 0, 2, 4 and so on, O played moves 1, 3, 5.',
          '`version`: grows with every change.',
          '`chat`: the newest messages, oldest first.',
          '`players` and `names`: who plays each seat. `players` holds the GitHub account of a player who logged in on the page. A player without a GitHub login has a name in `names`: a name that the player chose (PUT /api/me/name), else a generated name such as "braveOtter". The same player id always gets the same generated name, so you also get one.',
          '`watchers`: the browsers that have the game open without a seat.',
          '`seatRequest`: a seat change that waits for an answer, or null.',
        ],
      },
    ],
  },
  {
    title: 'Board and cells',
    blocks: [
      { p: 'The cube has 4 layers of 4 rows of 4 columns: 64 cells. A cell index is `layer * 16 + row * 4 + column`. Each value is 0 to 3, and layer 0 is the bottom layer. The page counts from 1, so it calls layer 0 "layer 1".' },
      { p: 'A worked example: layer 1, row 1, column 1 gives `1 * 16 + 1 * 4 + 1 = 21`. Back from a cell: `layer = floor(cell / 16)`, `row = floor(cell / 4) % 4`, `column = cell % 4`. So cell 46 is layer 2, row 3, column 2.' },
      { p: 'A line is 4 cells in a straight line in any direction. There are 76 lines. Some examples:' },
      {
        list: [
          '`0, 1, 2, 3`: a row in the bottom layer.',
          '`0, 16, 32, 48`: straight up through the 4 layers.',
          '`0, 5, 10, 15`: a diagonal in the bottom layer.',
          '`0, 21, 42, 63`: a diagonal through the whole cube.',
        ],
      },
      { p: 'The 8 corners and the 8 center cells (21, 22, 25, 26, 37, 38, 41, 42) are each on 7 lines, so they are strong cells.' },
    ],
  },
  {
    title: 'Make a move',
    blocks: [
      { p: 'Move when `turn` equals `you` and `status.kind` is "playing". Send `POST /api/sessions/<code>/moves` with `{"game": G, "moveCount": N, "cell": C}`.' },
      {
        list: [
          '`game`: the index of the live game, `games.length - 1`.',
          '`moveCount`: the number of moves in the live game that you saw, `games[G].moves.length`. It guards against a stale move: when the board changed since you read it, you get 409. Read the session again and decide again.',
          '`cell`: an empty cell, 0 to 63.',
        ],
      },
      { p: 'A refused move returns an error with a message, for example 409 "That cell is taken.", 409 "It is not your turn." or 409 "The board changed." After a 409, read the session again before the next move.' },
    ],
  },
  {
    title: 'Wait for changes',
    blocks: [
      { p: `Add \`?wait=<version>\` to \`GET /api/sessions/<code>\`. The server holds the request until the version is greater than the version that you send, or until about ${WAIT_MS / 1000} s pass. Then it returns the session. When the version did not change, ask again.` },
      { p: 'Use this to wait for your opponent, for a join or for chat. Do not poll in a tight loop.' },
    ],
  },
  {
    title: 'Errors and reconnect',
    blocks: [
      {
        list: [
          'Send an `Idempotency-Key` header with each change: a new random key per request, and the same key on a retry.',
          'After a 5xx or a network error, retry. Wait 2 s first, and double the wait up to 30 s.',
          'Keep the same player id. It still holds your seat.',
          'After the server answers again, read the session and continue from the live game.',
          'A 409 with the code `already-played` means that your move counted.',
          'After a 429, wait the seconds in `Retry-After`.',
        ],
      },
    ],
  },
  {
    title: 'After a game, and chat',
    blocks: [
      { p: 'A finished game has its own read-only link: `{origin}/?game=<CODE>-<n>`, where n is the game number in the session, counted from 1 (`games.length` for the live game). It shows the final board and a replay. After a game, this is the best link to give your user. `GET /api/games/<CODE>-<n>` returns the same game as JSON.' },
      { p: 'A game ends when `status.kind` is "won", "timeout" or "draw". Either player starts the next game with `POST /api/sessions/<code>/games`. The new game is the last item of `games`. X moves first in every game, but the players swap X and O for each new game: the player who was O is now X. Read `you` again after each new game. To keep the seats, send `PATCH /api/sessions/<code>` with `{"fixedSeats":true}`. A session keeps every game.' },
      { p: `Chat with \`POST /api/sessions/<code>/chat\` and \`{"text":"Good luck!"}\`. A message has 1 to ${CHAT_MAX_LENGTH} characters. Only the two players can write. Watchers read along. The session keeps the newest ${CHAT_KEEP} messages.` },
    ],
  },
  {
    title: 'Watching',
    blocks: [
      { p: 'A person watches in a browser: open `{origin}/?code=<code>`. The page shows the board, the moves and the chat, live.' },
      { p: 'Important: a browser that opens the link while a seat is free takes that seat. To let your user watch and not play, give the link after both seats are taken.' },
      { p: 'The page shows a player as "away" when no browser of that player has the game open. A player that uses the API shows as away. The game goes on as usual.' },
      { p: 'A player can change the seats with `POST /api/sessions/<code>/seats`: swap X and O, leave the seat, give it to a watcher, seat a watcher in the empty seat, or move the other player out. `{"action":"undo"}` asks to take back your last move, before the other player moves. A change of the seat of the other player, and an undo, wait until that player accepts it with `POST /api/sessions/<code>/seats/answer`. When `seatRequest` names your seat as the other one, answer it, or it ends after a minute.' },
    ],
  },
  {
    title: 'Play your user',
    blocks: [
      { p: 'Create a game and give your user the link `{origin}/?code=<code>`. The user opens it and takes seat O. Or your user creates a game on the page (Online) and gives you the link: then you join and take seat O.' },
    ],
  },
  {
    title: 'Agent against agent',
    blocks: [
      { p: 'One agent creates a game and gives the code to the other agent. The other agent joins. When both seats are taken, give your user the link `{origin}/?code=<code>`, so they can watch the game live. After the game, give them the link of the finished game, `{origin}/?game=<CODE>-<n>`.' },
    ],
  },
  {
    title: 'Etiquette and limits',
    blocks: [
      {
        list: [
          `One address can create ${CREATES_PER_HOUR} sessions per hour. More gets 429. Play a session again with a new game instead of a new session.`,
          'Wait with `?wait=<version>`. Do not poll more than once per second.',
          'An error answer is JSON: `{"error":"<message>"}`. Read the message: it says what to do.',
          `A session with a move never expires. A player can come back later, and the game waits for the move. A session where no game has a move goes after ${EMPTY_SESSION_TTL_MS / 3_600_000} hours without a change. A long poll is not a change.`,
        ],
      },
    ],
  },
];
