// The ear training page (/sound-training): hear a cell and name its layer, row and column.
// src/sound-training/schedule.ts picks the cards. This file only draws them and plays the sounds.
import '../style.css';
import './training.css';
import { type Coords, toCell, toCoords } from '../game.ts';
import { SOUND_NAMES, sounds } from '../sound.ts';
import {
  BOX_COUNT,
  type Card,
  DIMENSIONS,
  type Dimension,
  ITEMS,
  type ItemId,
  type Progress,
  VALUES,
  type Value,
  accuracy,
  answerFull,
  answerItem,
  freshProgress,
  nextCard,
  parseProgress,
  seeLearn,
  splitItem,
  weakest,
} from './schedule.ts';

function element<T extends HTMLElement>(selector: string, type: new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`sound-training.html misses ${selector}`);
  return found;
}

const kindEl = element('#card-kind', HTMLParagraphElement);
const titleEl = element('#card-title', HTMLHeadingElement);
const playButton = element('#play', HTMLButtonElement);
const answerEl = element('#card-answer', HTMLParagraphElement);
const groupsEl = element('#card-groups', HTMLDivElement);
const feedbackEl = element('#card-feedback', HTMLParagraphElement);
const checkButton = element('#check', HTMLButtonElement);
const yoursButton = element('#yours', HTMLButtonElement);
const nextButton = element('#next', HTMLButtonElement);
const hintEl = element('#hint', HTMLParagraphElement);
const dimensionsEl = element('#dimensions', HTMLDivElement);
const totalsEl = element('#totals', HTMLParagraphElement);
const resetButton = element('#reset', HTMLButtonElement);
const resetDialog = element('#reset-confirm', HTMLDialogElement);
const resetYes = element('#reset-yes', HTMLButtonElement);
const resetNo = element('#reset-no', HTMLButtonElement);

const TEXT: Record<Dimension, { name: string; part: string; parts: string }> = {
  layer: { name: 'Layer', part: 'pitch', parts: 'Pitches' },
  row: { name: 'Row', part: 'instrument', parts: 'Instruments' },
  column: { name: 'Column', part: 'width and side', parts: 'Widths' },
};

// ---- Storage ----

const STORAGE_KEY = 'tick3d.sound-training';

