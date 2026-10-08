import { Validator } from '@seriousme/openapi-schema-validator';
import { toEpochMs as ms } from '../src/epoch.ts';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parseAnnounce, parseAnnounced, parseAnswerRequest, parseLobbyHosts } from '../src/nearby/lobby.ts';
import { parseMe, parseMyGames } from '../src/online.ts';
import {
  ALL_STATS,
  type PlayerToken,
  parseGameId,
  normalizeChat,
  parseClientEvent,
  parseHistoryPage,
  parseMetrics,
  parseMoveRequest,
  parsePublicGame,
  parseNewSession,
  parsePreviews,
  parseResultUpload,
  parseSessionUpdate,
  parseSessionView,
  parseCustomName,
  parseSeatAction,
  parseSeatAnswer,
  parseBlockRequest,
  parseStatsPrivacy,
  parseBlocks,
  parseReportRequest,
} from '../src/protocol.ts';
import { parsePlayoffRequest } from '../src/practice/playoff.ts';
import { parsePracticeBoard, parsePracticeRun } from '../src/practice/practice.ts';
import { PATH_PARAMS, ROUTES, ROUTE_NAMES, type Route, SCHEMAS, type SchemaName, matchRoute, splitRoute } from './api-docs.ts';
import { curlOf, openApi, swaggerHtml } from './api-docs-render.ts';
import { openStore } from './store.ts';
import { isRecord } from '../src/guards.ts';

const ORIGIN = 'https://tick3d.example.com';
const fail = (id: string): never => {
  throw new Error(`not a game id: ${id}`);
};

// The real parsers of the page and the server, by shape. A parser returns undefined or throws on a bad value.
// Shapes without a parser (Health, ResultsResponse, Records, Stats, ...) are read inline by their only caller,
// so the JSON Schema check below is their only check.
const PARSERS: Partial<Record<SchemaName, (value: unknown) => unknown>> = {
  SessionView: parseSessionView,
  NewSession: parseNewSession,
  SessionUpdate: parseSessionUpdate,
  MoveRequest: parseMoveRequest,
  // server/main.ts reads `text` and the session rules check it with normalizeChat.
  ChatRequest: (value) => (isRecord(value) ? normalizeChat(value.text) : undefined),
  // server/main.ts checks the list, and the store checks each result with parseResultUpload.
  ResultsRequest: (value) =>
    isRecord(value) && Array.isArray(value.results) && value.results.every((result) => parseResultUpload(result, ms(Date.now())) !== undefined)
      ? value
      : undefined,
  Me: parseMe,
  MyGames: parseMyGames,
  PublicGame: parsePublicGame,
  HistoryPage: parseHistoryPage,
  Metrics: parseMetrics,
  ClientEvent: parseClientEvent,
  NearbyAnnounce: parseAnnounce,
  NearbyAnnounced: parseAnnounced,
  NearbyHosts: parseLobbyHosts,
  NearbyAnswer: parseAnswerRequest,
  Previews: parsePreviews,
  PlayoffRequest: parsePlayoffRequest,
  PracticeRun: parsePracticeRun,
  PracticeBoard: parsePracticeBoard,
  SeatAction: parseSeatAction,
  SeatAnswer: parseSeatAnswer,
  // server/main.ts reads `name` and checks it with parseCustomName.
  NameRequest: (value) => (isRecord(value) ? parseCustomName(value.name) : undefined),
  BlockRequest: parseBlockRequest,
  StatsPrivacy: parseStatsPrivacy,
  Blocks: parseBlocks,
  ReportRequest: parseReportRequest,
};

function parses(name: SchemaName, value: unknown): boolean {
  const parse = PARSERS[name];
  if (parse === undefined) throw new Error(`no parser for ${name}`);
  try {
    return parse(value) !== undefined;
  } catch {
    return false;
  }
}

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
ajv.addKeyword('components');
ajv.addSchema({ components: { schemas: SCHEMAS } }, 'api');

function schemaErrors(name: SchemaName, value: unknown): string {
  const validate = ajv.getSchema(`api#/components/schemas/${name}`);
  if (validate === undefined) throw new Error(`no schema ${name}`);
  return validate(value) ? '' : ajv.errorsText(validate.errors);
}

