import { describe, expect, it } from 'vitest';
import type { Preview } from '../protocol.ts';
import { type PreviewNode, previewTree } from './preview-tree.ts';

const preview = (number: number, parent: number | null = null): Preview => ({
  number,
  title: `Pull ${number}`,
  description: '',
  url: `https://github.com/octo/game/pull/${number}`,
  previewUrl: `https://pr.${number}.game.example.com`,
  updatedAt: 0,
  draft: false,
  contributors: [],
  parent,
});

type Shape = { number: number; children: Shape[] };
const shape = (nodes: PreviewNode[]): Shape[] => nodes.map((node) => ({ number: node.preview.number, children: shape(node.children) }));

describe('the previews tree', () => {
  it('nests a stacked pull request under its parent, more than one level deep, in list order', () => {
    const tree = previewTree([preview(4, 2), preview(1), preview(2, 1), preview(3, 1), preview(5)]);
    expect(shape(tree)).toEqual([
      {
        number: 1,
        children: [
          { number: 2, children: [{ number: 4, children: [] }] },
          { number: 3, children: [] },
        ],
      },
      { number: 5, children: [] },
    ]);
  });

  it('shows a pull request whose parent is not listed as top level', () => {
    expect(shape(previewTree([preview(2, 9)]))).toEqual([{ number: 2, children: [] }]);
  });

  it('shows a loop of parents as top level, so no preview disappears', () => {
    const tree = previewTree([preview(1, 2), preview(2, 1), preview(3, 1)]);
    expect(shape(tree)).toEqual([
      { number: 1, children: [{ number: 3, children: [] }] },
      { number: 2, children: [] },
    ]);
  });
});
