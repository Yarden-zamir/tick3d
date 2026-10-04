import './style.css';
import { chooseMove, DIFFICULTIES, type Difficulty } from './ai';
import { CELL_COUNT, SIZE, type Game, type MoveError, type Player, newGame, play, toCell, toCoords, undo } from './game';
import { setMuted, sounds } from './sound';

const MODES = ['computer', 'friend'] as const;
const VIEWS = ['tower', 'flat'] as const;
const PLAYERS = ['X', 'O'] as const;
type Mode = (typeof MODES)[number];
type View = (typeof VIEWS)[number];

type Settings = { mode: Mode; difficulty: Difficulty; human: Player; view: View; muted: boolean };
const DEFAULTS: Settings = { mode: 'computer', difficulty: 'medium', human: 'X', view: 'tower', muted: false };
const STORAGE_KEY = 'tick3d.settings';
const COMPUTER_DELAY_MS = 450;

const ERROR_TEXT: Record<MoveError | 'wait', string> = {
  occupied: 'That cell is taken. Pick an empty cell.',
  'game-over': 'The game is over. Start a new game.',
  wait: 'Wait for the computer to move.',
};

function oneOf<T extends string>(options: readonly T[], value: unknown, fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}

// Stored settings come from an older visit or a hand edit, so check every field.
function loadSettings(): Settings {
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    raw = null;
  }
  const stored: Record<string, unknown> = typeof raw === 'object' && raw !== null ? { ...raw } : {};
  return {
    mode: oneOf(MODES, stored.mode, DEFAULTS.mode),
    difficulty: oneOf(DIFFICULTIES, stored.difficulty, DEFAULTS.difficulty),
    human: oneOf(PLAYERS, stored.human, DEFAULTS.human),
    view: oneOf(VIEWS, stored.view, DEFAULTS.view),
    muted: typeof stored.muted === 'boolean' ? stored.muted : DEFAULTS.muted,
  };
}

function saveSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage is blocked (private mode). Settings then last for this visit only.
  }
}

function element<T extends HTMLElement>(selector: string, type: new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`missing element ${selector}`);
  return found;
}

const boardEl = element('#board', HTMLDivElement);
const statusEl = element('#status', HTMLDivElement);
const scoreEl = element('#score', HTMLDivElement);
const toastEl = element('#toast', HTMLDivElement);
const burstEl = element('#burst', HTMLDivElement);
const newGameButton = element('#new-game', HTMLButtonElement);
const undoButton = element('#undo', HTMLButtonElement);
const soundButton = element('#sound', HTMLButtonElement);

let settings = loadSettings();
let game: Game = newGame();
let thinking = false;
// Increments on every new game, so a computer move scheduled for an old game is dropped.
let round = 0;
let score = { X: 0, O: 0, draw: 0 };
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const cells: HTMLButtonElement[] = [];
for (let layer = 0; layer < SIZE; layer++) {
  const layerEl = document.createElement('div');
  layerEl.className = 'layer';
  layerEl.innerHTML = `<span class="layer-label">Layer ${layer + 1}</span>`;
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (let row = 0; row < SIZE; row++) {
    for (let column = 0; column < SIZE; column++) {
      const cell = toCell({ layer, row, column });
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cell';
      button.innerHTML = '<span class="piece"></span>';
      button.addEventListener('click', () => humanMove(cell));
      button.addEventListener('pointerenter', () => highlightColumn(cell));
      button.addEventListener('focus', () => highlightColumn(cell));
      button.addEventListener('pointerleave', () => highlightColumn(undefined));
      cells[cell] = button;
      grid.append(button);
    }
  }
  layerEl.append(grid);
  boardEl.append(layerEl);
}
if (cells.length !== CELL_COUNT) throw new Error('board build is incomplete');