const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

describe('the documented examples', () => {
  const bodies = ROUTE_NAMES.flatMap((name) => {
    const route: Route = ROUTES[name];
    const body = route.body;
    return body === undefined ? [] : [[name, body] as const];
  });
  const answers = ROUTE_NAMES.flatMap((name) => {
    const response = ROUTES[name].response;
    return 'schema' in response ? [[name, response] as const] : [];
  });

  it.each(bodies)('%s: the example body matches its schema and passes the real parser', (_, body) => {
    expect(schemaErrors(body.schema, body.example)).toBe('');
    expect(parses(body.schema, body.example)).toBe(true);
  });

  it.each(answers)('%s: the example answer matches its schema and passes the real parser', (_, response) => {
    expect(schemaErrors(response.schema, response.example)).toBe('');
    const parsed = PARSERS[response.schema] === undefined || parses(response.schema, response.example);
    expect(parsed).toBe(true);
  });

  it.each(bodies)('%s: the parser refuses the body without each required field', (_, body) => {
    const example = body.example;
    if (!isRecord(example)) throw new Error('a body example is an object');
    for (const key of SCHEMAS[body.schema].required ?? []) expect(parses(body.schema, without(example, key)), key).toBe(false);
  });
});

describe('the SessionView schema', () => {
  const example = ROUTES['GET /api/sessions/{code}'].response.example;

  it('lists the same fields that parseSessionView returns', () => {
    expect(Object.keys(parseSessionView(example)).sort()).toEqual(Object.keys(SCHEMAS.SessionView.properties ?? {}).sort());
  });

  it('marks a field required when parseSessionView needs it', () => {
    // An older server, a Nearby host or a cached view sends no turn, status, names, watchers, seat
    // request and seat rotation, so the parser fills them in.
    const filled = ['turn', 'status', 'names', 'people', 'watchers', 'youWatcher', 'seatRequest', 'fixedSeats', 'flipped'];
    for (const key of SCHEMAS.SessionView.required ?? []) {
      expect(parses('SessionView', without(example, key)), key).toBe(filled.includes(key));
    }
  });

  it('matches what the store sends, so a new field needs docs', async () => {
    const store = await openStore(':memory:');
    try {
      const alice = 'agent-aaaaaaaaaaaaaaaa' as PlayerToken;
      const bob = 'agent-bbbbbbbbbbbbbbbb' as PlayerToken;
      const { code } = await store.create(alice, 'Agent match');
      await store.join(code, bob);
      for (const [moveCount, cell] of [0, 1, 16, 2, 32, 3, 48].entries()) {
        await store.move(code, moveCount % 2 === 0 ? alice : bob, { game: 0, moveCount, cell });
      }
      const won = await store.chat(code, bob, 'Good game!');
      expect(schemaErrors('SessionView', won)).toBe('');
      expect(won.status).toEqual({ kind: 'won', winner: 'X', line: [0, 16, 32, 48] });
      expect(won.turn).toBeNull();
      const next = await store.newGame(code, alice);
      expect(schemaErrors('SessionView', next)).toBe('');
      expect(next.turn).toBe('X');
      expect(schemaErrors('MyGames', await store.myGames(alice))).toBe('');
      const id = `${code}-1`;
      expect(schemaErrors('PublicGame', await store.game(parseGameId(id) ?? fail(id)))).toBe('');
      expect(schemaErrors('HistoryPage', await store.history(alice, 0))).toBe('');
      expect(schemaErrors('Records', { records: await store.records(alice) })).toBe('');
      expect(schemaErrors('Stats', await store.stats())).toBe('');
    } finally {
      store.close();
    }
    // DuckDB writes for each move. A busy CI machine needs more than the default 5 s.
  }, 20_000);
  it('matches the Mine stats, which add your own results', async () => {
    const store = await openStore(':memory:');
    try {
      const mine = await store.stats({ ...ALL_STATS, scope: 'mine' }, 'agent-aaaaaaaaaaaaaaaa' as PlayerToken);
      expect(mine.personal).not.toBeNull();
      expect(schemaErrors('Stats', mine)).toBe('');
    } finally {
      store.close();
    }
  }, 20_000);
});

