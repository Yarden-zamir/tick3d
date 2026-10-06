// The ear training page (/sound-training): hear a cell and name its layer, row and column.
// src/sound-training/schedule.ts picks the cards and deck.ts draws the board. This file joins them and plays the sounds.
import '../style.css';
import './training.css';
import { toCell, toCoords } from '../game.ts';
import { setSoundSet, sounds } from '../sound.ts';
import { SOUND_SETS, type SoundSetId } from '../sound-sets.ts';
import { settings } from '../page/settings.ts';
import { setupSoundSets } from '../page/sound-set.ts';
import { element } from '../element.ts';
import { setupPageHeader } from '../header/header.ts';
import { buildDeck, fitDeck, paint } from './deck.ts';
import {
  type Asked,
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
  areaOf,
  freshProgress,
  nextCard,
  parseProgress,
  seeLearn,
  splitItem,
  weakest,
} from './schedule.ts';

setupPageHeader();

const kindEl = element('#card-kind', HTMLParagraphElement);
const titleEl = element('#card-title', HTMLHeadingElement);
const playButton = element('#play', HTMLButtonElement);
const answerEl = element('#card-answer', HTMLParagraphElement);
const cardEl = element('#card', HTMLElement);
const deckEl = element('#deck', HTMLDivElement);
const dotsEl = element('#deck-dots', HTMLDivElement);
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
const setList = element('#sound-set-list', HTMLDivElement);
const setName = element('#sound-set-name', HTMLSpanElement);

// The words of a sound set for each part of a cell. Classic does not name every cell, so the trainer uses Cells then.
// `part` is the set's own word for what the coordinate changes, for example "pitch" or "vowel".
function trainingOf(chosen: SoundSetId) {
  const id = chosen === 'classic' ? 'cells' : chosen;
  const parts = SOUND_SETS[id].parts;
  if (parts === undefined) throw new Error(`the ${id} sound set does not name its parts`);
  const names: Record<Dimension, readonly string[]> = { layer: parts.layer.names, row: parts.row.names, column: parts.column.names };
  const text: Record<Dimension, { name: string; part: string; parts: string }> = {
    layer: { name: 'Layer', part: parts.layer.hint, parts: 'Layer sounds' },
    row: { name: 'Row', part: parts.row.hint, parts: 'Row sounds' },
    column: { name: 'Column', part: parts.column.hint, parts: 'Column sounds' },
  };
  return { chosen, id, names, text };
}

// The menu (setupSoundSets at the end of this file) changes it.
let training = trainingOf(settings.soundSet);

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
// The cell that the player tapped. The pick is the area of that cell (areaOf).
let tapped: number | undefined;
let hovered: number | undefined;

// What a tap selects on this card. A learn card shows its answer as the area of its item.
const askedOf = (shown: Card): Asked => (shown.kind === 'full' ? 'cell' : splitItem(shown.item).dimension);
const asked = (shown: Card): readonly Dimension[] => (shown.kind === 'full' ? DIMENSIONS : shown.kind === 'quiz' ? [splitItem(shown.item).dimension] : []);
const withValue = (cell: number, dimension: Dimension, value: Value): number => toCell({ ...toCoords(cell), [dimension]: value });

// The cell that the pick stands for: the played cell with the asked parts from the tap.
function guessedCell(pick: number): number {
  const guess = toCoords(pick);
  const coords = toCoords(card.cell);
  for (const dimension of asked(card)) coords[dimension] = guess[dimension];
  return toCell(coords);
}

// ---- Sound ----

let timers: number[] = [];

// Plays the cells one after the other. A new call stops the rest of an earlier one.
function playCells(cells: readonly number[]): void {
  for (const timer of timers) clearTimeout(timer);
  timers = cells.map((cell, index) => window.setTimeout(() => sounds.place('X', cell), index * 750));
}

// ---- Card ----

const deck = buildDeck(deckEl, dotsEl);
// A short landscape screen puts the deck beside the other card parts. Keep in step with training.css.
const sideLayout = matchMedia('(orientation: landscape) and (max-height: 32rem)');

function describe(cell: number, strong: Dimension | undefined): HTMLElement[] {
  const coords = toCoords(cell);
  return DIMENSIONS.flatMap((dimension, index) => {
    const part = document.createElement(dimension === strong ? 'strong' : 'span');
    part.textContent = `${training.names[dimension][coords[dimension]]} = ${training.text[dimension].name.toLowerCase()} ${coords[dimension] + 1}`;
    if (index === 0) return [part];
    const separator = document.createElement('span');
    separator.textContent = ' · ';
    return [separator, part];
  });
}

const none: ReadonlySet<number> = new Set();

