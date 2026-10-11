// The Tesseract experiment page (/tesseract): tic-tac-toe on a 4×4×4×4 board, against a friend on this
// device or the computer. The page shows one cube at full size and a map of all four cubes, as the
// 4D research suggests: 256 full-size cells at once is too much for a phone. The 4D view (view4d.ts)
// draws all four cubes at once as a turning tesseract instead.
// src/tesseract/rules.ts holds the rules and ai.ts the computer. The game stays in this browser only.
import '../style.css';
import './tesseract.css';
import { element } from '../element.ts';
import { setupPageHeader } from '../header/header.ts';
import { STORAGE_KEYS } from '../storage-keys.ts';
import { isRecord } from '../guards.ts';
import { type Level, LEVELS, chooseMove } from './ai.ts';
import { type Camera, DEFAULT_CAMERA } from './projection.ts';
import { createView4d } from './view4d.ts';
import {
  CUBE_CELLS,
  type Game,
  type Player,
  SIZE,
  formatCoordinates,
  lineSpan,
  linesThrough,
  parseCoordinates,
  play,
  replay,
  threatCells,
  toCell,
  toCoords,
} from './rules.ts';

setupPageHeader();

const statusEl = element('#status', HTMLParagraphElement);
const mapEl = element('#map', HTMLDivElement);
const boardEl = element('#board', HTMLDivElement);
const cubeTitle = element('#cube-title', HTMLHeadingElement);
const coordsEl = element('#coords', HTMLParagraphElement);
const opponentEl = element('#opponent', HTMLDivElement);
const sideEl = element('#side', HTMLDivElement);
const threatsBox = element('#show-threats', HTMLInputElement);
const typeForm = element('#type-form', HTMLFormElement);
const typeInput = element('#type-input', HTMLInputElement);
const undoButton = element('#undo', HTMLButtonElement);
const newGameButton = element('#new-game', HTMLButtonElement);
const viewEl = element('#view', HTMLDivElement);
const view4dEl = element('#view-4d', HTMLDivElement);
const canvas = element('#canvas-4d', HTMLCanvasElement);
const spinButton = element('#spin', HTMLButtonElement);
const turnInput = element('#turn-4d', HTMLInputElement);
const resetViewButton = element('#reset-view', HTMLButtonElement);

type Opponent = 'friend' | Level;
const OPPONENTS: readonly Opponent[] = ['friend', ...LEVELS];

type View = 'slices' | '4d';
type State = { game: Game; opponent: Opponent; human: Player; cube: number; showThreats: boolean; view: View };

function load(): State {
  const fresh: State = { game: replay([]), opponent: 'friend', human: 'X', cube: 0, showThreats: true, view: 'slices' };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.tesseract) ?? 'null');
    if (!isRecord(saved)) return fresh;
    const { moves, opponent, human, cube, showThreats, view } = saved;
    const isMoves = Array.isArray(moves) && moves.every((move) => typeof move === 'number');
    return {
      game: isMoves ? replay(moves) : fresh.game,
      opponent: OPPONENTS.find((value) => value === opponent) ?? fresh.opponent,
      human: human === 'O' ? 'O' : 'X',
      cube: typeof cube === 'number' && Number.isInteger(cube) && cube >= 0 && cube < SIZE ? cube : 0,
      showThreats: showThreats !== false,
      view: view === '4d' ? '4d' : 'slices',
    };
  } catch {
    // A broken or foreign save starts a new game.
    return fresh;
  }
}

function save(): void {
  const { game, opponent, human, cube, showThreats, view } = state;
  try {
    localStorage.setItem(STORAGE_KEYS.tesseract, JSON.stringify({ moves: game.moves, opponent, human, cube, showThreats, view }));
  } catch {
    // Without storage the game still plays; it only does not survive a reload.
  }
}

const state = load();
// Counts started games and undos, so a computer move for an older position is dropped.
let generation = 0;
let thinking = false;
// The cell under the pointer or the focus: the cells on its lines show as peers.
let aimed: number | undefined;
let camera: Camera = { ...DEFAULT_CAMERA };
// The 4D spin starts off: the view moves on its own only when the player asks.
let spinning = false;

