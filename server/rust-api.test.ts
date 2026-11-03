// The Rust server (rust/server, #265) serves the same routes and docs as this server, on the same tables. Until it
// replaces this server, it reads them from rust/server/from-node.json, which this test writes. After a change of the
// routes, the docs or the schema, write it again:
// UPDATE_RUST_API=1 npx vitest run server/rust-api.test.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROUTES, ROUTE_NAMES } from './api-docs.ts';
import { openApi, swaggerHtml } from './api-docs-render.ts';
import { SCHEMA } from './store.ts';

const FILE = new URL('../rust/server/from-node.json', import.meta.url);

// `openapi` keeps the text {origin} in place of the site address: the Rust server fills it in for each request.
function fromNode() {
  return {
    routes: ROUTE_NAMES.map((name) => ({ name, idempotencyKey: (ROUTES[name] as { idempotencyKey?: true }).idempotencyKey === true })),
    openapi: JSON.stringify(openApi('{origin}'), null, 2),
    docsHtml: swaggerHtml(),
    schema: SCHEMA,
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
