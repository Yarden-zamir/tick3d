// The size and arrangement of the answer deck: the four 4×4 layers of the board, in the space left on screen.
// Each arrangement gives a largest cell size. The first arrangement whose cells are large enough to tap wins.

export type DeckLayout = { mode: 'row' | 'grid' | 'scroll'; cell: number; perView: number };

// A cell smaller than this is hard to tap on a phone. A larger cell only takes more room.
export const MIN_CELL = 36;
const MAX_CELL = 56;
// The space between two layers, in pixels. training.css uses the same value.
export const LAYER_GAP = 16;
// A layer box is 4 cells and 5 gaps of 0.1 cell wide, plus the border (2 × 3 px) and the hard shadow (6 px).
const CELLS_PER_LAYER = 4.5;
const LAYER_EXTRA = 12;
// The layer label and its gap above the grid.
const LABEL = 32;

function largestCell(width: number, height: number, columns: number, rows: number): number {
  const byWidth = (width - (columns - 1) * LAYER_GAP - columns * LAYER_EXTRA) / (columns * CELLS_PER_LAYER);
  const byHeight = (height - (rows - 1) * LAYER_GAP - rows * (LAYER_EXTRA + LABEL)) / (rows * CELLS_PER_LAYER);
  return Math.floor(Math.min(MAX_CELL, byWidth, byHeight));
}

// `width` and `height` are the room for the deck in pixels. `minCell` is the smallest cell that the page
// accepts: MIN_CELL for a deck that the player taps, less for a deck that mainly shows (/sound-input).
export function chooseLayout(width: number, height: number, minCell = MIN_CELL): DeckLayout {
  if (!(width > 0) || !(height > 0)) throw new RangeError(`no room for the deck: ${width} × ${height}`);
  const row = largestCell(width, height, 4, 1);
  const grid = largestCell(width, height, 2, 2);
  if (row >= minCell && row >= grid) return { mode: 'row', cell: row, perView: 4 };
  if (grid >= minCell) return { mode: 'grid', cell: grid, perView: 4 };
  // A scroll deck: one row of layers. One more cell of width lets the next layer peek in, so the player
  // sees that the deck scrolls.
  const byHeight = largestCell(Infinity, height, 1, 1);
  for (const perView of [2, 1]) {
    const byWidth = Math.floor((width - perView * (LAYER_EXTRA + LAYER_GAP)) / (perView * CELLS_PER_LAYER + 1));
    const cell = Math.min(byWidth, byHeight);
    if (cell >= minCell) return { mode: 'scroll', cell, perView };
  }
  // Too small a screen for one large layer: keep the cells large enough to tap. The page scrolls then.
  return { mode: 'scroll', cell: minCell, perView: 1 };
}