const computerTurn = () => state.opponent !== 'friend' && state.game.turn !== state.human && state.game.status.kind === 'playing';

// ---- Building ----

const dots: HTMLSpanElement[] = [];
const minis: HTMLButtonElement[] = [];
for (let cube = 0; cube < SIZE; cube++) {
  const mini = document.createElement('button');
  mini.type = 'button';
  mini.className = 'tess-mini';
  mini.dataset.cube = String(cube);
  mini.setAttribute('aria-label', `Cube ${cube + 1}`);
  const label = Object.assign(document.createElement('span'), { className: 'tess-mini-label', textContent: `Cube ${cube + 1}` });
  const layers = Object.assign(document.createElement('span'), { className: 'tess-mini-layers' });
  for (let layer = 0; layer < SIZE; layer++) {
    const grid = Object.assign(document.createElement('span'), { className: 'tess-mini-grid' });
    for (let i = 0; i < SIZE * SIZE; i++) {
      const dot = Object.assign(document.createElement('span'), { className: 'tess-dot' });
      dots[cube * CUBE_CELLS + layer * SIZE * SIZE + i] = dot;
      grid.append(dot);
    }
    layers.append(grid);
  }
  mini.append(label, layers);
  minis.push(mini);
  mapEl.append(mini);
}

// The cells of the selected cube, by their place inside a cube (0..63).
const cells: HTMLButtonElement[] = [];
for (let layer = 0; layer < SIZE; layer++) {
  const layerEl = Object.assign(document.createElement('div'), { className: 'layer' });
  layerEl.innerHTML = `<span class="layer-label">Layer ${layer + 1}</span>`;
  const grid = Object.assign(document.createElement('div'), { className: 'grid' });
  grid.setAttribute('role', 'row');
  for (let i = 0; i < SIZE * SIZE; i++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cell';
    button.setAttribute('role', 'gridcell');
    button.innerHTML = '<span class="piece"></span>';
    button.dataset.local = String(layer * SIZE * SIZE + i);
    cells.push(button);
    grid.append(button);
  }
  layerEl.append(grid);
  boardEl.append(layerEl);
}

const globalCell = (button: HTMLButtonElement) => state.cube * CUBE_CELLS + Number(button.dataset.local);

const view4d = createView4d(canvas, {
  onAim: (cell) => {
    if (cell === aimed) return;
    aimed = cell;
    render();
  },
  // A tap plays the cell and selects its cube, so the slices show the move after a switch back.
  onPick: (cell) => {
    state.cube = Math.floor(cell / CUBE_CELLS);
    move(cell);
    render();
  },
  onCamera: (next) => {
    camera = next;
    turnInput.value = String(Math.round((next.turn4 * 180) / Math.PI) % 360);
  },
});

// ---- Drawing ----

const describe = (cell: number) => {
  const { cube, layer, row, column } = toCoords(cell);
  return `Cube ${cube + 1} · Layer ${layer + 1} · Row ${row + 1} · Column ${column + 1}`;
};

const SPAN_NAMES = ['', 'along one axis', 'diagonally in a plane', 'diagonally through a cube', 'through all four dimensions'] as const;

function statusText(): string {
  const { game, opponent, human } = state;
  switch (game.status.kind) {
    case 'won': {
      const how = SPAN_NAMES[lineSpan(game.status.line)];
      if (opponent === 'friend') return `${game.status.winner} wins, ${how}!`;
      return game.status.winner === human ? `You win, ${how}!` : `The computer wins, ${how}.`;
    }
    case 'draw':
      return 'Draw: all 256 cells are full.';
    case 'playing':
      if (thinking) return 'The computer is thinking…';
      if (opponent === 'friend') return `${game.turn} to move`;
      return `Your move (${human})`;
  }
}

