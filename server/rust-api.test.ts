// The Rust server (rust/server, #265) serves the same routes and docs as this server, on the same tables. Until it
// replaces this server, it reads them from rust/server/from-node.json, which this test writes. After a change of the
// routes, the docs or the schema, write it again:
// UPDATE_RUST_API=1 npx vitest run server/rust-api.test.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROUTES, ROUTE_NAMES } from './api-docs.ts';
import { openApi, swaggerHtml } from './api-docs-render.ts';
import { GAME_COLUMN_LIST, METRIC_COLUMN_LIST, METRIC_VALUES, gameValues, metricValues } from './fields.ts';
import { SCHEMA } from './store.ts';
import { LAYOUTS, REFUSALS, THEMES, VIEWS } from '../src/protocol.ts';
import { TUNING_FIELDS } from '../src/tuning.ts';

const FILE = new URL('../rust/server/from-node.json', import.meta.url);

// `openapi` keeps the text {origin} in place of the site address: the Rust server fills it in for each request.
function fromNode() {
  return {
    routes: ROUTE_NAMES.map((name) => ({ name, idempotencyKey: (ROUTES[name] as { idempotencyKey?: true }).idempotencyKey === true })),
    openapi: JSON.stringify(openApi('{origin}'), null, 2),
    docsHtml: swaggerHtml(),
    schema: SCHEMA,
    // The SQL of the copied columns of a result (server/fields.ts), for the batch tables and for bound $metrics.
    fields: {
      gameColumns: GAME_COLUMN_LIST,
      metricColumns: METRIC_COLUMN_LIST,
      gameValuesOfDoc: gameValues('doc'),
      metricValuesOfMetrics: metricValues('metrics'),
      metricValuesOfParameter: METRIC_VALUES,
    },
    // The lists and ranges that parseMetrics checks (src/protocol.ts, src/tuning.ts).
    metrics: {
      views: VIEWS,
      layouts: LAYOUTS,
      themes: THEMES,
      refusals: REFUSALS,
      tuningFields: TUNING_FIELDS.map(({ path, min, max, step }) => ({ path, min, max, step })),
    },
  };
}

describe('rust/server/from-node.json', () => {
  it('holds the routes, the docs and the schema of this server now', () => {
    const current = fromNode();
    if (process.env.UPDATE_RUST_API === '1') writeFileSync(FILE, `${JSON.stringify(current, null, 2)}\n`);
    expect(existsSync(FILE), 'from-node.json is missing: write it with UPDATE_RUST_API=1').toBe(true);
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(current);
  });
});
