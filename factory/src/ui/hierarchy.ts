// The Hierarchy panel: the factory as a tree of zones, groups and machines (with tests, jobs, stages
// and services nested under their files), and the Project tab: the repository's own folder tree.

import type { Entity, EntityKind, ZoneId } from '../../scan/model.ts';
import { ZONES, ZONE_ORDER } from '../lore.ts';
import { KIND_ICONS, type ModelIndex, type Selection, el, formatNumber } from '../model.ts';

interface TreeNode {
  key: string;
  label: string;
  icon: string;
  color?: string;
  meta?: string;
  select?: Selection;
  className?: string;
  children: TreeNode[];
}

const GROUPS: [string, EntityKind[]][] = [
  ['Pages', ['page']],
  ['Modules', ['module', 'test']],
  ['Workflows', ['workflow']],
  ['Docker & compose', ['stage', 'service']],
  ['API routes', ['route']],
  ['Tables', ['table']],
  ['Volumes', ['volume']],
  ['Styles', ['style']],
  ['Scripts', ['script']],
  ['E2E specs', ['spec']],
  ['Config', ['config']],
  ['Documents', ['doc']],
  ['Assets', ['asset']],
  ['Runtime packages', []],
  ['Dev packages', []],
];

function entityNode(entity: Entity, index: ModelIndex, children: Map<string, Entity[]>): TreeNode {
  const zone = ZONES[entity.zone];
  const meta = entity.lines !== undefined ? `${formatNumber(entity.lines)}` : entity.kind === 'dep' ? String(entity.data?.version ?? '') : '';
  return {
    key: `e:${entity.id}`,
    label: entity.kind === 'route' || entity.kind === 'job' || entity.kind === 'service' || entity.kind === 'dep' || entity.kind === 'table' ? entity.label : entity.id.split('/').pop() ?? entity.id,
    icon: KIND_ICONS[entity.kind],
    color: entity.kind === 'test' ? ZONES.qa.color : zone.color,
    meta,
    select: { type: 'entity', id: entity.id },
    children: (children.get(entity.id) ?? []).map((child) => entityNode(child, index, children)),
  };
}

function architectureTree(index: ModelIndex): TreeNode[] {
  const children = new Map<string, Entity[]>();
  const nested = new Set<string>();
  for (const entity of index.model.entities) {
    const parent = index.parentOf(entity);
    if (parent && index.byId.has(parent)) {
      children.set(parent, [...(children.get(parent) ?? []), entity]);
      nested.add(entity.id);
    }
  }
  const zones = ZONE_ORDER.map((zoneId): TreeNode => {
    const zone = ZONES[zoneId];
    const entities = (index.byZone.get(zoneId) ?? []).filter((entity) => !nested.has(entity.id));
    const groups: TreeNode[] = [];
    for (const [name, kinds] of GROUPS) {
      let members: Entity[];
      if (name === 'Runtime packages') members = entities.filter((entity) => entity.kind === 'dep' && entity.data?.runtime === true);
      else if (name === 'Dev packages') members = entities.filter((entity) => entity.kind === 'dep' && entity.data?.runtime !== true);
      else members = entities.filter((entity) => kinds.includes(entity.kind));
      if (members.length === 0) continue;
      members.sort((a, b) => (a.kind === 'route' || a.kind === 'job' ? 0 : a.id.localeCompare(b.id)));
      let nodes: TreeNode[];
      if (name === 'API routes') {
        // Routes by their OpenAPI tag.
        const tags = new Map<string, Entity[]>();
        for (const route of members) tags.set(String(route.data?.tag ?? 'Other'), [...(tags.get(String(route.data?.tag ?? 'Other')) ?? []), route]);
        nodes = [...tags].map(([tag, routes]) => ({
          key: `g:${zoneId}:route:${tag}`,
          label: tag,
          icon: '🏷',
          meta: String(routes.length),
          className: 'group',
          children: routes.map((route) => entityNode(route, index, children)),
        }));
      } else {
        nodes = members.map((entity) => entityNode(entity, index, children));
      }
      groups.push({ key: `g:${zoneId}:${name}`, label: name, icon: '▤', meta: String(members.length), className: 'group', children: nodes });
    }
    const all = index.byZone.get(zoneId) ?? [];
    return {
      key: `z:${zoneId}`,
      label: zone.title,
      icon: zone.icon || '◆',
      color: zone.color,
      meta: String(all.length),
      select: { type: 'zone', zone: zoneId },
      className: 'zone',
      children: groups,
    };
  });
  const { meta } = index.model;
  return [{ key: 'root', label: `${meta.repo} · ${meta.branch}`, icon: '◆', color: '#ffd23f', meta: meta.commit, className: 'zone', children: zones }];
}

function projectTree(index: ModelIndex): TreeNode[] {
  const root: TreeNode = { key: 'd:', label: index.model.meta.repo, icon: '📁', children: [] };
  const folders = new Map<string, TreeNode>([['', root]]);
  const files = index.model.entities.filter((entity) => entity.file === entity.id).sort((a, b) => a.id.localeCompare(b.id));
  const folderOf = (path: string): TreeNode => {
    const existing = folders.get(path);
    if (existing) return existing;
    const parts = path.split('/');
    const parent = folderOf(parts.slice(0, -1).join('/'));
    const node: TreeNode = { key: `d:${path}`, label: parts[parts.length - 1] ?? path, icon: '📁', children: [] };
    folders.set(path, node);
    parent.children.push(node);
    return node;
  };
  for (const file of files) {
    const dir = file.id.includes('/') ? file.id.slice(0, file.id.lastIndexOf('/')) : '';
    folderOf(dir).children.push({
      key: `f:${file.id}`,
      label: file.label,
      icon: KIND_ICONS[file.kind],
      color: ZONES[file.zone].color,
      meta: file.lines !== undefined ? formatNumber(file.lines) : '',
      select: { type: 'entity', id: file.id },
      children: [],
    });
  }
  const sort = (node: TreeNode): void => {
    node.children.sort((a, b) => (a.icon === '📁') !== (b.icon === '📁') ? (a.icon === '📁' ? -1 : 1) : a.label.localeCompare(b.label));
    node.children.forEach(sort);
    if (node.icon === '📁') node.meta = String(node.children.length);
  };
  sort(root);
  return [root];
}

