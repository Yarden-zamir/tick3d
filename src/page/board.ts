// The board of the game page: its cells, the tower camera, and the drag in the stage that turns the tower.
// src/board/ builds the board and turns it; this file adds what a cell does in the game.
import { applyCamera as applyBoardCamera, buildBoard } from '../board/board.ts';
import { setupSpinDrag } from '../board/spin-drag.ts';
import { toCoords } from '../game.ts';
import { sounds } from '../sound.ts';
import { boardEl, resetAngleButton, stageEl } from './dom.ts';
import { humanMove } from './sessions.ts';
import { settings, DEFAULTS, saveSettings } from './settings.ts';

const board = buildBoard(boardEl);
export const cells = board.cells;
// The piece shown on the marks sheet for each cell.
export const marks = board.marks;

export function cellButton(cell: number): HTMLButtonElement {
  const button = cells[cell];
  if (!button) throw new RangeError(`no button for cell ${cell}`);
  return button;
}

// The cell that sounds in the song of a finished game (src/page/song-control.ts), or none.
let sung: number | undefined;

export function lightSungCell(cell: number | undefined): void {
  if (sung !== undefined) cellButton(sung).classList.remove('sung');
  sung = cell;
  if (cell !== undefined) cellButton(cell).classList.add('sung');
}

function highlightColumn(cell: number | undefined): void {
  const target = cell === undefined ? undefined : toCoords(cell);
  cells.forEach((button, index) => {
    const { row, column } = toCoords(index);
    button.classList.toggle('peer', target !== undefined && row === target.row && column === target.column);
  });
}

export function applyCamera(): void {
  applyBoardCamera(board, settings.view, settings.spin);
  resetAngleButton.disabled = settings.spin === DEFAULTS.spin;
}

export function setupBoard(): void {
  cells.forEach((button, cell) => {
    button.addEventListener('click', () => humanMove(cell, 'board'));
    button.addEventListener('pointerenter', () => highlightColumn(cell));
    button.addEventListener('focus', () => highlightColumn(cell));
    button.addEventListener('pointerleave', () => highlightColumn(undefined));
  });

  setupSpinDrag(stageEl, {
    active: () => settings.view === 'tower' && !boardEl.hidden,
    spin: () => settings.spin,
    turn: (spin) => {
      settings.spin = spin;
      applyCamera();
    },
    started: () => highlightColumn(undefined),
    ended: () => {
      applyCamera();
      saveSettings();
    },
  });

  resetAngleButton.addEventListener('click', () => {
    settings.spin = DEFAULTS.spin;
    saveSettings();
    sounds.click();
    applyCamera();
  });

  // The refusal flash ends by itself. Removing the class lets the next refusal play it again.
  for (const button of cells) {
    button.addEventListener('animationend', (event) => {
      if (event.animationName === 'reject') button.classList.remove('shake');
    });
  }
}
