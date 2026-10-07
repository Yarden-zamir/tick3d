// The board: its cells and sheets, the tower camera, and the drag in the stage that turns the tower.
import { SIZE, toCell, CELL_COUNT, toCoords } from '../game.ts';
import { boardEl, stageEl } from './dom.ts';
import { startsDrag } from './drag.ts';
import { humanMove } from './sessions.ts';
import { settings, wrapSpin, saveSettings } from './settings.ts';

export const cells: HTMLButtonElement[] = [];
// The tower draws each layer as flat sheets stacked in 3D, from the bottom up: the plate (the
// board's underside), the base (the board's top with a footprint under each tile), the grid of
// tiles (the cells you click), and the marks (the pieces, standing on the tiles). Each sheet is
// painted once; turning the tower only moves the sheets. The flat view shows the grid alone.
// Heights above the board's top, in cells.
const SHEETS = { plate: -0.14, base: 0, grid: 0.035, marks: 0.065 } as const;
type Sheet = keyof typeof SHEETS;
const sheets: { element: HTMLDivElement; sheet: Sheet }[] = [];
// The piece shown on the marks sheet for each cell.
export const marks: HTMLSpanElement[] = [];

function sheetOf(sheet: Sheet, className: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = className;
  sheets.push({ element, sheet });
  return element;
}

export function cellButton(cell: number): HTMLButtonElement {
  const button = cells[cell];
  if (!button) throw new RangeError(`no button for cell ${cell}`);
  return button;
}

function highlightColumn(cell: number | undefined): void {
  const target = cell === undefined ? undefined : toCoords(cell);
  cells.forEach((button, index) => {
    const { row, column } = toCoords(index);
    button.classList.toggle('peer', target !== undefined && row === target.row && column === target.column);
  });
}

// The tower only turns around its vertical axis: the tilt stays at the resting view.
// Degrees of turn per pixel dragged sideways.
const DRAG_SPIN = 0.4;
// A press counts as a drag after this many pixels sideways, so a tap still places a mark.
const DRAG_THRESHOLD = 6;

// The tower's fixed tilt, in degrees. Only the spin changes.
const TOWER_TILT = 62;
let cameraShown = '';

// Turning the tower only changes the transform of the 16 sheets. Each sheet is flat (style.css),
// so the browser turns it as one ready-made picture: the cost of a frame does not grow with the
// number of marks. Nothing else on the page is restyled during a drag.
export function applyCamera(): void {
  const turn = settings.view === 'tower' ? `rotateX(${TOWER_TILT}deg) rotateZ(${settings.spin}deg)` : '';
  if (turn !== cameraShown) {
    cameraShown = turn;
    // Each sheet rises by its height in the board's own frame, so the edges show under the
    // tiles and pieces at any turn.
    for (const { element, sheet } of sheets) {
      element.style.transform = turn && `${turn} translateZ(calc(var(--cell) * ${SHEETS[sheet]}))`;
    }
  }
}

type Drag = { pointer: number; x: number; spin: number; moved: boolean };
let drag: Drag | undefined;
let dragFrame = 0;
// The click that ends a drag must not place a mark.
let swallowClick = false;

function endDrag(event: PointerEvent): void {
  if (drag === undefined || event.pointerId !== drag.pointer) return;
  if (drag.moved) {
    // A click follows pointerup in the same task, or not at all. Either way the flag ends here.
    swallowClick = event.type === 'pointerup';
    setTimeout(() => (swallowClick = false));
    delete stageEl.dataset.dragging;
    applyCamera();
    saveSettings();
  }
  drag = undefined;
}

export function setupBoard(): void {
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
        button.innerHTML = '<span class="piece"></span>';
        button.addEventListener('click', () => humanMove(cell, 'board'));
        button.addEventListener('pointerenter', () => highlightColumn(cell));
        button.addEventListener('focus', () => highlightColumn(cell));
        button.addEventListener('pointerleave', () => highlightColumn(undefined));
        cells[cell] = button;
        grid.append(button);
        base.append(Object.assign(document.createElement('span'), { className: 'foot' }));
        const mark = document.createElement('span');
        mark.className = 'mark';
        mark.innerHTML = '<span class="piece"></span>';
        marks[cell] = mark;
        markSheet.append(mark);
      }
    }
    // Bottom sheet first: the sheets paint in this order, so higher sheets cover lower ones.
    layerEl.append(plate, base, grid, markSheet);
    boardEl.append(layerEl);
  }
  if (cells.length !== CELL_COUNT) throw new Error('board build is incomplete');

  // A drag starts anywhere in the stage, so the player does not have to hit the narrow tower.
  stageEl.addEventListener('pointerdown', (event) => {
    if (settings.view !== 'tower' || boardEl.hidden || !event.isPrimary || event.button !== 0 || !startsDrag(event.target)) return;
    drag = { pointer: event.pointerId, x: event.clientX, spin: settings.spin, moved: false };
  });

  stageEl.addEventListener('pointermove', (event) => {
    if (drag === undefined || event.pointerId !== drag.pointer) return;
    // The button came up outside the stage, where pointerup does not reach it.
    if (event.buttons === 0) return endDrag(event);
    const dx = event.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return;
      drag.moved = true;
      stageEl.dataset.dragging = '';
      stageEl.setPointerCapture(event.pointerId);
      highlightColumn(undefined);
    }
    settings.spin = wrapSpin(drag.spin + dx * DRAG_SPIN);
    // One style update per frame, however fast the pointer events come.
    if (dragFrame === 0) {
      dragFrame = requestAnimationFrame(() => {
        dragFrame = 0;
        applyCamera();
      });
    }
  });

  stageEl.addEventListener('pointerup', endDrag);
  // The browser takes over a touch that turns into a vertical scroll.
  stageEl.addEventListener('pointercancel', endDrag);

  stageEl.addEventListener(
    'click',
    (event) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.stopPropagation();
      event.preventDefault();
    },
    true,
  );

  // The refusal flash ends by itself. Removing the class lets the next refusal play it again.
  for (const button of cells) {
    button.addEventListener('animationend', (event) => {
      if (event.animationName === 'reject') button.classList.remove('shake');
    });
  }
}
