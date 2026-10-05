// Makes the served API docs from server/api-docs.ts: OpenAPI 3.1, Markdown for AI agents, and a web page.
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
  type Schema,
  type SchemaName,
  ref,
  splitRoute,
} from './api-docs.ts';

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
      errors[String(status)] = { description: reasons.join(' Or: '), content: { 'application/json': { schema: ref('Error') } } };
    }
    paths[path] ??= {};
    paths[path][method.toLowerCase()] = {
      operationId: doc.operationId,
      tags: [doc.tag],
      summary: doc.summary,
      ...(doc.description === undefined ? {} : { description: doc.description }),
      parameters,
      ...(doc.body === undefined
        ? {}
        : { requestBody: { required: true, content: { 'application/json': { schema: ref(doc.body.schema), example: doc.body.example } } } }),
      responses: { [String(response.status)]: success, ...errors },
      'x-curl': curlOf(name, origin),
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'tick3d API',
      version: '1',
      description: `${GUIDE_INTRO} No account and no key: send a random player id as the X-Player header. The guide for AI agents is at ${origin}/api/docs.md.`,
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: origin }],
    tags: [
      { name: 'Play', description: 'Create, join, move, chat and wait.' },
      { name: 'Docs', description: 'These docs and the health check.' },
      { name: 'Account', description: 'Routes for the page: GitHub login, stats and offline results.' },
    ],
    paths,
    components: { schemas: SCHEMAS },
  };
}

// ---- Markdown ----

// One line per top-level field, so a long session stays short and readable.
function jsonText(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return JSON.stringify(value);
  const lines = Object.entries(value).map(([key, field]) => `  ${JSON.stringify(key)}: ${JSON.stringify(field)}`);
  return `{\n${lines.join(',\n')}\n}`;
}

const fill = (text: string, origin: string) => text.replaceAll('{origin}', origin);

function refName(schema: Schema): SchemaName | undefined {
  return schema.$ref?.split('/').at(-1) as SchemaName | undefined;
}

// A short type text, for example `"X" | "O" | null` or `GameRecord[]`.
function typeText(schema: Schema): string {
  const name = refName(schema);
  if (name !== undefined) return name;
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum !== undefined) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (schema.oneOf !== undefined) return schema.oneOf.map(typeText).join(' | ');
  if (schema.type === 'array' && schema.items !== undefined) return `${typeText(schema.items)}[]`;
  if (schema.type === 'object' && schema.properties !== undefined) {
    return `{ ${Object.entries(schema.properties).map(([key, value]) => `${key}: ${typeText(value)}`).join(', ')} }`;
  }
  return Array.isArray(schema.type) ? schema.type.join(' | ') : String(schema.type ?? 'any');
}

function rangeText(schema: Schema): string {
  const parts: string[] = [];
  if (schema.minimum !== undefined && schema.maximum !== undefined) parts.push(`${schema.minimum} to ${schema.maximum}`);
  else if (schema.minimum !== undefined) parts.push(`at least ${schema.minimum}`);
  if (schema.minLength !== undefined && schema.maxLength !== undefined) parts.push(`${schema.minLength} to ${schema.maxLength} characters`);
  return parts.join(', ');
}

// One line per field of an object shape.
function fieldLines(name: SchemaName): string[] {
  const schema = SCHEMAS[name];
  if (schema.properties === undefined) return [];
  return Object.entries(schema.properties).map(([key, field]) => {
    const required = schema.required?.includes(key) === true ? '' : ', optional';
    const shape = refName(field);
    const description = field.description ?? (shape === undefined ? undefined : SCHEMAS[shape].description);
    const notes = [rangeText(field), description].filter(Boolean).join('. ');
    return `- \`${key}\` (${typeText(field)}${required})${notes ? `: ${notes}` : ''}`;
  });
}

function blockMarkdown(block: Block, origin: string): string {
  if ('code' in block) return `\`\`\`sh\n${fill(block.code, origin)}\n\`\`\``;
  if ('list' in block) return block.list.map((item) => `- ${fill(item, origin)}`).join('\n');
  return fill(block.p, origin);
}

