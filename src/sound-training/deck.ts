// The answer deck: the four layers of the board, with the markup and classes of the game's flat view
// (.board.flat, .layer, .layer-label, .grid, .cell in style.css), so it reads like the game.
import { CELL_COUNT, SIZE, toCell, toCoords } from '../game.ts';
import { chooseLayout } from './fit.ts';

// The marks that the page paints on the deck. Each one is a class on the cells.
// peer: the area under the pointer or the focus. picked: the player's pick. right and wrong: the feedback.
// last: the cell that played, with the dashed border of the last move in the game.
export type Paint = Record<'peer' | 'picked' | 'right' | 'wrong' | 'last', ReadonlySet<number>>;

export type Deck = {
  cells: readonly HTMLButtonElement[];
  layers: readonly HTMLElement[];
  dots: readonly HTMLButtonElement[];
};

export function buildDeck(root: HTMLElement, dotsEl: HTMLElement): Deck {
  const cells: HTMLButtonElement[] = [];
  const layers: HTMLElement[] = [];
  const dots: HTMLButtonElement[] = [];
  for (let layer = 0; layer < SIZE; layer++) {
    const layerEl = document.createElement('div');
    layerEl.className = 'layer';
    const label = document.createElement('span');
    label.className = 'layer-label';
    label.textContent = `Layer ${layer + 1}`;
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (let row = 0; row < SIZE; row++) {
      for (let column = 0; column < SIZE; column++) {
        const cell = toCell({ layer, row, column });
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cell';
        button.dataset.cell = String(cell);
        button.setAttribute('aria-label', `Layer ${layer + 1}, row ${row + 1}, column ${column + 1}`);
        button.setAttribute('aria-pressed', 'false');
        // One cell takes the Tab key; the arrow keys move inside the deck.
        button.tabIndex = cell === 0 ? 0 : -1;
        cells[cell] = button;
        grid.append(button);
      }
    }
    layerEl.append(label, grid);
    layers.push(layerEl);
    root.append(layerEl);

    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'train-dot';
    dot.setAttribute('aria-label', `Show layer ${layer + 1}`);
    dot.addEventListener('click', () => layerEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' }));
    dots.push(dot);
    dotsEl.append(dot);
  }
  if (cells.length !== CELL_COUNT) throw new Error('the deck build is incomplete');

  // The dots show which layers are in view when the deck scrolls.
  const markDots = () => {
    const box = root.getBoundingClientRect();
    layers.forEach((layerEl, index) => {
      const rect = layerEl.getBoundingClientRect();
      const visible = rect.right > box.left + rect.width / 2 && rect.left < box.right - rect.width / 2;
      dots[index]?.classList.toggle('current', visible);
    });
  };
  root.addEventListener('scroll', markDots, { passive: true });
  addEventListener('resize', markDots);

  // Arrow keys: left and right go along the row and on to the next layer, up and down go along the column.
  root.addEventListener('keydown', (event) => {
    const from = event.target instanceof HTMLElement ? Number(event.target.dataset.cell) : Number.NaN;
    if (!Number.isInteger(from)) return;
    const { layer, row, column } = toCoords(from);
    const flat = layer * SIZE + column;
    let to: number | undefined;
    if (event.key === 'ArrowLeft' && flat > 0) to = toCell({ layer: Math.floor((flat - 1) / SIZE), row, column: (flat - 1) % SIZE });
    else if (event.key === 'ArrowRight' && flat < SIZE * SIZE - 1) to = toCell({ layer: Math.floor((flat + 1) / SIZE), row, column: (flat + 1) % SIZE });
    else if (event.key === 'ArrowUp' && row > 0) to = toCell({ layer, row: row - 1, column });
    else if (event.key === 'ArrowDown' && row < SIZE - 1) to = toCell({ layer, row: row + 1, column });
    if (to === undefined) return;
    event.preventDefault();
    focusCell({ cells, layers, dots }, to);
  });
  return { cells, layers, dots };
}

function focusCell(deck: Deck, cell: number): void {
  for (const button of deck.cells) button.tabIndex = -1;
  const button = deck.cells[cell];
  if (button === undefined) throw new RangeError(`no deck cell ${cell}`);
  button.tabIndex = 0;
  button.focus();
}

export function paint(deck: Deck, marks: Paint): void {
  deck.cells.forEach((button, cell) => {
    for (const [name, set] of Object.entries(marks)) button.classList.toggle(name, set.has(cell));
    button.setAttribute('aria-pressed', String(marks.picked.has(cell)));
  });
  // A dot also shows where the pick and the answer are, for layers out of view.
  deck.dots.forEach((dot, layer) => {
    const inLayer = (set: ReadonlySet<number>) => [...set].some((cell) => toCoords(cell).layer === layer);
    dot.classList.toggle('picked', inLayer(marks.picked));
    dot.classList.toggle('right', inLayer(marks.right));
    dot.classList.toggle('wrong', inLayer(marks.wrong));
  });
}

// Sizes the deck to the room that the card leaves on screen. `side` is true when the card puts the
// deck beside the other parts (a short landscape screen, training.css), and false when they stack.
export function fitDeck(root: HTMLElement, card: HTMLElement, side: boolean): void {
  const style = getComputedStyle(root);
  const width = root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const rootRect = root.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const cardStyle = getComputedStyle(card);
  // The room below the deck: the card parts under it in a stack. Beside the other parts, only the dots
  // under the deck and the card padding.
  const wrapBottom = root.parentElement?.getBoundingClientRect().bottom ?? rootRect.bottom;
  const below = side ? wrapBottom - rootRect.bottom + parseFloat(cardStyle.paddingBottom) : cardRect.bottom - rootRect.bottom;
  // The page is measured from its top, so the deck fits when the player opens the page.
  const top = rootRect.top + scrollY;
  const bottomMargin = 16;
  const height = innerHeight - top - below - bottomMargin - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const layout = chooseLayout(Math.max(1, width), Math.max(1, height));
  root.dataset.mode = layout.mode;
  root.style.setProperty('--cell', `${layout.cell}px`);
  root.dispatchEvent(new Event('scroll'));
}
