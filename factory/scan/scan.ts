// Reads the tick3d repository and builds the factory model (model.ts): one machine per tracked file,
// a belt per import, a dock per API route, a silo per DuckDB table, a station per workflow job, and
// the Docker stages, the compose services and the npm packages. Nothing here is typed by hand, so the
// factory always matches the repository at the commit that is checked out.
//
// `npm run scan` writes public/factory.json. The dev server (vite.config.ts) also serves a fresh scan
// at /__factory, so the Rescan button picks up a change without a restart.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Edge, Entity, EntityKind, FactoryModel, ZoneId } from './model.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The first rule that matches a path picks its zone. The zones follow the architecture, not the
// folders: src/assetlinks.ts belongs with the Android app, src/platform.ts with the iOS app.
const ZONE_RULES: [ZoneId, RegExp][] = [
  ['ios', /^apple\/|^src\/platform(\.test)?\.ts$|^\.github\/workflows\/ios\.yml$/],
  ['android', /^android\/|^src\/assetlinks(\.test)?\.ts$|^\.github\/workflows\/(android|play-[a-z]+)\.yml$|^\.github\/actions\/play-api\//],
  ['studio', /^video\/|^\.github\/workflows\/video\.yml$/],
  ['qa', /^e2e\/|^\.github\/workflows\/e2e\.yml$|^\.(oxlintrc|stylelintrc|htmlvalidate)\.json$|^src\/markup\.test\.ts$/],
  ['ci', /^\.github\/|^\.kitshn\.yaml$|^kitshn\.md$/],
  ['packaging', /^(Dockerfile|\.dockerignore|compose(\.lan)?\.yml|Caddyfile\.j2|vite\.config\.ts)$|^container\//],
  ['api', /^server\//],
  ['ai', /^src\/(ai|ai-worker|move-search|tuning)(\.test)?\.ts$/],
  ['nearby', /^src\/nearby\//],
  ['acoustics', /^src\/(sound|sound-sets|song|wav|click-sound)(\.test)?\.ts$|^src\/(voice|sound-input|sound-training)\/|^sound-(input|training)\.html$/],
  ['foundry', /^src\/(game|protocol|clock|guards|epoch|records|release|deletions|names)(\.test)?\.ts$|^src\/(session|practice)\//],
  ['device', /^src\/(pwa|local|device-db|online|storage-keys|session-link|return-path)(\.test)?\.ts$|^public\//],
  ['storefront', /^[^/]+\.html$|^src\/pages(\.test)?\.ts$|^src\/(header|stats|privacy)\//],
  ['assembly', /^src\//],
  ['materials', /./],
];

const BINARY = /\.(png|jpe?g|webp|gif|ico|svg|woff2?|ttf|mp4|wav|mp3|pdf|zip)$/i;

function zoneOf(path: string): ZoneId {
  for (const [zone, rule] of ZONE_RULES) if (rule.test(path)) return zone;
  return 'materials';
}

function kindOf(path: string): EntityKind {
  const name = posix.basename(path);
  if (/\.test\.tsx?$/.test(name)) return 'test';
  if (/\.spec\.tsx?$/.test(name)) return 'spec';
  if (/^\.github\/workflows\/.+\.ya?ml$/.test(path)) return 'workflow';
  if (/\.(css)$/.test(name)) return 'style';
  if (/\.html$/.test(name)) return 'page';
  if (/\.(md|txt)$/.test(name) || name === 'LICENSE') return 'doc';
  if (/\.(sh|py|rb)$/.test(name)) return 'script';
  if (/\.(tsx?|mjs|js)$/.test(name)) return 'module';
  if (BINARY.test(name) || /\/fixtures\//.test(path)) return 'asset';
  return 'config';
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function squash(lines: string[]): string | undefined {
  const text = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0) return undefined;
  return text.length > 700 ? `${text.slice(0, 697)}…` : text;
}

// The first comment block of a file: what the file says about itself.
function summaryOf(path: string, text: string): string | undefined {
  const lines = text.split('\n').slice(0, 80);
  if (/\.(tsx?|js|mjs)$/.test(path)) {
    const start = lines.findIndex((line) => /^\s*\/\/(?!\/)/.test(line) || /^\s*\/\*/.test(line));
    if (start < 0) return undefined;
    const block: string[] = [];
    if (/^\s*\/\*/.test(lines[start] ?? '')) {
      for (const line of lines.slice(start)) {
        block.push(line.replace(/^\s*\/?\*+\/?/, '').replace(/\*\/\s*$/, ''));
        if (line.includes('*/')) break;
      }
    } else {
      for (const line of lines.slice(start)) {
        if (!/^\s*\/\//.test(line)) break;
        block.push(line.replace(/^\s*\/\/\s?/, ''));
      }
    }
    return squash(block);
  }
  if (path.endsWith('.css')) {
    const match = /\/\*([\s\S]*?)\*\//.exec(text);
    return match ? squash([match[1] ?? '']) : undefined;
  }
  if (path.endsWith('.html')) {
    const title = /<title>([^<]*)<\/title>/.exec(text)?.[1];
    const comment = /<!--([\s\S]*?)-->/.exec(text)?.[1];
    return squash([title ? `Page title: “${title.trim()}”.` : '', comment ?? '']);
  }
  if (path.endsWith('.md')) {
    const body = text
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .find((block) => block.length > 0 && !block.startsWith('#') && !block.startsWith('[!') && !block.startsWith('!['));
    return body ? squash([body.replace(/[`*]/g, '')]) : undefined;
  }
  if (path.endsWith('package.json')) {
    try {
      const pkg = JSON.parse(text) as { description?: string; name?: string };
      return squash([pkg.description ?? `The npm package “${pkg.name ?? path}”.`]);
    } catch {
      return undefined;
    }
  }
  // YAML, Dockerfile, Caddyfile, Gemfile, shell, Python, Ruby: the first block of # comments.
  const start = lines.findIndex((line) => /^\s*#(?!!)/.test(line));
  if (start < 0) return undefined;
  const block: string[] = [];
  for (const line of lines.slice(start)) {
    if (!/^\s*#/.test(line)) break;
    block.push(line.replace(/^\s*#\s?/, ''));
  }
  return squash(block);
}

interface RawImport {
  spec: string;
  typeOnly: boolean;
}

function importsOf(path: string, text: string): RawImport[] {
  const found: RawImport[] = [];
  if (/\.(tsx?|js|mjs)$/.test(path)) {
    for (const match of text.matchAll(/^\s*(import|export)\s([^;]*?)from\s*['"]([^'"]+)['"]/gm)) {
      const clause = match[2] ?? '';
      let typeOnly = /^\s*type\s/.test(clause);
      const braces = /^\s*\{([\s\S]*)\}\s*$/.exec(clause);
      if (!typeOnly && braces) {
        const names = (braces[1] ?? '').split(',').map((name) => name.trim()).filter(Boolean);
        typeOnly = names.length > 0 && names.every((name) => name.startsWith('type '));
      }
      found.push({ spec: match[3] ?? '', typeOnly });
    }
    for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) found.push({ spec: match[1] ?? '', typeOnly: false });
    for (const match of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push({ spec: match[1] ?? '', typeOnly: false });
    for (const match of text.matchAll(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g)) found.push({ spec: match[1] ?? '', typeOnly: false });
  } else if (path.endsWith('.html')) {
    for (const match of text.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) found.push({ spec: match[1] ?? '', typeOnly: false });
    for (const match of text.matchAll(/<link[^>]*\shref="([^"]+\.css)"/g)) found.push({ spec: match[1] ?? '', typeOnly: false });
  } else if (path.endsWith('.css')) {
    for (const match of text.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)) found.push({ spec: match[1] ?? '', typeOnly: false });
    for (const match of text.matchAll(/url\(\s*['"]?([^'")]+\.(?:woff2?|ttf|png|svg))['"]?\s*\)/g)) found.push({ spec: match[1] ?? '', typeOnly: false });
  }
  return found;
}

function resolveSpec(from: string, spec: string, files: Set<string>): string | undefined {
  const clean = spec.split('?')[0] ?? spec;
  const base = clean.startsWith('/') ? clean.slice(1) : posix.normalize(posix.join(posix.dirname(from), clean));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (files.has(candidate)) return candidate;
  return undefined;
}

function packageName(spec: string): string | undefined {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return undefined;
  if (spec.startsWith('virtual:pwa-register')) return 'vite-plugin-pwa';
  if (spec.startsWith('virtual:')) return undefined;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// The npm projects of the repository: the root, and the separate ones under video/, android/ and apple/.
const PACKAGE_DIRS: { dir: string; zone: ZoneId }[] = [
  { dir: 'video', zone: 'studio' },
  { dir: 'android', zone: 'android' },
  { dir: 'apple', zone: 'ios' },
  { dir: '', zone: 'materials' },
];

function ownerDir(path: string): string {
  return PACKAGE_DIRS.find(({ dir }) => dir === '' || path.startsWith(`${dir}/`))?.dir ?? '';
}

function depId(dir: string, name: string): string {
  return `dep:${dir === '' ? 'root' : dir}:${name}`;
}

// ROUTES in server/api-docs.ts: every route of the HTTP API, with its docs.
function scanRoutes(entities: Entity[]): void {
  const text = read('server/api-docs.ts');
  const start = text.indexOf('export const ROUTES = {');
  const end = text.indexOf('export type RouteName');
  if (start < 0 || end < 0) return;
  const block = text.slice(start, end);
  const lines = text.slice(0, start).split('\n').length;
  for (const match of block.matchAll(/^ {2}'(GET|POST|PUT|PATCH|DELETE) ([^']+)': \{([\s\S]*?)\n {2}\},?$/gm)) {
    const [, method = '', path = '', body = ''] = match;
    const field = (name: string): string | undefined => {
      const value = new RegExp(`\\n {4}${name}:\\s*(['\`])([\\s\\S]*?)\\1,`).exec(body);
      return value?.[2];
    };
    const line = lines + block.slice(0, match.index).split('\n').length - 1;
    const data: Record<string, string | number | boolean> = { method, path, line };
    const operationId = field('operationId');
    const tag = field('tag');
    const player = field('player');
    if (operationId) data.operationId = operationId;
    if (tag) data.tag = tag;
    if (player) data.player = player;
    data.idempotencyKey = /\n {4}idempotencyKey: true/.test(body);
    const status = /\n {4}response: \{\s*status: (\d+)/.exec(body)?.[1];
    if (status) data.status = Number(status);
    const summary = field('summary');
    const description = field('description');
    entities.push({
      id: `route:${method} ${path}`,
      kind: 'route',
      zone: 'api',
      label: `${method} ${path}`,
      file: 'server/api-docs.ts',
      ...(summary || description ? { summary: squash([summary ?? '', description ?? '']) ?? '' } : {}),
      data,
    });
  }
}

// The DuckDB tables in server/store.ts, with the comment above each one.
function scanTables(entities: Entity[], edges: Edge[]): void {
  const text = read('server/store.ts');
  const lines = text.split('\n');
  const tables = new Map<string, Entity>();
  for (const match of text.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\s*\)`/g)) {
    const [, name = '', body = ''] = match;
    const columns: string[] = [];
    for (const raw of body.split('\n')) {
      const line = raw.trim().replace(/,$/, '');
      const column = /^(\w+)\s+([A-Z][A-Z0-9_]*(?:\[\])?)(.*)$/.exec(line);
      if (!column || /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/.test(column[1] ?? '')) continue;
      const extra = (column[3] ?? '').replace(/\$\{[^}]+\}/g, '…').trim();
      columns.push(`${column[1]} ${column[2]}${extra ? ` ${extra}` : ''}`);
    }
    const at = text.slice(0, match.index).split('\n').length - 1;
    const comment: string[] = [];
    for (let index = at - 1; index >= 0 && /^\s*\/\//.test(lines[index] ?? ''); index -= 1) comment.unshift((lines[index] ?? '').replace(/^\s*\/\/\s?/, ''));
    const entity: Entity = {
      id: `table:${name}`,
      kind: 'table',
      zone: 'vault',
      label: name,
      file: 'server/store.ts',
      ...(comment.length ? { summary: squash(comment) ?? '' } : {}),
      data: { columns, line: at + 1 },
    };
    tables.set(name, entity);
    entities.push(entity);
    edges.push({ from: 'server/store.ts', to: entity.id, kind: 'stores' });
  }
  // Columns that came later: the table changes are append-only statements.
  for (const match of text.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+) ([A-Z][A-Z0-9_]*(?:\[\])?)/g)) {
    const table = tables.get(match[1] ?? '');
    const columns = table?.data?.columns;
    if (Array.isArray(columns)) columns.push(`${match[2]} ${match[3]} (added by ALTER TABLE)`);
  }
}

// A GitHub Actions workflow, read by indentation. It reads only what the factory shows: the
// triggers, the cron times, the jobs, their runners, `needs`, conditions and steps.
interface Job {
  id: string;
  comment: string[];
  runsOn?: string;
  needs: string[];
  condition?: string;
  uses?: string;
  steps: string[];
  matrix: string[];
}

function scanWorkflow(path: string, text: string, entity: Entity, entities: Entity[], edges: Edge[]): void {
  const lines = text.split('\n');
  const triggers: string[] = [];
  const crons: string[] = [];
  const paths: string[] = [];
  const jobs: Job[] = [];
  let section = '';
  let job: Job | undefined;
  let pending: string[] = [];
  let inSteps = false;
  let inMatrix = false;
  let readingIf = false;
  for (const line of lines) {
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (indent === 0) {
      section = /^(\w[\w-]*):/.exec(trimmed)?.[1] ?? '';
      if (section === 'name') entity.data = { ...entity.data, name: trimmed.replace(/^name:\s*/, '') };
      continue;
    }
    if (section === 'on') {
      if (indent === 2 && /^[\w-]+:/.test(trimmed)) triggers.push(trimmed.replace(/:.*$/, ''));
      const cron = /cron:\s*'([^']+)'/.exec(trimmed);
      if (cron?.[1]) crons.push(cron[1]);
      const filter = /^paths:\s*\[(.*)\]/.exec(trimmed);
      if (filter?.[1]) paths.push(...filter[1].split(',').map((item) => item.trim().replace(/^'|'$/g, '')));
      const branches = /^branches:\s*\[(.*)\]/.exec(trimmed);
      if (branches?.[1]) triggers[triggers.length - 1] += ` (${branches[1]})`;
      continue;
    }
    if (section !== 'jobs') continue;
    if (indent === 2 && trimmed.startsWith('#')) {
      pending.push(trimmed.replace(/^#\s?/, ''));
      continue;
    }
    if (indent === 2 && /^[\w-]+:$/.test(trimmed)) {
      job = { id: trimmed.slice(0, -1), comment: pending, needs: [], steps: [], matrix: [] };
      pending = [];
      jobs.push(job);
      inSteps = false;
      inMatrix = false;
      readingIf = false;
      continue;
    }
    if (!job) continue;
    if (indent === 4) {
      inSteps = trimmed === 'steps:';
      inMatrix = trimmed === 'strategy:';
      readingIf = false;
      const runsOn = /^runs-on:\s*(.+)$/.exec(trimmed);
      if (runsOn?.[1]) job.runsOn = runsOn[1];
      const uses = /^uses:\s*(.+)$/.exec(trimmed);
      if (uses?.[1]) job.uses = uses[1];
      const needs = /^needs:\s*(.+)$/.exec(trimmed);
      if (needs?.[1]) job.needs = needs[1].replace(/[[\]]/g, '').split(',').map((item) => item.trim()).filter(Boolean);
      const condition = /^if:\s*(.*)$/.exec(trimmed);
      if (condition) {
        const value = (condition[1] ?? '').trim();
        if (value === '>-' || value === '|' || value === '') readingIf = true;
        else job.condition = value;
      }
      continue;
    }
    if (readingIf && indent >= 6) {
      job.condition = `${job.condition ? `${job.condition} ` : ''}${trimmed}`;
      continue;
    }
    if (inMatrix && indent === 8 && /^[\w-]+:/.test(trimmed)) job.matrix.push(trimmed);
    if (inSteps && indent === 6 && trimmed.startsWith('- ')) {
      const step = trimmed.slice(2);
      const label = /^(name|uses|run):\s*(.+)$/.exec(step);
      job.steps.push(label ? (label[1] === 'run' ? `run: ${label[2]}` : (label[2] ?? step)) : step);
    } else if (inSteps && indent === 8 && /^name:\s*/.test(trimmed)) {
      // A step that starts with `- uses:` and names itself on the next line.
      const last = job.steps.length - 1;
      if (last >= 0) job.steps[last] = trimmed.replace(/^name:\s*/, '');
    }
  }
  entity.data = { ...entity.data, triggers, crons, paths, jobs: jobs.map((item) => item.id) };
  const workflow = posix.basename(path);
  for (const item of jobs) {
    const data: Record<string, string | string[] | number> = { workflow, steps: item.steps };
    if (item.runsOn) data.runsOn = item.runsOn;
    if (item.uses) data.uses = item.uses;
    if (item.condition) data.condition = item.condition.length > 400 ? `${item.condition.slice(0, 397)}…` : item.condition;
    if (item.needs.length) data.needs = item.needs;
    if (item.matrix.length) data.matrix = item.matrix;
    const id = `job:${workflow}#${item.id}`;
    entities.push({
      id,
      kind: 'job',
      zone: entity.zone,
      label: `${workflow.replace(/\.ya?ml$/, '')} · ${item.id}`,
      file: path,
      ...(item.comment.length ? { summary: squash(item.comment) ?? '' } : {}),
      data,
    });
    if (item.needs.length === 0) edges.push({ from: path, to: id, kind: 'needs' });
    for (const need of item.needs) edges.push({ from: `job:${workflow}#${need}`, to: id, kind: 'needs' });
  }
}

// The stages of the Dockerfile, and what each one copies from the repository and from other stages.
function scanDocker(entities: Entity[], edges: Edge[], files: Set<string>): void {
  const text = read('Dockerfile');
  const lines = text.split('\n');
  let stage: Entity | undefined;
  let comment: string[] = [];
  const stages: Entity[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      comment.push(trimmed.replace(/^#\s?/, ''));
      continue;
    }
    const from = /^FROM\s+(\S+)\s+AS\s+(\S+)/i.exec(trimmed);
    if (from) {
      stage = {
        id: `stage:${from[2]}`,
        kind: 'stage',
        zone: 'packaging',
        label: `stage ${from[2]}`,
        file: 'Dockerfile',
        ...(comment.length ? { summary: squash(comment) ?? '' } : {}),
        data: { image: from[1] ?? '', instructions: [] },
      };
      stages.push(stage);
      entities.push(stage);
      comment = [];
      continue;
    }
    if (trimmed === '') {
      comment = [];
      continue;
    }
    if (!stage) continue;
    const instructions = stage.data?.instructions;
    if (Array.isArray(instructions)) instructions.push(comment.length ? `${trimmed}   # ${squash(comment)}` : trimmed);
    comment = [];
    const copyFrom = /^COPY\s+--from=(\S+)/.exec(trimmed);
    if (copyFrom) {
      const edge: Edge = { from: `stage:${copyFrom[1]}`, to: stage.id, kind: 'stage' };
      if (!edges.some((item) => item.from === edge.from && item.to === edge.to)) edges.push(edge);
      continue;
    }
    const copy = /^COPY\s+(.+)\s+\S+$/.exec(trimmed);
    if (copy?.[1]) {
      for (const source of copy[1].split(/\s+/)) if (files.has(source)) edges.push({ from: source, to: stage.id, kind: 'stage' });
    }
  }
  if (stages[0]) edges.push({ from: 'Dockerfile', to: stages[0].id, kind: 'stage' });
}

// The services of the compose files: the production pair (site, api) and the LAN server.
function scanCompose(path: string, entities: Entity[], edges: Edge[], files: Set<string>): void {
  const text = read(path);
  const lines = text.split('\n');
  let section = '';
  let service: Entity | undefined;
  let key = '';
  let comment: string[] = [];
  const volumes = new Set<string>();
  for (const line of lines) {
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (indent === 0) {
      section = /^([\w-]+):/.exec(trimmed)?.[1] ?? '';
      continue;
    }
    if (section === 'volumes' && indent === 2) volumes.add(trimmed.replace(/:.*$/, ''));
    if (section !== 'services') continue;
    if (indent === 2 && trimmed.startsWith('#')) {
      comment.push(trimmed.replace(/^#\s?/, ''));
      continue;
    }
    if (indent === 2 && /^[\w-]+:$/.test(trimmed)) {
      const name = trimmed.slice(0, -1);
      service = {
        id: `service:${path}#${name}`,
        kind: 'service',
        zone: 'packaging',
        label: `${name} (${path})`,
        file: path,
        ...(comment.length ? { summary: squash(comment) ?? '' } : {}),
        data: { service: name, environment: [], volumes: [], dependsOn: [] },
      };
      comment = [];
      entities.push(service);
      edges.push({ from: path, to: service.id, kind: 'serves' });
      continue;
    }
    if (!service?.data) continue;
    if (indent === 4) key = trimmed.replace(/:.*$/, '');
    const data = service.data;
    const target = /^target:\s*(\S+)/.exec(trimmed);
    if (target?.[1]) {
      data.target = target[1];
      edges.push({ from: `stage:${target[1]}`, to: service.id, kind: 'serves' });
    }
    const health = /^test:\s*(.+)$/.exec(trimmed);
    if (health?.[1] && key === 'healthcheck') data.healthcheck = health[1];
    if (key === 'environment' && indent === 6 && !trimmed.startsWith('#')) (data.environment as string[]).push(trimmed.replace(/:.*$/, ''));
    if (key === 'volumes' && indent === 6 && trimmed.startsWith('- ')) (data.volumes as string[]).push(trimmed.slice(2));
    if (key === 'depends_on' && indent === 6 && /:$/.test(trimmed)) (data.dependsOn as string[]).push(trimmed.slice(0, -1));
    if (key === 'ports' && indent === 6 && trimmed.startsWith('- ')) data.ports = trimmed.slice(2);
    const dockerfileCaddy = /Caddyfile[\w.]*/.exec(trimmed);
    if (dockerfileCaddy && files.has(`container/${dockerfileCaddy[0]}`) && key === 'volumes') {
      edges.push({ from: `container/${dockerfileCaddy[0]}`, to: service.id, kind: 'serves' });
    }
  }
  for (const entity of entities) {
    if (entity.kind !== 'service' || entity.file !== path || !entity.data) continue;
    for (const dependency of entity.data.dependsOn as string[]) edges.push({ from: `service:${path}#${dependency}`, to: entity.id, kind: 'serves' });
    for (const volume of entity.data.volumes as string[]) {
      const name = volume.split(':')[0] ?? '';
      if (!volumes.has(name)) continue;
      const id = `volume:${name}`;
      if (!entities.some((item) => item.id === id)) {
        entities.push({ id, kind: 'volume', zone: 'vault', label: `volume ${name}`, file: path, summary: 'The named Docker volume that holds the DuckDB file /data/tick3d.duckdb. Each kitshn environment (prod, pr-<n>) has its own.', data: { mount: volume } });
      }
      edges.push({ from: entity.id, to: id, kind: 'serves' });
    }
  }
}

// Runtime channels: how a file talks beyond its imports. Each one becomes a fact on the file
// (data.channels), and where both ends are known, an edge: client code → the API route it calls,
// a page → the Web Worker it starts.
const CHANNELS: [string, RegExp][] = [
  ['fetch', /\bfetch\(/],
  ['event-stream', /new EventSource\(/],
  ['worker', /new Worker\(/],
  ['webrtc', /new RTCPeerConnection\(/],
  ['broadcast', /new BroadcastChannel\(/],
  ['indexeddb', /\bindexedDB\b/],
  ['service-worker', /navigator\.serviceWorker/],
];

/** A client path as written (`/me/blocks/${person}?x=1`) in the shape of a route path: `/me/blocks/X`. */
function clientPath(written: string): string {
  return (
    written
      .replace(/\/\$\{[^}]+\}/g, '/X')
      // A template part that does not start a segment adds a query or a suffix: drop it.
      .replace(/\$\{[^}]+\}/g, '')
      .split('?')[0] ?? ''
  );
}

function routePattern(path: string): RegExp {
  return new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+')}$`);
}

function scanChannels(texts: Map<string, string>, entities: Entity[], edges: Edge[], files: Set<string>): void {
  const routes = entities.filter((entity) => entity.kind === 'route');
  const findRoute = (method: string, path: string): Entity | undefined =>
    routes.find((route) => route.data?.method === method && routePattern(String(route.data.path)).test(path));
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  for (const [path, text] of texts) {
    const entity = byId.get(path);
    if (!entity || !/^src\/.*\.ts$/.test(path) || entity.kind === 'test') continue;
    const channels = CHANNELS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
    if (channels.length) entity.data = { ...entity.data, channels };

    // HTTP calls: a helper `call(method, path)` adds /api; a second helper may add a prefix too.
    const prefix = /call\(method, `([^`$]*)\$\{path\}`/.exec(text)?.[1];
    const calls: { method: string; path: string; via: string; stream?: boolean }[] = [];
    for (const match of text.matchAll(/\b(call|request)\('(GET|POST|PUT|PATCH|DELETE)', (?:'([^']*)'|`([^`]*)`)/g)) {
      const [, helper = '', method = '', plain, template] = match;
      const written = plain ?? template ?? '';
      const base = helper === 'request' ? (prefix ?? '') : '';
      calls.push({ method, path: `/api${base}${clientPath(written)}`, via: `${helper}('${method}', '${written}')` });
    }
    for (const match of text.matchAll(/fetch\((?:'([^']*)'|`([^`]*)`)/g)) {
      const written = match[1] ?? match[2] ?? '';
      if (written.startsWith('/api/')) calls.push({ method: 'GET', path: clientPath(written), via: `fetch('${written}')` });
    }
    for (const match of text.matchAll(/new EventSource\((?:'([^']*)'|`([^`]*)`)/g)) {
      const written = match[1] ?? match[2] ?? '';
      calls.push({ method: 'GET', path: clientPath(written), via: `new EventSource('${written}')`, stream: true });
    }
    const seen = new Set<string>();
    for (const call of calls) {
      const route = findRoute(call.method, call.path);
      if (!route || seen.has(route.id)) continue;
      seen.add(route.id);
      edges.push({ from: path, to: route.id, kind: 'calls', via: call.via, ...(call.stream ? { stream: true } : {}) });
    }

    // Web Workers: new Worker(new URL('./file.ts', import.meta.url)).
    for (const match of text.matchAll(/new Worker\(new URL\('([^']+)', import\.meta\.url\)/g)) {
      const target = posix.normalize(posix.join(posix.dirname(path), match[1] ?? ''));
      if (files.has(target)) edges.push({ from: path, to: target, kind: 'message', via: 'postMessage' });
    }
  }
}

export function scanRepo(): FactoryModel {
  // A tracked file that is deleted on disk (normal while editing) is left out, so the scan does not crash.
  const paths = git(['ls-files']).split('\n').filter((path) => path !== '' && existsSync(join(REPO_ROOT, path)));
  const files = new Set(paths);
  const entities: Entity[] = [];
  const edges: Edge[] = [];
  const texts = new Map<string, string>();
  let totalLines = 0;

  for (const path of paths) {
    const kind = kindOf(path);
    const entity: Entity = { id: path, kind, zone: zoneOf(path), label: posix.basename(path), file: path };
    if (BINARY.test(path)) {
      entity.data = { bytes: statSync(join(REPO_ROOT, path)).size };
    } else {
      const text = read(path);
      texts.set(path, text);
      entity.lines = lineCount(text);
      totalLines += entity.lines;
      const summary = summaryOf(path, text);
      if (summary) entity.summary = summary;
    }
    entities.push(entity);
  }

  // Imports: belts between machines, and packages from the supply dock.
  const deps = new Map<string, Entity>();
  for (const { dir, zone } of PACKAGE_DIRS) {
    const manifest = `${dir === '' ? '' : `${dir}/`}package.json`;
    if (!files.has(manifest)) continue;
    const pkg = JSON.parse(read(manifest)) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    for (const [group, list] of [['dependencies', pkg.dependencies], ['devDependencies', pkg.devDependencies]] as const) {
      for (const [name, version] of Object.entries(list ?? {})) {
        const entity: Entity = { id: depId(dir, name), kind: 'dep', zone, label: name, file: manifest, data: { version, group, project: dir === '' ? '(root)' : `${dir}/`, runtime: group === 'dependencies' } };
        deps.set(entity.id, entity);
        entities.push(entity);
      }
    }
  }
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  for (const [path, text] of texts) {
    const entity = byId.get(path);
    if (!entity) continue;
    const seen = new Set<string>();
    const packages = new Set<string>();
    for (const { spec, typeOnly } of importsOf(path, text)) {
      const target = resolveSpec(path, spec, files);
      if (target && target !== path) {
        if (seen.has(target)) continue;
        seen.add(target);
        edges.push({ from: target, to: path, kind: entity.kind === 'page' ? 'entry' : 'import', ...(typeOnly ? { typeOnly } : {}) });
        continue;
      }
      const name = packageName(spec);
      if (!name || packages.has(name)) continue;
      packages.add(name);
      const dep = deps.get(depId(ownerDir(path), name)) ?? deps.get(depId('', name));
      if (dep) edges.push({ from: dep.id, to: path, kind: 'package', ...(typeOnly ? { typeOnly } : {}) });
    }
    if (packages.size) entity.packages = [...packages].sort();
  }

  // Unit tests sit inside the machine they test.
  for (const entity of entities) {
    if (entity.kind !== 'test') continue;
    const subject = entity.id.replace(/\.test\.(tsx?)$/, '.$1');
    const target = byId.get(subject);
    if (!target) continue;
    entity.testOf = subject;
    entity.zone = target.zone;
    (target.tests ??= []).push(entity.id);
  }

  // The pages of the site (src/pages.ts): their addresses.
  const pagesText = texts.get('src/pages.ts') ?? '';
  for (const match of pagesText.matchAll(/(\w+): \{ file: '([^']+)', path: '([^']+)' \}/g)) {
    const page = byId.get(match[2] ?? '');
    if (page) page.data = { ...page.data, page: match[1] ?? '', address: match[3] ?? '' };
  }

  scanRoutes(entities);
  scanTables(entities, edges);
  for (const path of paths) {
    const entity = byId.get(path);
    if (entity?.kind === 'workflow') scanWorkflow(path, texts.get(path) ?? '', entity, entities, edges);
  }
  scanDocker(entities, edges, files);
  scanChannels(texts, entities, edges, files);
  for (const path of ['compose.yml', 'compose.lan.yml']) if (files.has(path)) scanCompose(path, entities, edges, files);

  // Edges must join two known entities.
  const known = new Set(entities.map((entity) => entity.id));
  const valid = edges.filter((edge) => known.has(edge.from) && known.has(edge.to));

  return {
    meta: {
      repo: posix.basename(REPO_ROOT),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      commit: git(['rev-parse', '--short', 'HEAD']),
      subject: git(['log', '-1', '--format=%s']),
      scannedAt: new Date().toISOString(),
      files: paths.length,
      lines: totalLines,
    },
    entities,
    edges: valid,
  };
}

/** The text of a tracked file, for the inspector's Source view. Untracked paths answer undefined. */
export function readTracked(path: string): string | undefined {
  const tracked = new Set(git(['ls-files']).split('\n'));
  if (!tracked.has(path) || BINARY.test(path)) return undefined;
  return read(path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const started = performance.now();
  const model = scanRepo();
  // Write and let Node exit by itself: process.exit() would cut a piped stdout at 64 KB.
  if (process.argv.includes('--stdout')) process.stdout.write(JSON.stringify(model));
  else writeModel(model, started);
}

function writeModel(model: FactoryModel, started: number): void {
  const out = join(dirname(fileURLToPath(import.meta.url)), '../public/factory.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(model));
  const count = (kind: string): number => model.entities.filter((entity) => entity.kind === kind).length;
  const imports = model.edges.filter((edge) => edge.kind === 'import').length;
  console.log(
    `factory: ${model.meta.files} files, ${model.meta.lines} lines, ${imports} import belts, ${count('route')} routes, ${count('table')} tables, ` +
      `${count('job')} jobs, ${count('stage')} stages, ${count('service')} services, ${count('dep')} packages ` +
      `(${Math.round(performance.now() - started)} ms) → public/factory.json`,
  );
}