function load(): Progress {
  try {
    return parseProgress(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return freshProgress();
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Private mode or a full storage: the training still works for this visit.
  }
}

// ---- State ----

let progress = load();
let card: Card = nextCard(progress, Math.random);
let checked = false;
let picks: Partial<Record<Dimension, Value>> = {};

const asked = (shown: Card): readonly Dimension[] => (shown.kind === 'full' ? DIMENSIONS : shown.kind === 'quiz' ? [splitItem(shown.item).dimension] : []);
const withValue = (cell: number, dimension: Dimension, value: Value): number => toCell({ ...toCoords(cell), [dimension]: value });
const guessedCell = (): number => toCell({ ...toCoords(card.cell), ...picks });

// ---- Sound ----

let timers: number[] = [];

// Plays the cells one after the other. A new call stops the rest of an earlier one.
function playCells(cells: readonly number[]): void {
  for (const timer of timers) clearTimeout(timer);
  timers = cells.map((cell, index) => window.setTimeout(() => sounds.place('X', cell), index * 750));
}

// ---- Card ----

function describe(cell: number, strong: Dimension | undefined): HTMLElement[] {
  const coords = toCoords(cell);
  return DIMENSIONS.flatMap((dimension, index) => {
    const part = document.createElement(dimension === strong ? 'strong' : 'span');
    part.textContent = `${SOUND_NAMES[dimension][coords[dimension]]} = ${TEXT[dimension].name.toLowerCase()} ${coords[dimension] + 1}`;
    if (index === 0) return [part];
    const separator = document.createElement('span');
    separator.textContent = ' · ';
    return [separator, part];
  });
}

function pickGroup(dimension: Dimension): HTMLFieldSetElement {
  const group = document.createElement('fieldset');
  group.className = 'train-group';
  group.dataset.dimension = dimension;
  const legend = document.createElement('legend');
  legend.textContent = `${TEXT[dimension].name} (${TEXT[dimension].part})`;
  group.append(legend);
  for (const value of VALUES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'train-pick';
    button.dataset.value = String(value);
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', `${TEXT[dimension].name} ${value + 1}, ${SOUND_NAMES[dimension][value]}`);
    const number = document.createElement('b');
    number.textContent = String(value + 1);
    const name = document.createElement('small');
    name.textContent = SOUND_NAMES[dimension][value];
    button.append(number, name);
    button.addEventListener('click', () => pick(dimension, value));
    group.append(button);
  }
  return group;
}

function renderCard(): void {
  const dimensions = asked(card);
  checked = false;
  picks = {};
  feedbackEl.textContent = '';
  yoursButton.hidden = true;
  groupsEl.replaceChildren(...dimensions.map(pickGroup));
  if (card.kind === 'learn') {
    const { dimension, value } = splitItem(card.item);
    const views = progress.items[card.item]?.learn;
    kindEl.textContent = views === undefined ? 'New sound' : 'Learn it again';
    titleEl.textContent = `${TEXT[dimension].name} ${value + 1} is ${SOUND_NAMES[dimension][value]}`;
    answerEl.replaceChildren(...describe(card.cell, dimension));
  } else {
    kindEl.textContent = card.kind === 'full' ? 'Full cell' : 'Quiz';
    if (card.kind === 'full') titleEl.textContent = 'Which cell? (layer, row, column)';
    else {
      const { name, part } = TEXT[splitItem(card.item).dimension];
      titleEl.textContent = `Which ${name.toLowerCase()}? (${part})`;
    }
    answerEl.replaceChildren();
  }
  answerEl.hidden = card.kind !== 'learn';
  checkButton.hidden = card.kind === 'learn';
  checkButton.disabled = true;
  nextButton.hidden = card.kind !== 'learn';
}

function pick(dimension: Dimension, value: Value): void {
  if (checked) return;
  picks[dimension] = value;
  const group = groupsEl.querySelector(`[data-dimension="${dimension}"]`);
  for (const button of group?.querySelectorAll<HTMLButtonElement>('.train-pick') ?? []) {
    button.setAttribute('aria-pressed', String(button.dataset.value === String(value)));
  }
  checkButton.disabled = asked(card).some((asking) => picks[asking] === undefined);
}

function check(): void {
  if (checked || card.kind === 'learn' || checkButton.disabled) return;
  const actual = toCoords(card.cell);
  const dimensions = asked(card);
  const right = (dimension: Dimension) => picks[dimension] === actual[dimension];
  if (card.kind === 'quiz') {
    progress = answerItem(progress, card.item, right(splitItem(card.item).dimension));
  } else {
    // Each pick is set, because Check stays disabled until every group has one.
    progress = answerFull(progress, card.cell, { ...actual, ...picks } satisfies Coords);
  }
  save();
  checked = true;
  for (const dimension of dimensions) {
    const group = groupsEl.querySelector(`[data-dimension="${dimension}"]`);
    for (const button of group?.querySelectorAll<HTMLButtonElement>('.train-pick') ?? []) {
      const value = Number(button.dataset.value);
      button.classList.toggle('right', value === actual[dimension]);
      button.classList.toggle('wrong', value === picks[dimension] && !right(dimension));
    }
  }
  const lines = dimensions.map((dimension) => {
    const name = TEXT[dimension].name;
    const truth = `${actual[dimension] + 1}, ${SOUND_NAMES[dimension][actual[dimension]]}`;
    const guess = picks[dimension];
    return right(dimension) || guess === undefined ? `${name}: right (${truth}).` : `${name}: wrong. You picked ${guess + 1}, ${SOUND_NAMES[dimension][guess]}. It is ${truth}.`;
  });
  feedbackEl.textContent = lines.join(' ');
  feedbackEl.classList.toggle('all-right', dimensions.every(right));
  yoursButton.hidden = dimensions.every(right);
  checkButton.hidden = true;
  nextButton.hidden = false;
  nextButton.focus();
  // The right sound again, so the player hears it with the answer in view.
  sounds.place('X', card.cell);
  renderProgress();
}

function next(): void {
  if (card.kind === 'learn') {
    progress = seeLearn(progress, card.item);
    save();
  } else if (!checked) {
    return;
  }
  card = nextCard(progress, Math.random);
  renderCard();
  renderProgress();
  playButton.focus();
}

// ---- Progress ----

function dimensionBlock(dimension: Dimension): HTMLElement {
  const block = document.createElement('section');
  block.className = 'train-dimension';
  const title = document.createElement('h3');
  title.textContent = `${TEXT[dimension].parts} → ${TEXT[dimension].name.toLowerCase()}`;
  const share = accuracy(progress, dimension);
  const answers = progress.recent[dimension].length;
  const bar = document.createElement('div');
  bar.className = 'train-bar';
  bar.setAttribute('role', 'meter');
  bar.setAttribute('aria-label', `${TEXT[dimension].parts}: right answers`);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(Math.round((share ?? 0) * 100)));
  const fill = document.createElement('i');
  fill.style.width = `${(share ?? 0) * 100}%`;
  bar.append(fill);
  const value = document.createElement('p');
  value.className = 'train-bar-value';
  value.textContent = share === undefined ? 'No answers yet' : `${Math.round(share * 100)}% right in the last ${answers}`;

  const examples = document.createElement('div');
  examples.className = 'train-values';
  for (const option of VALUES) {
    const item: ItemId = `${dimension}-${option}`;
    const state = progress.items[item];
    const box = state === undefined ? 'new' : state.learn > 0 ? 'learn' : String(state.box + 1);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'train-value';
    button.dataset.item = item;
    button.dataset.box = box;
    // A quiz item that waits for its next card now.
    const due = state !== undefined && state.learn === 0 && state.due <= progress.turn;
    button.dataset.due = String(due);
    const level = box === 'new' ? 'new' : box === 'learn' ? 'in learn' : `box ${box} of ${BOX_COUNT}${due ? ', due now' : ''}`;
    button.setAttribute('aria-label', `Play ${TEXT[dimension].name.toLowerCase()} ${option + 1}, ${SOUND_NAMES[dimension][option]}: ${level}`);
    const label = document.createElement('b');
    label.textContent = `${option + 1} ${SOUND_NAMES[dimension][option]}`;
    const meter = document.createElement('small');
    meter.textContent = box === 'new' ? 'new' : box === 'learn' ? 'learn' : `${'●'.repeat(Number(box))}${'○'.repeat(BOX_COUNT - Number(box))}${due ? ' due' : ''}`;
    button.append(label, meter);
    button.addEventListener('click', () => playCells([withValue(card.cell, dimension, option)]));
    examples.append(button);
  }
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'train-all';
  all.textContent = `Hear all four ${TEXT[dimension].parts.toLowerCase()}`;
  all.addEventListener('click', () => playCells(VALUES.map((option) => withValue(card.cell, dimension, option))));
  block.append(title, bar, value, examples, all);
  return block;
}