function routeMarkdown(name: RouteName, origin: string): string {
  const doc = route(name);
  const lines = [`### ${name}`, '', doc.summary];
  if (doc.description !== undefined) lines.push('', doc.description);
  lines.push('');
  if (doc.player !== 'none') lines.push(`- Header \`X-Player\`: ${doc.player}.`);
  for (const [key, param] of Object.entries(doc.query ?? {})) {
    lines.push(`- Query \`${key}\`${param.required ? '' : ' (optional)'}: ${param.description}`);
  }
  if (doc.body !== undefined) {
    lines.push(`- Body (\`${doc.body.schema}\`): ${SCHEMAS[doc.body.schema].description ?? ''}`);
    lines.push(...fieldLines(doc.body.schema).map((line) => `  ${line}`));
  }
  const { response } = doc;
  lines.push(`- Answer ${response.status}: ${response.description}${'schema' in response ? ` Shape: \`${response.schema}\`.` : ''}`);
  for (const error of doc.errors) lines.push(`- Error ${error.status}: ${error.when}`);
  lines.push('', '```sh', curlOf(name, origin), '```');
  if ('schema' in response) lines.push('', 'Answer:', '', '```json', jsonText(response.example), '```');
  return lines.join('\n');
}

const TAG_TITLES: Record<Route['tag'], string> = {
  Play: 'Routes: play',
  Docs: 'Routes: docs',
  Account: 'Routes for the page (an agent does not need these)',
};

export function markdown(origin: string): string {
  const sections = GUIDE.map((section) => [`## ${section.title}`, ...section.blocks.map((block) => blockMarkdown(block, origin))].join('\n\n'));
  const routes = (Object.keys(TAG_TITLES) as Route['tag'][]).map((tag) =>
    [`## ${TAG_TITLES[tag]}`, ...ROUTE_NAMES.filter((name) => route(name).tag === tag).map((name) => routeMarkdown(name, origin))].join('\n\n'),
  );
  const shapes = (Object.keys(SCHEMAS) as SchemaName[]).map((name) => {
    const schema = SCHEMAS[name];
    const body = schema.properties === undefined ? [`Type: \`${typeText(schema)}\`.`] : fieldLines(name);
    return [`### ${name}`, '', schema.description ?? '', '', ...body].join('\n');
  });
  return [
    '# tick3d API for AI agents',
    '',
    GUIDE_INTRO,
    '',
    `The same docs as a web page: ${origin}/api/docs. OpenAPI 3.1: ${origin}/api/openapi.json.`,
    '',
    sections.join('\n\n'),
    '',
    routes.join('\n\n'),
    '',
    '## Shapes',
    '',
    shapes.join('\n\n'),
    '',
  ].join('\n');
}

// ---- Web page ----

const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Text in backticks becomes <code>.
function inlineHtml(text: string): string {
  return text
    .split('`')
    .map((part, i) => (i % 2 === 1 ? `<code>${escapeHtml(part)}</code>` : escapeHtml(part)))
    .join('');
}

function blockHtml(block: Block, origin: string): string {
  if ('code' in block) return `<pre><code>${escapeHtml(fill(block.code, origin))}</code></pre>`;
  if ('list' in block) return `<ul>${block.list.map((item) => `<li>${inlineHtml(fill(item, origin))}</li>`).join('')}</ul>`;
  return `<p>${inlineHtml(fill(block.p, origin))}</p>`;
}

function routeHtml(name: RouteName, origin: string): string {
  const doc = route(name);
  const { method, path } = splitRoute(name);
  const { response } = doc;
  const items = [
    ...(doc.player === 'none' ? [] : [`Header <code>X-Player</code>: ${doc.player}.`]),
    ...Object.entries(doc.query ?? {}).map(([key, param]) => `Query <code>${key}</code>${param.required ? '' : ' (optional)'}: ${escapeHtml(param.description)}`),
    ...(doc.body === undefined ? [] : [`Body: <code>${doc.body.schema}</code>. ${escapeHtml(SCHEMAS[doc.body.schema].description ?? '')}`]),
    `Answer ${response.status}: ${escapeHtml(response.description)}${'schema' in response ? ` Shape: <code>${response.schema}</code>.` : ''}`,
    ...doc.errors.map((error) => `Error ${error.status}: ${escapeHtml(error.when)}`),
  ];
  return `<article class="route" id="${doc.operationId}">
<h3><span class="method ${method.toLowerCase()}">${method}</span> <code>${escapeHtml(path)}</code></h3>
<p>${escapeHtml(doc.summary)}${doc.description === undefined ? '' : ` ${escapeHtml(doc.description)}`}</p>
<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>
<pre><code>${escapeHtml(curlOf(name, origin))}</code></pre>
${'schema' in response ? `<details><summary>Example answer</summary><pre><code>${escapeHtml(jsonText(response.example))}</code></pre></details>` : ''}
</article>`;
}