export interface Hierarchy {
  reveal(selection: Selection): void;
  focusSearch(): void;
  rebuild(index: ModelIndex): void;
}

export function createHierarchy(
  container: HTMLElement,
  search: HTMLInputElement,
  tabs: HTMLElement[],
  start: ModelIndex,
  onSelect: (selection: Selection) => void,
  onFocus: (selection: Selection) => void,
): Hierarchy {
  let tab: 'hierarchy' | 'project' = 'hierarchy';
  let trees: Record<'hierarchy' | 'project', TreeNode[]> = { hierarchy: architectureTree(start), project: projectTree(start) };
  const expanded = new Set<string>(['root', 'd:']);
  let selectedKey: string | null = null;
  let query = '';

  const keyOf = (selection: Selection): string | null => {
    if (!selection) return null;
    if (selection.type === 'zone') return tab === 'hierarchy' ? `z:${selection.zone}` : null;
    return tab === 'hierarchy' ? `e:${selection.id}` : `f:${selection.id}`;
  };

  const matches = (node: TreeNode): boolean => {
    if (!query) return true;
    const haystack = `${node.label} ${node.select?.type === 'entity' ? node.select.id : ''}`.toLowerCase();
    return haystack.includes(query);
  };

  // With a query: keep matches and their ancestors, and open every ancestor.
  const filter = (nodes: TreeNode[]): TreeNode[] => {
    if (!query) return nodes;
    const out: TreeNode[] = [];
    for (const node of nodes) {
      const children = filter(node.children);
      if (matches(node) || children.length > 0) out.push({ ...node, children: matches(node) && children.length === 0 ? node.children : children });
    }
    return out;
  };

  const highlight = (label: string): (Node | string)[] => {
    if (!query) return [label];
    const at = label.toLowerCase().indexOf(query);
    if (at < 0) return [label];
    return [label.slice(0, at), el('mark', { text: label.slice(at, at + query.length) }), label.slice(at + query.length)];
  };

  function render(): void {
    const scroll = container.scrollTop;
    container.replaceChildren();
    const fragment = document.createDocumentFragment();
    const walk = (nodes: TreeNode[], depth: number): void => {
      for (const node of nodes) {
        const open = query ? true : expanded.has(node.key);
        const hasChildren = node.children.length > 0;
        const row = el(
          'div',
          { className: `row ${node.className ?? ''} ${node.key === selectedKey ? 'selected' : ''}`, 'data-key': node.key, style: { paddingLeft: `${4 + depth * 14}px` } },
          el('span', { className: 'fold', text: hasChildren ? (open ? '▼' : '▶') : '' }),
          el('span', { className: 'ico', style: { color: node.color ?? '#bbb' }, text: node.icon }),
          el('span', { className: 'name' }, ...highlight(node.label)),
          node.meta ? el('span', { className: 'meta', text: node.meta }) : null,
        );
        row.addEventListener('click', (event) => {
          const target = event.target as HTMLElement;
          if (target.classList.contains('fold') || !node.select) {
            if (expanded.has(node.key)) expanded.delete(node.key);
            else expanded.add(node.key);
            render();
            return;
          }
          onSelect(node.select);
        });
        row.addEventListener('dblclick', () => {
          if (node.select) onFocus(node.select);
        });
        fragment.append(row);
        if (hasChildren && open) walk(node.children, depth + 1);
      }
    };
    walk(filter(trees[tab]), 0);
    container.append(fragment);
    container.scrollTop = scroll;
  }

  function pathTo(nodes: TreeNode[], key: string, trail: string[] = []): string[] | null {
    for (const node of nodes) {
      if (node.key === key) return trail;
      const found = pathTo(node.children, key, [...trail, node.key]);
      if (found) return found;
    }
    return null;
  }

  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    render();
  });

  for (const button of tabs) {
    button.addEventListener('click', () => {
      tab = button.dataset.tab === 'project' ? 'project' : 'hierarchy';
      for (const other of tabs) other.classList.toggle('active', other === button);
      render();
    });
  }

  // Zones open by default so the first look shows the groups.
  for (const zone of ZONE_ORDER) expanded.add(`z:${zone as ZoneId}`);
  render();

  return {
    reveal(selection) {
      selectedKey = keyOf(selection);
      if (selectedKey) for (const key of pathTo(trees[tab], selectedKey) ?? []) expanded.add(key);
      render();
      const row = container.querySelector(`[data-key="${CSS.escape(selectedKey ?? '')}"]`);
      row?.scrollIntoView({ block: 'nearest' });
    },
    focusSearch() {
      search.focus();
      search.select();
    },
    rebuild(index) {
      trees = { hierarchy: architectureTree(index), project: projectTree(index) };
      render();
    },
  };
}

