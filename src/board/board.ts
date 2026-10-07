// The 4×4×4 board as page elements: the layers, their sheets and the cells. The game (src/page/board.ts)
// and the Voice room (src/sound-input/) build it here. The view (tower or flat) and the layout come from
// the class names `board <view> layout-<layout>`, as style.css draws them.
//
// The tower draws each layer as flat sheets stacked in 3D, from the bottom up: the plate (the board's
// underside), the base (the board's top with a footprint under each tile), the grid of tiles (the cells
// you click), and the marks (the pieces, standing on the tiles). Each sheet is painted once; turning the
// tower only moves the sheets. The flat view shows the grid alone.
import { CELL_COUNT, SIZE, toCell } from '../game.ts';
import type { LAYOUTS, VIEWS } from '../protocol.ts';

type View = (typeof VIEWS)[number];
type Layout = (typeof LAYOUTS)[number];

// Heights above the board's top, in cells.
const SHEETS = { plate: -0.14, base: 0, grid: 0.035, marks: 0.065 } as const;
type Sheet = keyof typeof SHEETS;

// The tower's fixed tilt, in degrees. Only the spin changes.
const TOWER_TILT = 62;

export type Board = {
  root: HTMLElement;
  cells: HTMLButtonElement[];
  // The piece of each cell on the marks sheet (the tower draws the pieces there).
  marks: HTMLSpanElement[];
  layers: HTMLDivElement[];
  sheets: { element: HTMLDivElement; sheet: Sheet }[];
  // The camera transform on the sheets now, so an unchanged camera writes no style.
  camera: string;
};

export function buildBoard(root: HTMLElement): Board {
  const board: Board = { root, cells: [], marks: [], layers: [], sheets: [], camera: '' };
  const sheetOf = (sheet: Sheet, className: string): HTMLDivElement => {
    const element = document.createElement('div');
    element.className = className;
    board.sheets.push({ element, sheet });
    return element;
  };
  for (let layer = 0; layer < SIZE; layer++) {
    const layerEl = document.createElement('div');
    layerEl.className = 'layer';
    layerEl.style.setProperty('--i', String(layer));
    layerEl.innerHTML = `<span class="layer-label">Layer ${layer + 1}</span>`;
    const plate = sheetOf('plate', 'plate');
    const base = sheetOf('base', 'grid base');
    const grid = sheetOf('grid', 'grid');
    const markSheet = sheetOf('marks', 'grid marks');
    for (let row = 0; row < SIZE; row++) {
      for (let column = 0; column < SIZE; column++) {
        const cell = toCell({ layer, row, column });
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cell';
        button.dataset.cell = String(cell);
        button.innerHTML = '<span class="piece"></span>';
        board.cells[cell] = button;
        grid.append(button);
        base.append(Object.assign(document.createElement('span'), { className: 'foot' }));
        const mark = document.createElement('span');
        mark.className = 'mark';
        mark.innerHTML = '<span class="piece"></span>';
        board.marks[cell] = mark;
        markSheet.append(mark);
      }
    }
    // Bottom sheet first: the sheets paint in this order, so higher sheets cover lower ones.
    layerEl.append(plate, base, grid, markSheet);
    board.layers.push(layerEl);
    root.append(layerEl);
  }
  if (board.cells.length !== CELL_COUNT) throw new Error('board build is incomplete');
  return board;
}

// The class names of the view and the layout. The caller adds its own state classes after them.
export const boardClass = (view: View, layout: Layout): string => `board ${view} layout-${layout}`;

// Turning the tower only changes the transform of the 16 sheets. Each sheet is flat (style.css),
// so the browser turns it as one ready-made picture: the cost of a frame does not grow with the
// number of marks. Nothing else on the page is restyled during a drag.
export function applyCamera(board: Board, view: View, spin: number): void {
  const turn = view === 'tower' ? `rotateX(${TOWER_TILT}deg) rotateZ(${spin}deg)` : '';
  if (turn === board.camera) return;
  board.camera = turn;
  // Each sheet rises by its height in the board's own frame, so the edges show under the
  // tiles and pieces at any turn.
  for (const { element, sheet } of board.sheets) {
    element.style.transform = turn && `${turn} translateZ(calc(var(--cell) * ${SHEETS[sheet]}))`;
  }
}

// Shows the piece of `player` (or none) on a cell, on both the cell and the marks sheet.
export function showMark(board: Board, cell: number, player: 'X' | 'O' | null): void {
  for (const element of [board.cells[cell], board.marks[cell]]) {
    element?.classList.toggle('x', player === 'X');
    element?.classList.toggle('o', player === 'O');
  }
}