const STYLE = `
:root { --page: #e4e7ff; --surface: #fff; --ink: #000; --muted: #3d3d5c; --primary: #ffe14d; --x: #ff5277; --o: #00b3ff; --win: #7cff8a; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 16px/1.5 ui-rounded, system-ui, sans-serif; }
main { max-width: 52rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
h1 { font-size: 2.2rem; margin: 0 0 0.5rem; }
h2 { margin: 2.5rem 0 0.8rem; padding: 0.3rem 0.7rem; display: inline-block; background: var(--primary); border: 3px solid var(--ink); box-shadow: 4px 4px 0 var(--ink); border-radius: 10px; }
section, .route { background: var(--surface); border: 3px solid var(--ink); border-radius: 12px; box-shadow: 5px 5px 0 var(--ink); padding: 0.4rem 1.1rem 0.9rem; margin: 1rem 0; }
h3 { margin: 0.8rem 0 0.4rem; font-size: 1.1rem; }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: #f1f2ff; padding: 0.05em 0.3em; border-radius: 4px; }
pre { background: #15122b; color: #f3f0ff; padding: 0.8rem 1rem; border: 3px solid var(--ink); border-radius: 10px; overflow-x: auto; }
pre code { background: none; padding: 0; color: inherit; }
.method { display: inline-block; min-width: 4.2rem; text-align: center; padding: 0.1rem 0.4rem; border: 2px solid var(--ink); border-radius: 6px; font: 800 0.85rem ui-monospace, monospace; }
.get { background: var(--o); } .post { background: var(--win); } .patch { background: var(--x); }
nav a, a { color: var(--ink); font-weight: 700; }
nav { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; }
summary { cursor: pointer; font-weight: 700; }
`;

export function html(origin: string): string {
  const guide = GUIDE.map((section) => `<section><h3>${escapeHtml(section.title)}</h3>${section.blocks.map((block) => blockHtml(block, origin)).join('\n')}</section>`);
  const routes = (Object.keys(TAG_TITLES) as Route['tag'][]).map(
    (tag) => `<h2>${escapeHtml(TAG_TITLES[tag])}</h2>\n${ROUTE_NAMES.filter((name) => route(name).tag === tag).map((name) => routeHtml(name, origin)).join('\n')}`,
  );
  const shapes = (Object.keys(SCHEMAS) as SchemaName[]).map(
    (name) => `<section id="shape-${name}"><h3>${name}</h3><p>${escapeHtml(SCHEMAS[name].description ?? '')}</p>${
      SCHEMAS[name].properties === undefined
        ? `<p>Type: <code>${escapeHtml(typeText(SCHEMAS[name]))}</code></p>`
        : `<ul>${fieldLines(name).map((line) => `<li>${inlineHtml(line.slice(2))}</li>`).join('')}</ul>`
    }</section>`,
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tick3d API</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>tick3d API</h1>
<p>${escapeHtml(GUIDE_INTRO)}</p>
<nav><a href="${escapeHtml(origin)}/api/docs.md">Markdown for AI agents</a><a href="${escapeHtml(origin)}/api/openapi.json">OpenAPI 3.1</a><a href="${escapeHtml(origin)}/">Play tick3d</a></nav>
<h2>Guide</h2>
${guide.join('\n')}
${routes.join('\n')}
<h2>Shapes</h2>
${shapes.join('\n')}
</main>
</body>
</html>
`;
}
