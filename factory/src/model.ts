// Lookups over the factory model that the panels share.

import type { Edge, Entity, EntityKind, FactoryModel, ZoneId } from '../scan/model.ts';

export type Selection = { type: 'entity'; id: string } | { type: 'zone'; zone: ZoneId } | null;

export interface ModelIndex {
  model: FactoryModel;
  byId: Map<string, Entity>;
  inputs: Map<string, Edge[]>;
  outputs: Map<string, Edge[]>;
  byZone: Map<ZoneId, Entity[]>;
  /** The entity a child nests under in the hierarchy: a test under its file, a job under its workflow. */
  parentOf(entity: Entity): string | undefined;
}

export const KIND_ICONS: Record<EntityKind, string> = {
  module: '⚙',
  test: '✓',
  spec: '✈',
  style: '🎨',
  page: '🏪',
  config: '🎛',
  doc: '📋',
  asset: '📦',
  script: '🦾',
  route: '🚪',
  table: '🛢',
  volume: '💾',
  workflow: '🚦',
  job: '🔨',
  stage: '🐳',
  service: '🏗',
  dep: '🛢',
  hub: '◎',
};

export function indexModel(model: FactoryModel): ModelIndex {
  const byId = new Map(model.entities.map((entity) => [entity.id, entity]));
  const inputs = new Map<string, Edge[]>();
  const outputs = new Map<string, Edge[]>();
  for (const edge of model.edges) {
    inputs.set(edge.to, [...(inputs.get(edge.to) ?? []), edge]);
    outputs.set(edge.from, [...(outputs.get(edge.from) ?? []), edge]);
  }
  const byZone = new Map<ZoneId, Entity[]>();
  for (const entity of model.entities) byZone.set(entity.zone, [...(byZone.get(entity.zone) ?? []), entity]);
  return {
    model,
    byId,
    inputs,
    outputs,
    byZone,
    parentOf(entity) {
      if (entity.kind === 'test' && entity.testOf) return entity.testOf;
      if (entity.kind === 'job' && entity.file) return entity.file;
      if (entity.kind === 'stage') return 'Dockerfile';
      if (entity.kind === 'service' && entity.file) return entity.file;
      return undefined;
    },
  };
}

export function sameSelection(a: Selection, b: Selection): boolean {
  if (a === null || b === null) return a === b;
  if (a.type === 'entity' && b.type === 'entity') return a.id === b.id;
  if (a.type === 'zone' && b.type === 'zone') return a.zone === b.zone;
  return false;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = String(value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

export function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
