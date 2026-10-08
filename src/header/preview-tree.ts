// The previews as a tree: a stacked pull request goes under its parent, in the order of the list.
import type { Preview } from '../protocol.ts';

export type PreviewNode = { preview: Preview; children: PreviewNode[] };

export function previewTree(previews: readonly Preview[]): PreviewNode[] {
  const nodes = new Map(previews.map((preview) => [preview.number, { preview, children: [] as PreviewNode[] }]));
  const roots: PreviewNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentNode(node.preview, nodes);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  return roots;
}

// The listed parent, or undefined for a top level preview. A preview in a loop of parents is top level, so it never disappears.
function parentNode(preview: Preview, nodes: ReadonlyMap<number, PreviewNode>): PreviewNode | undefined {
  if (preview.parent === null) return undefined;
  const parent = nodes.get(preview.parent);
  if (parent === undefined) return undefined;
  const seen = new Set<number>();
  for (let step: Preview | undefined = parent.preview; step !== undefined; step = step.parent === null ? undefined : nodes.get(step.parent)?.preview) {
    if (step.number === preview.number) return undefined;
    if (seen.has(step.number)) break;
    seen.add(step.number);
  }
  return parent;
}
