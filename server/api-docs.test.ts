import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parseMe, parseMyGames } from '../src/online.ts';
import {
  type PlayerToken,
  parseGameId,
  normalizeChat,
  parseClientEvent,
  parseHistoryPage,
  parseMetrics,
  parseMoveRequest,
  parsePublicGame,
  parseNewSession,
  parseResultUpload,
  parseSessionUpdate,
  parseSessionView,
} from '../src/protocol.ts';
import { PATH_PARAMS, ROUTES, ROUTE_NAMES, type Route, SCHEMAS, type SchemaName, matchRoute, splitRoute } from './api-docs.ts';
import { curlOf, html, markdown, openApi } from './api-docs-render.ts';
import { openStore } from './store.ts';

const ORIGIN = 'https://tick3d.example.com';
const fail = (id: string): never => {
  throw new Error(`not a game id: ${id}`);
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

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
    isRecord(value) && Array.isArray(value.results) && value.results.every((result) => parseResultUpload(result, Date.now()) !== undefined)
      ? value
      : undefined,
  Me: parseMe,
  MyGames: parseMyGames,
  PublicGame: parsePublicGame,
  HistoryPage: parseHistoryPage,
  Metrics: parseMetrics,
  ClientEvent: parseClientEvent,
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

  it('has a real parser for every request body', () => {
    expect(bodies.filter(([, body]) => PARSERS[body.schema] === undefined)).toEqual([]);
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
    // An older server, a Nearby host or a cached view sends no turn and status, so the parser fills them in.
    const filled = ['turn', 'status'];
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
  });
});

describe('matchRoute', () => {
  it.each(ROUTE_NAMES)('finds %s', (name) => {
    const { method, path } = splitRoute(name);
    const concrete = path.replaceAll('{code}', 'ab3k').replaceAll('{id}', 'ab3k-2');
    const params = { ...(path.includes('{code}') ? { code: 'ab3k' } : {}), ...(path.includes('{id}') ? { id: 'ab3k-2' } : {}) };
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
  it('describe every route in OpenAPI, with valid component schemas', () => {
    const doc = openApi(ORIGIN);
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    const operations = Object.entries(paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`));
    expect(operations.sort()).toEqual([...ROUTE_NAMES].sort());
    expect(ajv.validateSchema({ components: doc.components })).toBe(true);
    const ids = ROUTE_NAMES.map((name) => ROUTES[name].operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('give every route in the Markdown and the web page, with the site address', () => {
    const md = markdown(ORIGIN);
    const page = html(ORIGIN);
    for (const name of ROUTE_NAMES) {
      expect(md).toContain(`### ${name}`);
      expect(page).toContain(`id="${ROUTES[name].operationId}"`);
    }
    expect(md).not.toContain('{origin}');
    expect(md).toContain(`${ORIGIN}/?code=`);
    expect(page).not.toContain('<script');
  });

  it('escape the host in the web page', () => {
    expect(html('https://"><script>x</script>')).not.toContain('<script>x');
  });

  it('send the example body and header in curl', () => {
    const curl = curlOf('POST /api/sessions/{code}/moves', ORIGIN);
    expect(curl).toContain(`-X POST ${ORIGIN}/api/sessions/AB3K/moves`);
    expect(curl).toContain(`-d '${JSON.stringify(ROUTES['POST /api/sessions/{code}/moves'].body.example)}'`);
    expect(curl).toContain("-H 'X-Player: agent-");
    expect(curlOf('GET /api/sessions/{code}', ORIGIN)).toContain(`"${ORIGIN}/api/sessions/AB3K?wait=6"`);
  });
});
