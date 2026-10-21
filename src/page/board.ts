// The board of the game page: its cells, the tower camera, and the drag in the stage that turns the tower.
// src/board/ builds the board and turns it; this file adds what a cell does in the game.
import { applyCamera as applyBoardCamera, buildBoard } from '../board/board.ts';
import { setupSpinDrag } from '../board/spin-drag.ts';
import { boardEl, stageEl } from './dom.ts';
import { refuseTap } from './feedback.ts';
import { humanMove, pressUndoes } from './sessions.ts';
import { settings, saveSettings } from './settings.ts';
import { tapsLocked } from './state.ts';

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

export function applyCamera(): void {
  applyBoardCamera(board, settings.view, settings.spin);
}

export function setupBoard(): void {
  cells.forEach((button, cell) => {
    button.addEventListener('click', () => (tapsLocked() && !pressUndoes(cell) ? refuseTap() : humanMove(cell, 'board')));
  });

  setupSpinDrag(stageEl, {
    active: () => settings.view === 'tower' && !boardEl.hidden,
    spin: () => settings.spin,
    turn: (spin) => {
      settings.spin = spin;
      applyCamera();
    },
    started: () => undefined,
    ended: () => {
      applyCamera();
      saveSettings();
    },
  });

  // The refusal flash ends by itself. Removing the class lets the next refusal play it again.
  for (const button of cells) {
    button.addEventListener('animationend', (event) => {
      if (event.animationName === 'reject') button.classList.remove('shake');
    });
  }
}
