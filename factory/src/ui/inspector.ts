// The Inspector: Unity-style components for the selected machine or zone. Every value comes from the
// scan; the text under "What it does" is the file's own first comment, or the comment above a table,
// job, stage or service.

import type { Edge, Entity, ZoneId } from '../../scan/model.ts';
import type { Place } from '../layout.ts';
import { CHANNELS, EDGES, KINDS, ZONES } from '../lore.ts';
import { KIND_ICONS, type ModelIndex, type Selection, el, formatBytes, formatNumber } from '../model.ts';
import { METHOD_COLORS } from '../world/machines.ts';
import { FLUIDS, fluidOf } from '../world/pipes.ts';
import { SOURCES, type Source } from '../world/power.ts';
import { STYLES } from '../world/styles.ts';

type Child = Node | string | null | undefined | false;

const closedByDefault = new Set(['Source', 'Transform']);
const openState = new Map<string, boolean>();

function component(title: string, icon: string, body: Child[], count?: string | number): HTMLElement {
  const open = openState.get(title) ?? !closedByDefault.has(title);
  const root = el('section', { className: `comp ${open ? '' : 'closed'}` });
  const head = el(
    'div',
    { className: 'comp-head' },
    el('span', { className: 'fold', text: open ? '▼' : '▶' }),
    el('span', { className: 'cico', text: icon }),
    el('span', { text: title }),
    count !== undefined ? el('span', { className: 'count', text: String(count) }) : null,
  );
  head.addEventListener('click', () => {
    const next = root.classList.toggle('closed');
    openState.set(title, !next);
    (head.firstChild as HTMLElement).textContent = next ? '▶' : '▼';
    root.dispatchEvent(new CustomEvent('toggle-comp', { bubbles: true, detail: { title, open: !next } }));
  });
  root.append(head, el('div', { className: 'comp-body' }, ...body));
  return root;
}

function prop(name: string, value: Child | Child[]): HTMLElement {
  const values = Array.isArray(value) ? value : [value];
  return el('div', { className: 'prop' }, el('span', { text: name, title: name }), el('span', { className: 'val' }, ...values));
}

function cronText(cron: string): string {
  const [minute = '*', hour = '*', , , weekday = '*'] = cron.split(' ');
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')} UTC`;
  return weekday === '*' ? `every day at ${time}` : `every ${days[Number(weekday)] ?? weekday} at ${time}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A light tint: comments, strings and keywords. Enough to read code in the Inspector.
function tint(line: string, path: string): string {
  const html = escapeHtml(line);
  const hash = /\.(ya?ml|sh|py|rb|j2)$|Dockerfile|Caddyfile|Gemfile|\.gitignore|\.dockerignore/.test(path);
  const comment = hash ? /(^|\s)(#.*)$/ : /(^|[^:])(\/\/.*)$/;
  const match = comment.exec(html);
  let code = match ? html.slice(0, match.index + (match[1]?.length ?? 0)) : html;
  const rest = match ? `<span class="c">${match[2]}</span>` : '';
  code = code.replace(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`)/g, '<span class="s">$1</span>');
  code = code.replace(/\b(import|export|from|const|let|function|return|if|else|for|of|in|async|await|type|interface|new|class|switch|case|default|throw|try|catch|while|true|false|null|undefined|CREATE|TABLE|NOT|NULL|PRIMARY|KEY|DEFAULT|FROM|AS|COPY|RUN|ENV|CMD|USER|WORKDIR|ARG)\b(?![^<]*>)/g, '<span class="k">$1</span>');
  return code + rest;
}

