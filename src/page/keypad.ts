// The keypad that places a move by layer, row and column.
import { toCell, other, toCoords, SIZE } from '../game.ts';
import { sounds } from '../sound.ts';
import { cells } from './board.ts';
import { coordsSlots, coordsSlotsEl, coordsTitle, coordsHear, digitButtons, coordsBack, coordsPlace, coordsForm } from './dom.ts';
import { showProblem } from './feedback.ts';
import { playerName } from './render.ts';
import { humanMove } from './sessions.ts';
import { page, current } from './state.ts';

// The cell the keypad points at once layer, row and column are all chosen.
function coordTarget(): number | undefined {
  const [layer, row, column] = page.coordDigits;
  if (layer === undefined || row === undefined || column === undefined) return undefined;
  return toCell({ layer: layer - 1, row: row - 1, column: column - 1 });
}

// Until the player taps a number, the slots show the last move of the game, so its
// coordinates stay readable with the board hidden. A tap starts the player's own entry.
export function renderCoords(): void {
  const game = current();
  const last = game.moves.at(-1);
  const showLast = page.coordDigits.length === 0 && last !== undefined;
  const lastPlayer = other(game.turn);
  let digits = page.coordDigits;
  if (showLast) {
    const { layer, row, column } = toCoords(last);
    digits = [layer + 1, row + 1, column + 1];
  }
  coordsSlots.forEach((slot, i) => {
    slot.textContent = String(digits[i] ?? '');
    slot.parentElement?.classList.toggle('next', !showLast && i === page.coordDigits.length);
  });
  coordsSlotsEl.classList.toggle('played-x', showLast && lastPlayer === 'X');
  coordsSlotsEl.classList.toggle('played-o', showLast && lastPlayer === 'O');
  const name = playerName(lastPlayer);
  const mark = name === `Player ${lastPlayer}` ? '' : ` (${lastPlayer})`;
  coordsTitle.textContent = showLast ? `${name} played${mark}` : 'Move by coordinates';
  const target = coordTarget();
  cells.forEach((button, cell) => button.classList.toggle('aim', cell === target));
  const full = page.coordDigits.length === 3;
  // The speaker plays the typed cell, or else the last move, so a game works by ear.
  coordsHear.hidden = !full && !showLast;
  digitButtons.forEach((button) => (button.disabled = full));
  coordsBack.disabled = page.coordDigits.length === 0;
  coordsPlace.disabled = !full;
}

export function setupKeypad(): void {
  digitButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const digit = Number(button.dataset.digit);
      if (!Number.isInteger(digit) || digit < 1 || digit > SIZE) throw new Error(`bad keypad digit ${button.dataset.digit}`);
      if (page.coordDigits.length >= 3) return;
      page.coordDigits = [...page.coordDigits, digit];
      const target = coordTarget();
      // The third number names a cell: its own sound tells the player which cell Place takes.
      if (target === undefined) sounds.click();
      else sounds.preview(target);
      renderCoords();
    });
  });

  coordsHear.addEventListener('click', () => {
    const target = coordTarget();
    const game = current();
    const last = game.moves.at(-1);
    if (target !== undefined) sounds.preview(target);
    else if (last !== undefined) sounds.place(other(game.turn), last);
  });

  coordsBack.addEventListener('click', () => {
    page.coordDigits = page.coordDigits.slice(0, -1);
    sounds.click();
    renderCoords();
  });

  coordsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const target = coordTarget();
    if (target === undefined) {
      showProblem('Tap a layer, a row and a column first.');
      return;
    }
    page.coordDigits = [];
    humanMove(target, 'keypad');
    renderCoords();
  });
}
