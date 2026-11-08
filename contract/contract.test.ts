// The Rust server (rust/server) reads its routes, its docs, its schema and the metric lists from
// rust/server/contract.json, which this test writes from contract/ and src/. After a change of the routes, the docs,
// the schema or one of those lists, write it again:
// UPDATE_RUST_API=1 npx vitest run contract/contract.test.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROUTES, ROUTE_NAMES } from './api-docs.ts';
import { openApi, swaggerHtml } from './api-docs-render.ts';
import { GAME_COLUMN_LIST, METRIC_COLUMN_LIST, METRIC_VALUES, gameValues, metricValues, metricsStruct } from './fields.ts';
import { SCHEMA } from './schema.ts';
import { achievementCases } from './achievement-cases.ts';
import { LAYOUTS, REFUSALS, THEMES, VIEWS } from '../src/protocol.ts';
import { TUNING_FIELDS } from '../src/tuning.ts';

const FILE = new URL('../rust/server/contract.json', import.meta.url);

// `openapi` keeps the text {origin} in place of the site address: the Rust server fills it in for each request.
function contract() {
  return {
    routes: ROUTE_NAMES.map((name) => ({ name, idempotencyKey: (ROUTES[name] as { idempotencyKey?: true }).idempotencyKey === true })),
    openapi: JSON.stringify(openApi('{origin}'), null, 2),
    docsHtml: swaggerHtml(),
    schema: SCHEMA,
    // The SQL of the copied columns of a result (contract/fields.ts), for the batch tables and for bound $metrics.
    fields: {
      gameColumns: GAME_COLUMN_LIST,
      metricColumns: METRIC_COLUMN_LIST,
      gameValuesOfDoc: gameValues('doc'),
      metricValuesOfMetrics: metricValues('metrics'),
      metricValuesOfParameter: METRIC_VALUES,
      // The metrics of a row as a struct, for the stats: of `results`, and of `seat_metrics sm`.
      metricsOfResults: metricsStruct('results'),
      metricsOfSeatMetrics: metricsStruct('sm'),
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

const CASES_FILE = new URL('../rust/server/achievement-cases.json', import.meta.url);

describe('rust/server/achievement-cases.json', () => {
  it('holds the progress that the achievement rules give now', () => {
    const current = achievementCases();
    if (process.env.UPDATE_RUST_API === '1') writeFileSync(CASES_FILE, `${JSON.stringify(current)}\n`);
    expect(existsSync(CASES_FILE), 'achievement-cases.json is missing: write it with UPDATE_RUST_API=1').toBe(true);
    expect(JSON.parse(readFileSync(CASES_FILE, 'utf8'))).toEqual(current);
  });
});

describe('rust/server/contract.json', () => {
  it('holds the routes, the docs and the schema of contract/ now', () => {
    const current = contract();
    if (process.env.UPDATE_RUST_API === '1') writeFileSync(FILE, `${JSON.stringify(current, null, 2)}\n`);
    expect(existsSync(FILE), 'contract.json is missing: write it with UPDATE_RUST_API=1').toBe(true);
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(current);
  });
});