function renderProgress(): void {
  dimensionsEl.replaceChildren(...DIMENSIONS.map(dimensionBlock));
  const weak = weakest(progress);
  const weakShare = weak === undefined ? undefined : accuracy(progress, weak);
  if (weak === undefined || weakShare === undefined) hintEl.textContent = 'Answer a few quiz cards, and this shows what you hear well.';
  else if (weakShare < 0.8) hintEl.textContent = `${TEXT[weak].parts} need practice: compare them below. They come more often now.`;
  else hintEl.textContent = 'You hear all three parts well. Full cells come more often now.';
  const seen = ITEMS.filter((item) => progress.items[item] !== undefined).length;
  const inQuiz = ITEMS.filter((item) => progress.items[item]?.learn === 0).length;
  totalsEl.textContent = `${progress.turn} cards done · ${seen} of ${ITEMS.length} sounds seen · ${inQuiz} in the quiz`;
}

// ---- Events ----

playButton.addEventListener('click', () => playCells([card.cell]));
checkButton.addEventListener('click', check);
nextButton.addEventListener('click', next);
yoursButton.addEventListener('click', () => playCells([guessedCell()]));
resetButton.addEventListener('click', () => resetDialog.showModal());
resetNo.addEventListener('click', () => resetDialog.close());
resetYes.addEventListener('click', () => {
  progress = freshProgress();
  save();
  resetDialog.close();
  card = nextCard(progress, Math.random);
  renderCard();
  renderProgress();
});

// Space plays and Enter checks or goes on, while the focus is on the card or on nothing.
// On any other button the keys keep their usual action.
document.addEventListener('keydown', (event) => {
  if (resetDialog.open || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  const onCard = target === null || target === document.body || target === playButton || target.closest('.train-group') !== null;
  // Space on Check or Next plays too. Enter on them keeps its usual click.
  const playsOnSpace = onCard || target === checkButton || target === nextButton;
  const digit = VALUES.find((value) => event.key === String(value + 1));
  if (digit !== undefined) {
    const focused = target?.closest<HTMLElement>('.train-group')?.dataset.dimension;
    const dimensions = asked(card);
    const dimension = dimensions.find((name) => name === focused) ?? dimensions.find((name) => picks[name] === undefined) ?? dimensions[0];
    if (dimension === undefined) return;
    event.preventDefault();
    pick(dimension, digit);
  } else if (event.key === ' ' && playsOnSpace) {
    event.preventDefault();
    playCells([card.cell]);
  } else if (event.key === 'Enter' && onCard) {
    event.preventDefault();
    if (card.kind !== 'learn' && !checked) check();
    else next();
  }
});

renderCard();
renderProgress();