describe('matchRoute', () => {
  it.each(ROUTE_NAMES)('finds %s', (name) => {
    const { method, path } = splitRoute(name);
    const values = { code: 'ab3k', id: 'ab3k-2', host: 'q8Zr2Lx0Vb7Nc4Mw', person: '3f9a0c27d84be615', message: '3' };
    const used = Object.entries(values).filter(([key]) => path.includes(`{${key}}`));
    const concrete = used.reduce((result, [key, value]) => result.replaceAll(`{${key}}`, value), path);
    const params = Object.fromEntries(used);
    expect(matchRoute(method, concrete)).toEqual({ route: name, params });
  });

  it('says when a path exists with another method', () => {
    expect(matchRoute('DELETE', '/api/sessions/AB3K')).toBe('wrong-method');
    expect(matchRoute('GET', '/api/sessions')).toBe('wrong-method');
  });

  it.each(['/api', '/api/nothing', '/api/sessions/AB3K/join/more', '/sessions/AB3K', '/api/auth/github'])('finds no route for %s', (path) => {
    expect(matchRoute('GET', path)).toBeUndefined();
    expect(matchRoute('POST', path)).toBeUndefined();
  });

  it('has a description for every path parameter', () => {
    const params = ROUTE_NAMES.flatMap((name) => splitRoute(name).path.split('/').filter((part) => part.startsWith('{')));
    expect(params.filter((param) => PATH_PARAMS[param.slice(1, -1)] === undefined)).toEqual([]);
  });
});


describe('the served docs', () => {
  const doc = openApi(ORIGIN);

  // The validator checks the document against the official OpenAPI 3.1 JSON Schema (spec.openapis.org).
  // The component schemas get their own check against JSON Schema 2020-12.
  it('are a valid OpenAPI 3.1 document', async () => {
    const result = await new Validator().validate(doc);
    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
    // The validator refuses a broken document, so the check above means something.
    const broken = { ...doc, paths: { '/api/x': { get: { responses: { 200: { content: {} } } } } } };
    expect((await new Validator().validate(broken)).valid).toBe(false);
    const components = doc.components as { schemas: Record<string, unknown> };
    for (const [name, schema] of Object.entries(components.schemas)) {
      expect(ajv.validateSchema({ ...(schema as object), $defs: {} }), name).toBe(true);
    }
  });

  it('describe every route once, with the site as the server', () => {
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    const operations = Object.entries(paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`));
    expect(operations.sort()).toEqual([...ROUTE_NAMES].sort());
    const ids = ROUTE_NAMES.map((name) => ROUTES[name].operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(doc.servers).toEqual([{ url: ORIGIN }]);
  });

  it('hold the guide in info.description, with the site address', () => {
    const { description } = doc.info as { description: string };
    expect(description).not.toContain('{origin}');
    expect(description).toContain(`${ORIGIN}/?code=`);
    expect(description).toContain(`${ORIGIN}/?game=`);
  });

  it('give each operation a curl example', () => {
    const paths = doc.paths as Record<string, Record<string, { description: string }>>;
    expect(paths['/api/sessions/{code}/moves']?.post?.description).toContain(curlOf('POST /api/sessions/{code}/moves', ORIGIN));
  });

  it('load Swagger UI with integrity hashes and read the document from the same origin', () => {
    const page = swaggerHtml();
    expect(page.match(/integrity="sha384-/g)).toHaveLength(2);
    expect(page).toContain("url: '/api/openapi.json'");
  });

  it('send the example body and header in curl', () => {
    const curl = curlOf('POST /api/sessions/{code}/moves', ORIGIN);
    expect(curl).toContain(`-X POST ${ORIGIN}/api/sessions/AB3K/moves`);
    expect(curl).toContain(`-d '${JSON.stringify(ROUTES['POST /api/sessions/{code}/moves'].body.example)}'`);
    expect(curl).toContain("-H 'X-Player: agent-");
    expect(curlOf('GET /api/sessions/{code}', ORIGIN)).toContain(`"${ORIGIN}/api/sessions/AB3K?wait=6"`);
  });
});
