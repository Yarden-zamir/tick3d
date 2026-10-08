// Makes the served API docs from server/api-docs.ts: the OpenAPI 3.1 document, and a Swagger UI page for it.
// `origin` is the site address, for example https://tick3d.yarden-zamir.com. It goes into the examples.
import {
  type Block,
  GUIDE,
  GUIDE_INTRO,
  PATH_PARAMS,
  ROUTES,
  ROUTE_NAMES,
  type Route,
  type RouteName,
  SCHEMAS,
  ref,
  splitRoute,
} from './api-docs.ts';
import { IDEMPOTENCY_KEY_MAX_LENGTH, IDEMPOTENCY_TTL_MS } from './idempotency.ts';

const route = (name: RouteName): Route => ROUTES[name];
const pathParams = (path: string): string[] =>
  path
    .split('/')
    .filter((segment) => segment.startsWith('{'))
    .map((segment) => segment.slice(1, -1));

function paramOf(name: string) {
  const param = PATH_PARAMS[name];
  if (param === undefined) throw new Error(`no description for the path parameter {${name}}`);
  return param;
}

function examplePath(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment.startsWith('{') ? paramOf(segment.slice(1, -1)).example : segment))
    .join('/');
}

// A curl command that sends the example request of a route.
export function curlOf(name: RouteName, origin: string): string {
  const doc = route(name);
  const { method, path } = splitRoute(name);
  const query = Object.entries(doc.query ?? {})
    .map(([key, param]) => `${key}=${encodeURIComponent(param.example)}`)
    .join('&');
  const url = `${origin}${examplePath(path)}${query ? `?${query}` : ''}`;
  const parts = ['curl -s', ...(method === 'GET' ? [] : [`-X ${method}`]), query ? `"${url}"` : url];
  if (doc.examplePlayer !== undefined) parts.push(`-H 'X-Player: ${doc.examplePlayer}'`);
  if (doc.body !== undefined) parts.push(`-H 'content-type: application/json'`, `-d '${JSON.stringify(doc.body.example)}'`);
  return parts.join(' ');
}

// ---- OpenAPI ----

// The Idempotency-Key header (server/idempotency.ts), one entry that each route that accepts it refers to.
const IDEMPOTENCY_KEY = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description:
    `Optional. A new random key for each change, for example a UUID. Send the same key when you send the request again: the server sends the first answer again and changes nothing. The server keeps a key for ${IDEMPOTENCY_TTL_MS / 60_000} minutes, for your player id and this path.`,
  schema: { type: 'string', minLength: 1, maxLength: IDEMPOTENCY_KEY_MAX_LENGTH },
};

const RETRY_AFTER = { description: 'Whole seconds to wait before the next try.', schema: { type: 'integer', minimum: 1 } };