function cellButton(cell: number): HTMLButtonElement {
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

const isComputerTurn = () =>
  settings.mode === 'computer' && game.status.kind === 'playing' && game.turn !== settings.human;

function showToast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function reject(cell: number, reason: MoveError | 'wait'): void {
  sounds.invalid();
  showToast(ERROR_TEXT[reason]);
  const button = cellButton(cell);
  button.classList.remove('shake');
  void button.offsetWidth; // restart the animation
  button.classList.add('shake');
}

function humanMove(cell: number): void {
  if (thinking || isComputerTurn()) return reject(cell, 'wait');
  const result = play(game, cell);
  if (!result.ok) return reject(cell, result.error);
  commit(result.game, cell);
}

function commit(next: Game, cell: number): void {
  const mover = game.turn;
  game = next;
  sounds.place(mover, toCoords(cell).layer);
  if (game.status.kind === 'won') {
    score[game.status.winner]++;
    const humanLost = settings.mode === 'computer' && game.status.winner !== settings.human;
    if (humanLost) sounds.lose();
    else {
      sounds.win();
      celebrate();
    }
  } else if (game.status.kind === 'draw') {
    score.draw++;
    sounds.draw();
  }
  render();
  scheduleComputer();
}

function scheduleComputer(): void {
  if (!isComputerTurn()) return;
  thinking = true;
  render();
  const scheduledRound = round;
  setTimeout(() => {
    if (scheduledRound !== round) return;
    // The hard level searches on the main thread for up to 600 ms. CSS animations keep running,
    // but input waits. Move the search to a Web Worker if the budget grows past about one second.
    const cell = chooseMove(game.board, game.turn, settings.difficulty);
    thinking = false;
    const result = play(game, cell);
    if (!result.ok) throw new Error(`computer chose an illegal move: ${result.error} at cell ${cell}`);
    commit(result.game, cell);
  }, COMPUTER_DELAY_MS);
}

function startGame(): void {
  round++;
  thinking = false;
  game = newGame('X');
  burstEl.replaceChildren();
  render();
  scheduleComputer();
}

function undoMove(): void {
  if (thinking || game.moves.length === 0 || game.status.kind !== 'playing') return;
  // Against the computer, go back to the last position where it was the human's turn.
  const count = settings.mode === 'computer' ? 2 : 1;
  round++;
  game = undo(game, count);
  sounds.click();
  render();
  scheduleComputer();
}

function celebrate(): void {
  const colors = ['#ff6b8b', '#ffb36b', '#46d9ff', '#9b8cff', '#7dffb2'];
  burstEl.replaceChildren(
    ...Array.from({ length: 36 }, (_, i) => {
      const spark = document.createElement('span');
      const angle = (i / 36) * Math.PI * 2;
      const distance = 120 + Math.random() * 160;
      spark.style.setProperty('--x', `${Math.cos(angle) * distance}px`);
      spark.style.setProperty('--y', `${Math.sin(angle) * distance}px`);
      spark.style.setProperty('--c', colors[i % colors.length] ?? '#fff');
      spark.style.animationDelay = `${Math.random() * 120}ms`;
      return spark;
    }),
  );
}

function playerName(player: Player): string {
  if (settings.mode === 'friend') return `Player ${player}`;
  return player === settings.human ? 'You' : 'Computer';
}

function statusText(): string {
  switch (game.status.kind) {
    case 'won':
      if (settings.mode === 'friend') return `Player ${game.status.winner} wins!`;
      return game.status.winner === settings.human ? 'You win!' : 'The computer wins.';
    case 'draw':
      return 'Draw. The cube is full.';
    case 'playing':
      if (thinking) return 'Computer is thinking…';
      return settings.mode === 'friend' ? `Player ${game.turn} to move` : `Your move (${game.turn})`;
  }
}

function render(): void {
  document.body.dataset.turn = game.turn;
  document.body.dataset.mode = settings.mode;
  boardEl.className = `board ${settings.view}`;
  boardEl.classList.toggle('finished', game.status.kind !== 'playing');
  boardEl.classList.toggle('thinking', thinking);

  const winLine: readonly number[] = game.status.kind === 'won' ? game.status.line : [];
  const last = game.moves.at(-1);
  cells.forEach((button, cell) => {
    const mark = game.board[cell] ?? null;
    const { layer, row, column } = toCoords(cell);
    button.classList.toggle('x', mark === 'X');
    button.classList.toggle('o', mark === 'O');
    button.classList.toggle('win', winLine.includes(cell));
    button.classList.toggle('last', cell === last);
    button.setAttribute(
      'aria-label',
      `Layer ${layer + 1}, row ${row + 1}, column ${column + 1}: ${mark ?? 'empty'}`,
    );
  });

  statusEl.textContent = statusText();
  statusEl.dataset.state = game.status.kind;

  document.querySelectorAll<HTMLElement>('[data-computer-only]').forEach((field) => {
    field.hidden = settings.mode !== 'computer';
  });
  document.querySelectorAll<HTMLElement>('.segmented').forEach((group) => {
    const current = String(settings[group.dataset.setting as keyof Settings]);
    group.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.value === current));
    });
  });

  scoreEl.innerHTML = [
    ['X', playerName('X'), score.X],
    ['draw', 'Draws', score.draw],
    ['O', playerName('O'), score.O],
  ]
    .map(([key, label, value]) => `<div class="tally ${key}"><b>${value}</b><span>${label}</span></div>`)
    .join('');

  undoButton.disabled = thinking || game.moves.length === 0 || game.status.kind !== 'playing';
  soundButton.textContent = settings.muted ? '🔇' : '🔊';
  soundButton.setAttribute('aria-pressed', String(!settings.muted));
}

function changeSetting(setting: string, value: string | undefined): void {
  switch (setting) {
    case 'view':
      settings.view = oneOf(VIEWS, value, settings.view);
      break;
    case 'mode':
      settings.mode = oneOf(MODES, value, settings.mode);
      break;
    case 'difficulty':
      settings.difficulty = oneOf(DIFFICULTIES, value, settings.difficulty);
      break;
    case 'human':
      settings.human = oneOf(PLAYERS, value, settings.human);
      break;
    default:
      throw new Error(`unknown setting ${setting}`);
  }
  saveSettings();
  sounds.click();
  if (setting === 'view') return render();
  // A different match-up means a fresh score and a fresh game.
  score = { X: 0, O: 0, draw: 0 };
  startGame();
}

document.querySelectorAll<HTMLElement>('.segmented').forEach((group) => {
  const setting = group.dataset.setting;
  if (setting === undefined) throw new Error('segmented control without data-setting');
  group.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-pressed') === 'true') return;
      changeSetting(setting, button.dataset.value);
    });
  });
});

newGameButton.addEventListener('click', () => {
  sounds.click();
  startGame();
});
undoButton.addEventListener('click', undoMove);
soundButton.addEventListener('click', () => {
  settings.muted = !settings.muted;
  setMuted(settings.muted);
  saveSettings();
  sounds.click();
  render();
});

setMuted(settings.muted);
startGame();