function render(): void {
  const { game, cube, showThreats } = state;
  const won = game.status.kind === 'won' ? new Set(game.status.line) : new Set<number>();
  const last = game.moves.at(-1);
  const threats = {
    X: new Set(showThreats ? threatCells(game.board, 'X') : []),
    O: new Set(showThreats ? threatCells(game.board, 'O') : []),
  };
  const peers = new Set<number>();
  if (aimed !== undefined) for (const line of linesThrough(aimed)) for (const c of line) if (c !== aimed) peers.add(c);

  const paint = (target: HTMLElement, cell: number) => {
    const mark = game.board[cell];
    target.classList.toggle('x', mark === 'X');
    target.classList.toggle('o', mark === 'O');
    target.classList.toggle('win', won.has(cell));
    target.classList.toggle('last', cell === last);
    target.classList.toggle('threat-x', threats.X.has(cell));
    target.classList.toggle('threat-o', threats.O.has(cell));
    target.classList.toggle('peer', peers.has(cell));
    target.classList.toggle('aim', cell === aimed);
  };
  dots.forEach((dot, cell) => paint(dot, cell));
  for (const button of cells) {
    const cell = globalCell(button);
    paint(button, cell);
    const mark = game.board[cell];
    button.setAttribute('aria-label', `${describe(cell)}${mark === null ? '' : `, ${mark}`}`);
  }
  minis.forEach((mini, index) => {
    mini.setAttribute('aria-pressed', String(index === cube));
    mini.classList.toggle('has-last', last !== undefined && Math.floor(last / CUBE_CELLS) === index);
    mini.classList.toggle('has-win', [...won].some((cell) => Math.floor(cell / CUBE_CELLS) === index));
  });

  const in4d = state.view === '4d';
  boardEl.hidden = in4d;
  view4dEl.hidden = !in4d;
  if (in4d) {
    const winLine = game.status.kind === 'won' ? game.status.line : undefined;
    view4d.draw({ board: game.board, cube, aimed, peers, winLine, last, threats });
  }
  for (const button of viewEl.querySelectorAll<HTMLButtonElement>('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
  }
  spinButton.setAttribute('aria-pressed', String(spinning));
  spinButton.textContent = spinning ? 'Stop spinning' : 'Spin in 4D';
  cubeTitle.textContent = in4d ? 'All four cubes' : `Cube ${cube + 1}`;
  statusEl.textContent = statusText();
  statusEl.dataset.state = game.status.kind;
  document.body.dataset.turn = game.turn;
  boardEl.classList.toggle('finished', game.status.kind !== 'playing');
  boardEl.classList.toggle('thinking', thinking);
  coordsEl.textContent =
    aimed !== undefined
      ? `${describe(aimed)} · on ${linesThrough(aimed).length} lines`
      : last !== undefined
        ? `Last move: ${formatCoordinates(toCoords(last))} (${game.board[last]})`
        : 'Point at a cell to see its lines.';

  for (const button of opponentEl.querySelectorAll<HTMLButtonElement>('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.opponent === state.opponent));
  }
  for (const button of sideEl.querySelectorAll<HTMLButtonElement>('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.side === state.human));
  }
  sideEl.hidden = state.opponent === 'friend';
  threatsBox.checked = showThreats;
  undoButton.disabled = game.moves.length === 0 || thinking;
}

// ---- Playing ----

function shake(button: HTMLButtonElement | undefined): void {
  if (button === undefined) return;
  button.classList.remove('shake');
  void button.offsetWidth;
  button.classList.add('shake');
}

function move(cell: number): void {
  if (thinking || computerTurn()) return;
  const result = play(state.game, cell);
  if (!result.ok) {
    shake(cells[cell - state.cube * CUBE_CELLS]);
    return;
  }
  state.game = result.game;
  save();
  render();
  maybeComputer();
}

function maybeComputer(): void {
  if (!computerTurn() || state.opponent === 'friend') return;
  const level = state.opponent;
  const at = generation;
  thinking = true;
  render();
  // The search runs on the main thread. The pause lets the page paint "thinking" first.
  setTimeout(() => {
    if (at !== generation) return;
    const cell = chooseMove(state.game.board, state.game.turn, level);
    const result = play(state.game, cell);
    thinking = false;
    if (!result.ok) throw new Error(`the computer played an illegal move: ${result.error}`);
    state.game = result.game;
    save();
    render();
  }, 60);
}

function restart(): void {
  generation++;
  thinking = false;
  state.game = replay([]);
  save();
  render();
  maybeComputer();
}

function undo(): void {
  if (state.game.moves.length === 0) return;
  generation++;
  thinking = false;
  // Against the computer, undo goes back to the last position where the player was to move.
  const { first } = state.game;
  let moves = state.game.moves.slice(0, -1);
  while (state.opponent !== 'friend' && moves.length > 0 && replay(moves, first).turn !== state.human) moves = moves.slice(0, -1);
  state.game = replay(moves, first);
  save();
  render();
  maybeComputer();
}

function selectCube(cube: number): void {
  state.cube = (cube + SIZE) % SIZE;
  aimed = undefined;
  save();
  render();
}

// ---- Events ----

mapEl.addEventListener('click', (event) => {
  const mini = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.tess-mini') : null;
  if (mini !== null) selectCube(Number(mini.dataset.cube));
});

boardEl.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.cell') : null;
  if (button !== null) move(globalCell(button));
});

const aimAt = (event: Event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.cell') : null;
  const cell = button === null ? undefined : globalCell(button);
  if (cell === aimed) return;
  aimed = cell;
  render();
};
boardEl.addEventListener('pointerover', aimAt);
boardEl.addEventListener('focusin', aimAt);
boardEl.addEventListener('pointerleave', () => {
  aimed = undefined;
  render();
});

opponentEl.addEventListener('click', (event) => {
  const value = event.target instanceof HTMLButtonElement ? event.target.dataset.opponent : undefined;
  const opponent = OPPONENTS.find((option) => option === value);
  if (opponent === undefined || opponent === state.opponent) return;
  state.opponent = opponent;
  restart();
});

sideEl.addEventListener('click', (event) => {
  const value = event.target instanceof HTMLButtonElement ? event.target.dataset.side : undefined;
  if ((value !== 'X' && value !== 'O') || value === state.human) return;
  state.human = value;
  restart();
});

threatsBox.addEventListener('change', () => {
  state.showThreats = threatsBox.checked;
  save();
  render();
});

typeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const coords = parseCoordinates(typeInput.value);
  if (coords === undefined) {
    coordsEl.textContent = 'Type four digits from 1 to 4: cube, layer, row, column.';
    return;
  }
  const cell = toCell(coords);
  if (coords.cube !== state.cube) selectCube(coords.cube);
  typeInput.value = '';
  move(cell);
});