function repaint(): void {
  const area = (cell: number | undefined) => (cell === undefined ? none : new Set(areaOf(askedOf(card), cell)));
  const answer = area(card.cell);
  const picked = area(tapped);
  if (card.kind === 'learn') {
    paint(deck, { peer: none, picked: none, right: answer, wrong: none, last: new Set([card.cell]), tapped: none });
  } else if (checked) {
    const wrong = new Set([...picked].filter((cell) => !answer.has(cell)));
    // The exact tap stays in view, also inside a right area: the player sees where they were off.
    const exact = tapped === undefined || tapped === card.cell ? none : new Set([tapped]);
    paint(deck, { peer: none, picked: none, right: answer, wrong, last: new Set([card.cell]), tapped: exact });
  } else {
    paint(deck, { peer: area(hovered), picked, right: none, wrong: none, last: none, tapped: none });
  }
}

function fit(): void {
  fitDeck(deckEl, cardEl, sideLayout.matches);
}

// On a scroll deck, show the layer of the answer when only one layer holds it.
function showAnswerLayer(): void {
  if (deckEl.dataset.mode !== 'scroll' || askedOf(card) === 'row' || askedOf(card) === 'column') return;
  deck.layers[toCoords(card.cell).layer]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
}

function renderCard(): void {
  checked = false;
  tapped = undefined;
  hovered = undefined;
  feedbackEl.textContent = '';
  feedbackEl.classList.remove('all-right');
  yoursButton.hidden = true;
  deckEl.dataset.asked = card.kind === 'learn' ? 'learn' : askedOf(card);
  if (card.kind === 'learn') {
    const { dimension, value } = splitItem(card.item);
    const views = progress.items[card.item]?.learn;
    kindEl.textContent = views === undefined ? 'New sound' : 'Learn it again';
    titleEl.textContent = `${training.text[dimension].name} ${value + 1} is ${training.names[dimension][value]}`;
    answerEl.replaceChildren(...describe(card.cell, dimension));
  } else {
    kindEl.textContent = card.kind === 'full' ? 'Full cell' : 'Quiz';
    if (card.kind === 'full') titleEl.textContent = 'Which cell? Tap it.';
    else {
      const { name, part } = training.text[splitItem(card.item).dimension];
      titleEl.textContent = `Which ${name.toLowerCase()}? (${part}) Tap any cell in it.`;
    }
    answerEl.replaceChildren();
  }
  answerEl.hidden = card.kind !== 'learn';
  checkButton.hidden = card.kind === 'learn';
  checkButton.disabled = true;
  nextButton.hidden = card.kind !== 'learn';
  deckEl.scrollLeft = 0;
  repaint();
  fit();
  if (card.kind === 'learn') showAnswerLayer();
}

function describeArea(cell: number): string {
  const kind = askedOf(card);
  const coords = toCoords(cell);
  if (kind === 'cell') return `layer ${coords.layer + 1}, row ${coords.row + 1}, column ${coords.column + 1}`;
  return `${training.text[kind].name.toLowerCase()} ${coords[kind] + 1} (${training.names[kind][coords[kind]]})`;
}

function tap(cell: number): void {
  // A learn card or a checked card has its answer in view: a tap plays the cell instead.
  if (card.kind === 'learn' || checked) {
    playCells([cell]);
    return;
  }
  tapped = cell;
  checkButton.disabled = false;
  feedbackEl.textContent = `Your pick: ${describeArea(cell)}.`;
  repaint();
}

function check(): void {
  if (checked || card.kind === 'learn' || tapped === undefined) return;
  const actual = toCoords(card.cell);
  const guess = toCoords(guessedCell(tapped));
  const dimensions = asked(card);
  const right = (dimension: Dimension) => guess[dimension] === actual[dimension];
  progress = card.kind === 'quiz' ? answerItem(progress, card.item, right(splitItem(card.item).dimension)) : answerFull(progress, card.cell, guess);
  save();
  checked = true;
  const lines = dimensions.map((dimension) => {
    const name = training.text[dimension].name;
    const truth = `${actual[dimension] + 1}, ${training.names[dimension][actual[dimension]]}`;
    return right(dimension) ? `${name}: right (${truth}).` : `${name}: wrong. You picked ${guess[dimension] + 1}, ${training.names[dimension][guess[dimension]]}. It is ${truth}.`;
  });
  feedbackEl.textContent = lines.join(' ');
  feedbackEl.classList.toggle('all-right', dimensions.every(right));
  yoursButton.hidden = dimensions.every(right);
  checkButton.hidden = true;
  nextButton.hidden = false;
  nextButton.focus({ preventScroll: true });
  repaint();
  showAnswerLayer();
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
  playButton.focus({ preventScroll: true });
}

// ---- Progress ----