async function loadSource(path: string, line: number | undefined, target: HTMLElement): Promise<void> {
  target.replaceChildren(el('div', { className: 'dim', text: 'Loading…' }));
  try {
    const response = await fetch(`/__source?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error(response.status === 404 ? 'Not a text file that git tracks.' : `HTTP ${response.status}`);
    const text = await response.text();
    const pre = el('pre', { className: 'src' });
    pre.innerHTML = text
      .split('\n')
      .map((source, index) => `<span class="l${line !== undefined && index + 1 >= line && index + 1 < line + 12 ? ' hl' : ''}">${tint(source, path) || ' '}</span>`)
      .join('');
    target.replaceChildren(pre);
    if (line !== undefined) {
      const row = pre.children[Math.max(0, line - 3)] as HTMLElement | undefined;
      if (row) pre.scrollTop = row.offsetTop - pre.offsetTop;
    }
  } catch (error) {
    target.replaceChildren(el('div', { className: 'dim', text: `Source unavailable: ${error instanceof Error ? error.message : String(error)} (the source view needs the dev server: npm run dev).` }));
  }
}

export interface Inspector {
  show(selection: Selection): void;
}

export function createInspector(
  container: HTMLElement,
  getIndex: () => ModelIndex,
  places: () => Map<string, Place>,
  onSelect: (selection: Selection) => void,
  power: () => Map<ZoneId, { source: Source; detail: string }[]>,
): Inspector {
  const link = (id: string, text?: string): HTMLElement => {
    const entity = getIndex().byId.get(id);
    const anchor = el('a', { className: 'link', text: text ?? entity?.label ?? id, title: id });
    anchor.addEventListener('click', () => onSelect({ type: 'entity', id }));
    return anchor;
  };
  const zoneLink = (zone: ZoneId): HTMLElement => {
    const anchor = el('a', { className: 'link', text: `${ZONES[zone].icon} ${ZONES[zone].title}` });
    anchor.addEventListener('click', () => onSelect({ type: 'zone', zone }));
    return anchor;
  };

  function travelsBy(edge: Edge): string {
    const index = getIndex();
    if (edge.kind === 'message') return 'cable car';
    const fluid = fluidOf(edge, (id) => index.byId.get(id)?.kind);
    return fluid ? FLUIDS[fluid].name.toLowerCase() : 'belt';
  }

  function edgeList(edges: Edge[], side: 'from' | 'to'): HTMLElement {
    const index = getIndex();
    const list = el('div', { className: 'links' });
    const sorted = [...edges].sort((a, b) => a.kind.localeCompare(b.kind) || a[side].localeCompare(b[side]));
    for (const edge of sorted) {
      const other = index.byId.get(edge[side]);
      if (!other) continue;
      list.append(
        el(
          'div',
          { className: 'ln' },
          el('span', { className: 'swatch', style: { background: ZONES[other.zone].color } }),
          link(other.id, other.kind === 'route' || other.kind === 'job' || other.kind === 'dep' || other.kind === 'table' || other.kind === 'service' || other.kind === 'stage' ? other.label : other.id),
          el('span', { className: 'badge', style: { color: EDGES[edge.kind].color }, text: EDGES[edge.kind].name, title: edge.via ?? '' }),
          el('span', { className: 'badge dim', text: travelsBy(edge) }),
          edge.typeOnly ? el('span', { className: 'badge', text: 'type', title: 'A type-only import: no runtime code travels' }) : null,
        ),
      );
    }
    return list;
  }

  function header(icon: string, name: string, color: string, tag: string, layer: string): HTMLElement {
    return el(
      'div',
      { className: 'insp-head' },
      el('div', { className: 'insp-icon', style: { color, borderColor: color } }, icon),
      el('div', { className: 'insp-title' }, el('input', { type: 'checkbox', checked: true, disabled: true, title: 'Active' }), el('span', { className: 'name', text: name, title: name }), el('span', { className: 'dim', text: 'Static' })),
      el('div', { className: 'insp-tags' }, el('span', {}, 'Tag ', el('b', { text: tag })), el('span', {}, 'Layer ', el('b', { text: layer }))),
    );
  }

  function kindComponent(entity: Entity): HTMLElement | null {
    const data = entity.data ?? {};
    const list = (values: unknown): string[] => (Array.isArray(values) ? values.map(String) : []);
    switch (entity.kind) {
      case 'route': {
        const method = String(data.method ?? '');
        return component('API Route', '🚪', [
          prop('Method', el('b', { style: { color: METHOD_COLORS[method] ?? '#fff' }, text: method })),
          prop('Path', el('code', { className: 'mono', text: String(data.path ?? '') })),
          prop('Operation id', String(data.operationId ?? '–')),
          prop('Tag', String(data.tag ?? '–')),
          prop('X-Player', String(data.player ?? 'none')),
          prop('Idempotency-Key', data.idempotencyKey === true ? 'accepted' : 'no'),
          prop('Defined in', link('server/api-docs.ts', `server/api-docs.ts:${String(data.line ?? '')}`)),
          prop('Handled in', link('server/main.ts', 'server/main.ts (switch in route())')),
        ]);
      }
      case 'table':
        return component('DuckDB Table', '🛢', [
          prop('Name', el('code', { className: 'mono', text: entity.label })),
          prop('Defined in', link('server/store.ts', `server/store.ts:${String(data.line ?? '')}`)),
          el('div', { className: 'prop' }, el('span', { text: `Columns (${list(data.columns).length})` }), el('ul', { className: 'steps mono' }, ...list(data.columns).map((column) => el('li', { text: column })))),
        ]);
      case 'workflow':
        return component('Workflow', '🚦', [
          prop('Name', String(data.name ?? entity.label)),
          prop('Triggers', list(data.triggers).map((trigger) => el('span', { className: 'badge', text: trigger }))),
          list(data.crons).length ? prop('Schedule', list(data.crons).map((cron) => el('div', {}, el('code', { className: 'mono', text: cron }), ` — ${cronText(cron)}`))) : null,
          list(data.paths).length ? prop('Paths', list(data.paths).join(', ')) : null,
          prop('Jobs', list(data.jobs).map((job) => el('div', {}, link(`job:${entity.label}#${job}`, job)))),
        ]);
      case 'job':
        return component('Workflow Job', '🔨', [
          prop('Workflow', link(entity.file ?? '', String(data.workflow ?? ''))),
          data.runsOn ? prop('Runs on', String(data.runsOn)) : null,
          data.uses ? prop('Uses', el('code', { className: 'mono', text: String(data.uses) })) : null,
          list(data.needs).length ? prop('Needs', list(data.needs).map((need) => el('div', {}, link(`job:${String(data.workflow)}#${need}`, need)))) : null,
          data.condition ? prop('If', el('code', { className: 'mono', text: String(data.condition) })) : null,
          list(data.matrix).length ? prop('Matrix', list(data.matrix).join(' · ')) : null,
          list(data.steps).length ? el('div', { className: 'prop' }, el('span', { text: `Steps (${list(data.steps).length})` }), el('ol', { className: 'steps' }, ...list(data.steps).map((step) => el('li', { text: step })))) : null,
        ]);
      case 'stage':
        return component('Docker Stage', '🐳', [
          prop('Image', el('code', { className: 'mono', text: String(data.image ?? '') })),
          prop('Defined in', link('Dockerfile')),
          el('div', { className: 'prop' }, el('span', { text: 'Instructions' }), el('ol', { className: 'steps mono' }, ...list(data.instructions).map((line) => el('li', { text: line })))),
        ]);
      case 'service':
        return component('Compose Service', '🏗', [
          prop('Service', String(data.service ?? '')),
          prop('Compose file', link(entity.file ?? '')),
          data.target ? prop('Image stage', link(`stage:${String(data.target)}`, String(data.target))) : null,
          data.healthcheck ? prop('Healthcheck', el('code', { className: 'mono', text: String(data.healthcheck) })) : null,
          list(data.dependsOn).length ? prop('Depends on', list(data.dependsOn).join(', ')) : null,
          list(data.volumes).length ? prop('Volumes', list(data.volumes).map((volume) => el('div', { className: 'mono', text: volume }))) : null,
          data.ports ? prop('Ports', String(data.ports)) : prop('Ports', 'none (kitshn socket ingress)'),
          list(data.environment).length ? prop('Environment', list(data.environment).join(', ')) : null,
        ]);
      case 'volume':
        return component('Docker Volume', '💾', [prop('Mount', el('code', { className: 'mono', text: String(data.mount ?? '') })), prop('Declared in', link(entity.file ?? ''))]);
      case 'dep': {
        const users = (getIndex().outputs.get(entity.id) ?? []).length;
        return component('npm Package', '📦', [
          prop('Name', el('code', { className: 'mono', text: entity.label })),
          prop('Version', String(data.version ?? '')),
          prop('Group', String(data.group ?? '')),
          prop('Project', String(data.project ?? '')),
          prop('Declared in', link(entity.file ?? '')),
          prop('Imported by', `${users} file${users === 1 ? '' : 's'}`),
        ]);
      }
      default: {
        const tests = entity.tests ?? [];
        return component('Repository File', '📄', [
          prop('Path', el('code', { className: 'mono', text: entity.id })),
          entity.lines !== undefined ? prop('Lines', formatNumber(entity.lines)) : null,
          typeof data.bytes === 'number' ? prop('Size', formatBytes(data.bytes)) : null,
          prop('Kind', `${KINDS[entity.kind].name} → ${KINDS[entity.kind].machine}`),
          data.address ? prop('Address', el('code', { className: 'mono', text: String(data.address) })) : null,
          entity.testOf ? prop('Tests', link(entity.testOf)) : null,
          tests.length ? prop('Tested by', tests.map((test) => el('div', {}, link(test)))) : null,
        ]);
      }
    }
  }

  function showEntity(entity: Entity): void {
    const index = getIndex();
    const zone = ZONES[entity.zone];
    const place = places().get(entity.id);
    const parts: Child[] = [header(KIND_ICONS[entity.kind], entity.kind === 'route' || entity.kind === 'job' ? entity.label : entity.id, zone.color, zone.title, KINDS[entity.kind].name)];
    if (place) {
      parts.push(
        component('Transform', '⬚', [
          el('div', { className: 'prop' }, el('span', { text: 'Position' }), el('div', { className: 'vec mono' }, el('span', {}, el('b', { text: 'X' }), place.x.toFixed(1)), el('span', {}, el('b', { text: 'Y' }), '0'), el('span', {}, el('b', { text: 'Z' }), place.z.toFixed(1)))),
          el('div', { className: 'prop' }, el('span', { text: 'Scale' }), el('div', { className: 'vec mono' }, el('span', {}, el('b', { text: 'X' }), (place.r * 2).toFixed(1)), el('span', {}, el('b', { text: 'Y' }), place.h.toFixed(2)), el('span', {}, el('b', { text: 'Z' }), (place.r * 2).toFixed(1)))),
          el('p', { className: 'text dim', text: entity.lines !== undefined ? 'Height follows the line count.' : 'Height follows the size of the thing it stands for.' }),
        ]),
      );
    }
    parts.push(kindComponent(entity));
    parts.push(
      component('What it does', '📝', [
        entity.summary ? el('p', { className: 'text', text: entity.summary }) : el('p', { className: 'text dim', text: 'The file starts with no comment.' }),
        el('p', { className: 'text dim', text: `${KINDS[entity.kind].machine}: ${KINDS[entity.kind].meaning}` }),
        el('div', { className: 'prop' }, el('span', { text: 'Zone' }), el('span', {}, zoneLink(entity.zone))),
      ]),
    );
    const channels = Array.isArray(entity.data?.channels) ? (entity.data.channels as string[]) : [];
    if (channels.length) {
      parts.push(
        component(
          'Runtime channels',
          '📡',
          [
            el('p', { className: 'text dim', text: 'How this file talks beyond its imports, and how the factory shows it.' }),
            ...channels.map((name) => el('div', { className: 'prop' }, el('span', { text: CHANNELS[name]?.name ?? name }), el('span', { className: 'text', text: CHANNELS[name]?.meaning ?? '' }))),
          ],
          channels.length,
        ),
      );
    }
    const inputs = index.inputs.get(entity.id) ?? [];
    const outputs = index.outputs.get(entity.id) ?? [];
    if (inputs.length) parts.push(component('Inputs', '⬅', [el('p', { className: 'text dim', text: 'What flows into this machine.' }), edgeList(inputs, 'from')], inputs.length));
    if (outputs.length) parts.push(component('Outputs', '➡', [el('p', { className: 'text dim', text: 'Where this machine sends its output.' }), edgeList(outputs, 'to')], outputs.length));
    if (entity.packages?.length) parts.push(component('Packages', '📦', [el('div', { className: 'links' }, ...entity.packages.map((name) => el('div', { className: 'ln mono', text: name })))], entity.packages.length));
    const file = entity.file;
    if (file && !/\.(png|jpe?g|webp|gif|ico|svg|woff2?|mp4|wav)$/i.test(file)) {
      const target = el('div', { className: 'wide' });
      const line = typeof entity.data?.line === 'number' ? entity.data.line : undefined;
      const source = component('Source', '🔍', [el('div', { className: 'dim', text: file }), target]);
      let loaded = false;
      const load = (): void => {
        if (loaded) return;
        loaded = true;
        void loadSource(file, line, target);
      };
      source.addEventListener('toggle-comp', (event) => {
        if ((event as CustomEvent<{ open: boolean }>).detail.open) load();
      });
      if (!source.classList.contains('closed')) load();
      parts.push(source);
    }
    parts.push(el('div', { className: 'add-comp' }, el('button', { disabled: true, text: 'Add Component' })));
    container.replaceChildren(...(parts.filter(Boolean) as Node[]));
  }

  function showZone(zoneId: ZoneId): void {
    const index = getIndex();
    const zone = ZONES[zoneId];
    const entities = index.byZone.get(zoneId) ?? [];
    const files = entities.filter((entity) => entity.file === entity.id);
    const lines = files.reduce((sum, entity) => sum + (entity.lines ?? 0), 0);
    const trunks = new Map<string, { in: number; out: number }>();
    for (const edge of index.model.edges) {
      const a = index.byId.get(edge.from)?.zone;
      const b = index.byId.get(edge.to)?.zone;
      if (!a || !b || a === b || (a !== zoneId && b !== zoneId)) continue;
      const other = a === zoneId ? b : a;
      const entry = trunks.get(other) ?? { in: 0, out: 0 };
      if (a === zoneId) entry.out += 1;
      else entry.in += 1;
      trunks.set(other, entry);
    }
    const biggest = [...files].sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0)).slice(0, 8);
    container.replaceChildren(
      header(zone.icon || '◆', zone.title, zone.color, zoneId, 'Zone'),
      component('Zone', '▦', [
        prop('Holds', zone.holds),
        prop('Machines', String(entities.length)),
        prop('Files', String(files.length)),
        prop('Lines', formatNumber(lines)),
      ]),
      component('How it works', '📖', [...zone.story.map((text) => el('p', { className: 'text', text })), el('ul', { className: 'facts' }, ...zone.facts.map((fact) => el('li', { text: fact })))]),
      component('Building', '🏛', [prop('Style', STYLES[zoneId].name), el('p', { className: 'text', text: STYLES[zoneId].meaning })]),
      component(
        'Power',
        '⚡',
        (power().get(zoneId) ?? []).length
          ? (power().get(zoneId) ?? []).map(({ source, detail }) => el('div', {}, prop('Source', el('b', { style: { color: SOURCES[source].color }, text: SOURCES[source].name })), el('p', { className: 'text', text: `${SOURCES[source].meaning} ${detail}` })))
          : [el('p', { className: 'text dim', text: 'No power: nothing here runs. The files are stored, shipped or read, not executed.' })],
      ),
      biggest.length === 0 ? '' : component('Biggest machines', '🏭', [el('div', { className: 'links' }, ...biggest.map((entity) => el('div', { className: 'ln' }, link(entity.id, entity.id), el('span', { className: 'badge', text: `${formatNumber(entity.lines ?? 0)} lines` }))))]),
      component(
        'Road traffic',
        '⇄',
        [
          el('p', { className: 'text dim', text: 'Belts to and from other zones, by count.' }),
          el(
            'div',
            { className: 'links' },
            ...[...trunks]
              .sort((a, b) => b[1].in + b[1].out - (a[1].in + a[1].out))
              .map(([other, count]) => el('div', { className: 'ln' }, el('span', { className: 'swatch', style: { background: ZONES[other as ZoneId].color } }), zoneLink(other as ZoneId), el('span', { className: 'badge', text: `in ${count.in} · out ${count.out}` }))),
          ),
        ],
        trunks.size,
      ),
    );
  }

  function showNothing(): void {
    const { meta } = getIndex().model;
    container.replaceChildren(
      el(
        'div',
        { className: 'insp-empty' },
        el('p', {}, el('b', { text: 'Nothing selected.' })),
        el('p', { text: `Click a machine, a belt's end, or a zone floor in the Scene view, or pick one in the Hierarchy.` }),
        el('p', { className: 'dim', text: `${meta.repo} @ ${meta.branch} (${meta.commit}): ${meta.subject}` }),
        el('p', { className: 'dim', text: `Scanned ${new Date(meta.scannedAt).toLocaleString()}: ${meta.files} files, ${formatNumber(meta.lines)} lines.` }),
      ),
    );
  }

  return {
    show(selection) {
      container.scrollTop = 0;
      if (!selection) return showNothing();
      if (selection.type === 'zone') return showZone(selection.zone);
      const entity = getIndex().byId.get(selection.id);
      if (entity) showEntity(entity);
      else showNothing();
    },
  };
}