viewEl.addEventListener('click', (event) => {
  const value = event.target instanceof HTMLButtonElement ? event.target.dataset.view : undefined;
  if ((value !== 'slices' && value !== '4d') || value === state.view) return;
  state.view = value;
  aimed = undefined;
  save();
  render();
  view4d.setActive(value === '4d');
});

spinButton.addEventListener('click', () => {
  spinning = !spinning;
  view4d.setSpinning(spinning);
  render();
});

turnInput.addEventListener('input', () => {
  spinning = false;
  view4d.setSpinning(false);
  camera = { ...camera, turn4: (Number(turnInput.value) * Math.PI) / 180 };
  view4d.setCamera(camera);
  render();
});

resetViewButton.addEventListener('click', () => {
  camera = { ...DEFAULT_CAMERA, turn4: camera.turn4 };
  view4d.setCamera(camera);
});

undoButton.addEventListener('click', undo);
newGameButton.addEventListener('click', restart);

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key >= '1' && event.key <= String(SIZE)) selectCube(Number(event.key) - 1);
  else if (event.key === '[') selectCube(state.cube - 1);
  else if (event.key === ']') selectCube(state.cube + 1);
  else if (event.key === 'u' || event.key === 'U') undo();
  else return;
  event.preventDefault();
});

render();
view4d.setActive(state.view === '4d');
maybeComputer();