export function openApi(origin: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const name of ROUTE_NAMES) {
    const doc = route(name);
    const { method, path } = splitRoute(name);
    const parameters = [
      ...pathParams(path).map((param) => ({ name: param, in: 'path', required: true, ...paramOf(param) })),
      ...Object.entries(doc.query ?? {}).map(([key, param]) => ({ name: key, in: 'query', ...param })),
      ...(doc.player === 'none'
        ? []
        : [
            {
              name: 'X-Player',
              in: 'header',
              required: doc.player === 'required',
              description: 'Your player id: 16 to 64 characters from a-z, 0-9 and "-". It holds your seat. No account or key.',
              schema: { type: 'string', pattern: '^[a-z0-9-]{16,64}$' },
            },
          ]),
      ...(doc.idempotencyKey === true ? [{ $ref: '#/components/parameters/IdempotencyKey' }] : []),
    ];
    const { response } = doc;
    const success =
      'schema' in response
        ? { description: response.description, content: { 'application/json': { schema: ref(response.schema), example: response.example } } }
        : { description: response.description, ...(response.contentType === null ? {} : { content: { [response.contentType]: {} } }) };
    // OpenAPI has one entry per status, so the reasons for one status go together.
    const errors: Record<string, unknown> = {};
    for (const status of new Set(doc.errors.map((error) => error.status))) {
      const reasons = doc.errors.filter((error) => error.status === status).map((error) => error.when);
      errors[String(status)] = {
        description: reasons.join(' Or: '),
        ...(status === 429 ? { headers: { 'Retry-After': RETRY_AFTER } } : {}),
        content: { 'application/json': { schema: ref('Error') } },
      };
    }
    paths[path] ??= {};
    paths[path][method.toLowerCase()] = {
      operationId: doc.operationId,
      tags: [doc.tag],
      summary: doc.summary,
      // The curl example goes into the description, so a reader of the raw document sees a full call.
      description: [doc.description, `Example:\n\n\`\`\`sh\n${curlOf(name, origin)}\n\`\`\``].filter(Boolean).join('\n\n'),
      parameters,
      ...(doc.body === undefined
        ? {}
        : { requestBody: { required: true, content: { 'application/json': { schema: ref(doc.body.schema), example: doc.body.example } } } }),
      responses: { [String(response.status)]: success, ...errors },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'tick3d HTTP API',
      version: '1',
      description: guideMarkdown(origin),
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: origin }],
    tags: [
      { name: 'Play', description: 'Create, join, move, chat and wait.' },
      { name: 'Nearby', description: 'The list of open Nearby games on your network. The page uses it.' },
      { name: 'Docs', description: 'This document, its web page and the health check.' },
      { name: 'Account', description: 'Routes for the page: GitHub login, stats, offline results and the previews list.' },
      { name: 'Safety', description: 'Report and block people, and the moderation routes of the maintainers.' },
    ],
    paths,
    components: { schemas: SCHEMAS, parameters: { IdempotencyKey: IDEMPOTENCY_KEY } },
  };
}

// ---- The guide, as Markdown in info.description ----

const fill = (text: string, origin: string) => text.replaceAll('{origin}', origin);

function blockMarkdown(block: Block, origin: string): string {
  if ('code' in block) return `\`\`\`sh\n${fill(block.code, origin)}\n\`\`\``;
  if ('list' in block) return block.list.map((item) => `- ${fill(item, origin)}`).join('\n');
  return fill(block.p, origin);
}

function guideMarkdown(origin: string): string {
  const sections = GUIDE.map((section) => [`## ${section.title}`, ...section.blocks.map((block) => blockMarkdown(block, origin))].join('\n\n'));
  return [GUIDE_INTRO, `A web page of this document: ${origin}/api/docs.`, ...sections].join('\n\n');
}

// ---- Swagger UI ----

// Swagger UI from jsDelivr, pinned to one version with Subresource Integrity, so a changed file
// on the CDN does not load. To update: change the version, and compute each hash again with
// `curl -sL <url> | openssl dgst -sha384 -binary | base64`.
const SWAGGER_UI = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.1';
const SWAGGER_CSS_SRI = 'sha384-Ov4/wv3j2bmct8cDc5X4ngJZohVPzEmc6uDPH8WeljUxO5vtoykvMEfbu9Vh6RaW';
const SWAGGER_JS_SRI = 'sha384-ZPehFMQommnnuaZ4rpxgkgTT2DKFVp4hZC/7pLit+9Lek9T1YGSo23eHFbvNkXkw';

// The page reads /api/openapi.json from the same origin, so "Try it out" calls this server.
export function swaggerHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tick3d HTTP API</title>
<link rel="stylesheet" href="${SWAGGER_UI}/swagger-ui.css" integrity="${SWAGGER_CSS_SRI}" crossorigin="anonymous">
</head>
<body>
<div id="swagger-ui"></div>
<script src="${SWAGGER_UI}/swagger-ui-bundle.js" integrity="${SWAGGER_JS_SRI}" crossorigin="anonymous"></script>
<script>
SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#swagger-ui', deepLinking: true });
</script>
</body>
</html>
`;
}