function dimensionBlock(dimension: Dimension): HTMLElement {
  const block = document.createElement('section');
  block.className = 'train-dimension';
  const title = document.createElement('h3');
  title.textContent = `${training.text[dimension].parts}: ${training.text[dimension].part}`;
  const share = accuracy(progress, dimension);
  const answers = progress.recent[dimension].length;
  const bar = document.createElement('div');
  bar.className = 'train-bar';
  bar.setAttribute('role', 'meter');
  bar.setAttribute('aria-label', `${training.text[dimension].parts}: right answers`);
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
    button.setAttribute('aria-label', `Play ${training.text[dimension].name.toLowerCase()} ${option + 1}, ${training.names[dimension][option]}: ${level}`);
    const label = document.createElement('b');
    label.textContent = `${option + 1} ${training.names[dimension][option]}`;
    const meter = document.createElement('small');
    meter.textContent = box === 'new' ? 'new' : box === 'learn' ? 'learn' : `${'●'.repeat(Number(box))}${'○'.repeat(BOX_COUNT - Number(box))}${due ? '\ndue' : ''}`;
    button.append(label, meter);
    button.addEventListener('click', () => playCells([withValue(card.cell, dimension, option)]));
    examples.append(button);
  }
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'train-all';
  all.textContent = `Hear all four ${training.text[dimension].parts.toLowerCase()}`;
  all.addEventListener('click', () => playCells(VALUES.map((option) => withValue(card.cell, dimension, option))));
  block.append(title, bar, value, examples, all);
  return block;
}

function renderProgress(): void {
  dimensionsEl.replaceChildren(...DIMENSIONS.map(dimensionBlock));
  const weak = weakest(progress);
  const weakShare = weak === undefined ? undefined : accuracy(progress, weak);
  if (weak === undefined || weakShare === undefined) hintEl.textContent = 'Answer a few quiz cards, and this shows what you hear well.';
  else if (weakShare < 0.8) hintEl.textContent = `${training.text[weak].parts} need practice: compare them below. They come more often now.`;
  else hintEl.textContent = 'You hear all three parts well. Full cells come more often now.';
  const seen = ITEMS.filter((item) => progress.items[item] !== undefined).length;
  const inQuiz = ITEMS.filter((item) => progress.items[item]?.learn === 0).length;
  totalsEl.textContent = `${progress.turn} cards done · ${seen} of ${ITEMS.length} sounds seen · ${inQuiz} in the quiz · ${SOUND_SETS[training.id].name} sound set${training.chosen === 'classic' ? ': Classic does not name cells, so the trainer uses Cells' : ''}`;
}

// ---- Events ----

playButton.addEventListener('click', () => playCells([card.cell]));
checkButton.addEventListener('click', check);
nextButton.addEventListener('click', next);
yoursButton.addEventListener('click', () => {
  if (tapped !== undefined) playCells([guessedCell(tapped)]);
});
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

deck.cells.forEach((button, cell) => {
  button.addEventListener('click', () => tap(cell));
  // The pointer or the focus shows the area that a tap selects.
  const preview = (target: number | undefined) => {
    hovered = target;
    if (card.kind !== 'learn' && !checked) repaint();
  };
  button.addEventListener('pointerenter', () => preview(cell));
  button.addEventListener('focus', () => preview(cell));
  button.addEventListener('pointerleave', () => preview(undefined));
  button.addEventListener('blur', () => preview(undefined));
  button.addEventListener('keydown', (event) => {
    // Enter on a cell of the pick checks it. Any other Enter or Space on a cell picks it (the button's own click).
    if (event.key === 'Enter' && !checked && tapped !== undefined && areaOf(askedOf(card), tapped).includes(cell)) {
      event.preventDefault();
      check();
    }
  });
});

// Space plays and Enter checks or goes on, while the focus is on Play, Check, Next or nothing.
// On the board and on other buttons the keys keep their usual action.
document.addEventListener('keydown', (event) => {
  if (resetDialog.open || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  const onCard = target === null || target === document.body || target === playButton;
  if (event.key === ' ' && (onCard || target === checkButton || target === nextButton)) {
    event.preventDefault();
    playCells([card.cell]);
  } else if (event.key === 'Enter' && onCard) {
    event.preventDefault();
    if (card.kind !== 'learn' && !checked) check();
    else next();
  }
});

// Resize covers a turn of the phone too.
addEventListener('resize', fit);
sideLayout.addEventListener('change', fit);

// The first call draws the first card. Progress is the same for all sets.
setupSoundSets(setList, (id) => {
  training = trainingOf(id);
  setSoundSet(training.id);
  setName.textContent = SOUND_SETS[id].name;
  // A checked card keeps its feedback until Next. A new render of it would allow a second check.
  if (!checked) renderCard();
  renderProgress();
});
// The web font changes the height of the text above the deck, so fit again once it is in.
void document.fonts.ready.then(fit);
