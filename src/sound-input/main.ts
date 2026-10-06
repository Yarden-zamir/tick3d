// The sound input page (/sound-input): the pitch from the microphone lights a cell of the board, live.
// pitch.ts finds the pitch, mapping.ts picks the cell, calibration.ts holds the player's own range, and the
// deck of the ear training draws the board.
import '../style.css';
import '../sound-training/training.css';
import './input.css';
import { element } from '../element.ts';
import { toCoords } from '../game.ts';
import { setupPageHeader } from '../header/header.ts';
import { settings } from '../page/settings.ts';
import { setSoundSet, sounds } from '../sound.ts';
import { buildDeck, fitDeck } from '../sound-training/deck.ts';
import { type Range, STORAGE_KEY, isSmallRange, median, parseRange, rangeFrom, storedRange } from './calibration.ts';
import { LAYER_NAMES, cellOf, noteName } from './mapping.ts';
import { bufferSize, detectPitch, rms } from './pitch.ts';

setupPageHeader();
// A tap on a cell plays it in the sound set of the game. The game page and the trainer change the set.
setSoundSet(settings.soundSet);

const micButton = element('#mic', HTMLButtonElement);
const calibrateButton = element('#calibrate', HTMLButtonElement);
const modeEl = element('#range-mode', HTMLSpanElement);
const resetButton = element('#range-reset', HTMLButtonElement);
const hintEl = element('#range-hint', HTMLParagraphElement);
const calibrationEl = element('#calibration', HTMLDivElement);
const stepEl = element('#calibration-step', HTMLParagraphElement);
const progressEl = element('#calibration-progress', HTMLDivElement);
const heardEl = element('#calibration-heard', HTMLParagraphElement);
const retryButton = element('#calibration-retry', HTMLButtonElement);
const cancelButton = element('#calibration-cancel', HTMLButtonElement);
const readoutEl = element('#readout', HTMLDivElement);
const frequencyEl = element('#frequency', HTMLElement);
const noteEl = element('#note', HTMLSpanElement);
const cellEl = element('#cell', HTMLElement);
const levelEl = element('#level', HTMLDivElement);
const messageEl = element('#message', HTMLParagraphElement);
const cardEl = element('#card', HTMLElement);
const deckEl = element('#deck', HTMLDivElement);
const dotsEl = element('#deck-dots', HTMLDivElement);
const holdBox = element('#hold', HTMLInputElement);
const clearButton = element('#clear', HTMLButtonElement);

// The median of the last frames moves the light, so one odd frame (a click, an octave jump) does not.
const SMOOTH_FRAMES = 5;
// After this many frames without a clear pitch (about 0.1 s), the light goes out.
const MISS_FRAMES = 6;
// A note on one cell for this long places an X there.
const HOLD_MS = 1000;
// Each calibration step needs this much time with a clear pitch.
const STEP_MS = 2000;
// A longer gap between two frames (a slow device) counts as this much, so one gap does not end a step.
const MAX_FRAME_MS = 100;

type Listening = {
  stream: MediaStream;
  context: AudioContext;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  frame: number;
  last: number | undefined;
};

// One calibration in progress. `heard` holds the pitches of the step now, and `lows` the pitches of the
// low step once it is done.
type Calibration = { step: 'low' | 'high'; heard: number[]; lows: number[]; time: number };

let listening: Listening | undefined;
let starting = false;
let calibration: Calibration | undefined;
let range: Range | null = loadRange();
let recent: number[] = [];
let misses = 0;
let lit: number | undefined;
let litSince = 0;
let holdDone = false;

const deck = buildDeck(deckEl, dotsEl);
// The X piece of the game, for the cells that a held note places.
for (const button of deck.cells) {
  const piece = document.createElement('span');
  piece.className = 'piece';
  button.append(piece);
}

// A short landscape screen puts the deck beside the other card parts, as in training.css. The deck
// fits again when a part above it shows or hides.
const sideLayout = matchMedia('(orientation: landscape) and (max-height: 32rem)');
const fit = (): void => fitDeck(deckEl, cardEl, sideLayout.matches);

// ---- Storage ----

function loadRange(): Range | null {
  try {
    return parseRange(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

function saveRange(): void {
  try {
    if (range === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(storedRange(range)));
  } catch {
    // Private mode or a full storage: the range still works for this visit.
  }
}

// ---- Display ----

function show(message: string): void {
  messageEl.textContent = message;
}

function showRange(): void {
  modeEl.textContent = range === null ? 'Default bands' : `Calibrated: ${Math.round(range.low)}–${Math.round(range.high)} Hz`;
  resetButton.hidden = range === null;
  hintEl.hidden = range === null || !isSmallRange(range);
  fit();
}

function describeCell(cell: number): string {
  const { layer, row, column } = toCoords(cell);
  // The note name of a layer holds only in the default bands.
  const note = range === null ? ` (${LAYER_NAMES[layer as 0 | 1 | 2 | 3]})` : '';
  return `Layer ${layer + 1}${note}, row ${row + 1}, column ${column + 1}`;
}

// `level` is the RMS of the samples. The meter shows -60 dB to 0 dB below full scale.
function showLevel(level: number): void {
  const share = Math.max(0, Math.min(1, (20 * Math.log10(level) + 60) / 60));
  levelEl.setAttribute('aria-valuenow', String(Math.round(share * 100)));
  levelEl.style.setProperty('--level', String(share));
}

function showProgress(share: number): void {
  progressEl.setAttribute('aria-valuenow', String(Math.round(share * 100)));
  progressEl.style.setProperty('--level', String(share));
}

// Lights `cell` and lets the light of the cell before fade (input.css). undefined puts the light out.
function light(cell: number | undefined, now: number): void {
  if (cell === lit) {
    if (cell !== undefined && holdBox.checked && calibration === undefined && !holdDone && now - litSince >= HOLD_MS) {
      holdDone = true;
      deck.cells[cell]?.classList.add('x');
    }
    return;
  }
  const before = lit === undefined ? undefined : toCoords(lit).layer;
  if (lit !== undefined) deck.cells[lit]?.classList.remove('lit');
  lit = cell;
  litSince = now;
  holdDone = false;
  if (cell === undefined) return;
  deck.cells[cell]?.classList.add('lit');
  cellEl.textContent = describeCell(cell);
  const { layer } = toCoords(cell);
  deck.dots.forEach((dot, index) => dot.classList.toggle('right', index === layer));
  // On a phone the deck shows one layer at a time: follow the light to its layer. Only the deck scrolls
  // (scrollIntoView also scrolls the page), so the page stays still while the player whistles.
  const target = deck.layers[layer];
  if (layer !== before && deckEl.dataset.mode === 'scroll' && target !== undefined) {
    const left = deckEl.scrollLeft + target.getBoundingClientRect().left - deckEl.getBoundingClientRect().left;
    deckEl.scrollTo({ left, behavior: 'smooth' });
  }
}

// ---- Calibration ----

const STEP_TEXT = {
  low: 'Step 1 of 2: make your lowest comfortable sound, and hold it.',
  high: 'Step 2 of 2: now make your highest comfortable sound, and hold it.',
} as const;

function showStep(step: Calibration['step']): void {
  calibrationEl.hidden = false;
  calibrationEl.dataset.step = step;
  stepEl.textContent = STEP_TEXT[step];
  heardEl.textContent = 'Waiting for a clear sound…';
  progressEl.hidden = false;
  retryButton.hidden = true;
  showProgress(0);
  fit();
}

async function startCalibration(): Promise<void> {
  if (listening === undefined) await start();
  // The microphone did not start: start() shows why.
  if (listening === undefined) return;
  calibration = { step: 'low', heard: [], lows: [], time: 0 };
  calibrateButton.disabled = true;
  showStep('low');
}

function endCalibration(): void {
  calibration = undefined;
  calibrationEl.hidden = true;
  calibrateButton.disabled = false;
  fit();
}

// One clear frame of the calibration: `frequency` is its pitch, and `elapsed` the time since the frame before.
function calibrate(active: Calibration, frequency: number, elapsed: number): void {
  active.heard.push(frequency);
  active.time += elapsed;
  const typical = median(active.heard);
  heardEl.textContent = `${noteName(typical)} · ${Math.round(typical)} Hz`;
  showProgress(Math.min(1, active.time / STEP_MS));
  if (active.time < STEP_MS) return;
  if (active.step === 'low') {
    calibration = { step: 'high', heard: [], lows: active.heard, time: 0 };
    showStep('high');
    return;
  }
  const result = rangeFrom(active.lows, active.heard);
  calibration = undefined;
  calibrateButton.disabled = false;
  if (result === null) {
    calibrationEl.dataset.step = 'retry';
    stepEl.textContent = 'Your high sound was not above your low sound. Try again, with a bigger gap between the two.';
    progressEl.hidden = true;
    retryButton.hidden = false;
    fit();
    return;
  }
  range = result;
  saveRange();
  showRange();
  calibrationEl.hidden = true;
  fit();
  show(`Calibrated to your voice: ${noteName(result.low)} to ${noteName(result.high)}.`);
}

// ---- Microphone ----

function listen(now: number): void {
  if (listening === undefined) return;
  const { analyser, samples, context } = listening;
  const elapsed = listening.last === undefined ? 0 : Math.min(MAX_FRAME_MS, now - listening.last);
  listening.last = now;
  analyser.getFloatTimeDomainData(samples);
  showLevel(rms(samples));
  const pitch = detectPitch(samples, context.sampleRate);
  if (pitch === null) {
    misses++;
    if (misses >= MISS_FRAMES) {
      recent = [];
      readoutEl.dataset.state = 'listening';
      light(undefined, now);
    }
  } else {
    misses = 0;
    recent = [...recent, pitch.frequency].slice(-SMOOTH_FRAMES);
    const frequency = median(recent);
    readoutEl.dataset.state = 'heard';
    frequencyEl.textContent = `${Math.round(frequency)} Hz`;
    noteEl.textContent = noteName(frequency);
    light(cellOf(frequency, range), now);
    if (calibration !== undefined) calibrate(calibration, pitch.frequency, elapsed);
  }
  listening.frame = requestAnimationFrame(listen);
}

function micError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'The microphone is blocked. Allow it for this site in the browser settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone found. Connect one, then try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone does not start. Another app can hold it. Close that app, then try again.';
    default:
      return `The microphone does not start: ${error instanceof Error ? error.message : 'unknown error'}.`;
  }
}

async function start(): Promise<void> {
  if (listening !== undefined || starting) return;
  // Browsers give no microphone to a page without https.
  if (!('mediaDevices' in navigator) || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    show('This browser gives the page no microphone. Open the page over https in a current browser.');
    return;
  }
  // Make the context during the tap: some browsers start a context without a tap as suspended.
  const context = new AudioContext();
  starting = true;
  micButton.disabled = true;
  show('Waiting for the microphone…');
  let stream: MediaStream;
  try {
    // No processing: echo cancellation and noise suppression treat a steady whistle as noise.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (error) {
    void context.close();
    show(micError(error));
    return;
  } finally {
    starting = false;
    micButton.disabled = false;
  }
  // The page went out of view while the browser asked.
  if (document.hidden) {
    for (const track of stream.getTracks()) track.stop();
    void context.close();
    show('');
    return;
  }
  const analyser = context.createAnalyser();
  analyser.fftSize = bufferSize(context.sampleRate);
  context.createMediaStreamSource(stream).connect(analyser);
  for (const track of stream.getTracks()) track.addEventListener('ended', () => stop('The microphone stopped. Turn it on again to go on.'));
  listening = { stream, context, analyser, samples: new Float32Array(analyser.fftSize), frame: requestAnimationFrame(listen), last: undefined };
  micButton.textContent = 'Stop';
  micButton.setAttribute('aria-pressed', 'true');
  readoutEl.dataset.state = 'listening';
  show('Listening. Whistle, hum or sing a steady note.');
}

function stop(message = ''): void {
  if (listening === undefined) return;
  cancelAnimationFrame(listening.frame);
  for (const track of listening.stream.getTracks()) track.stop();
  void listening.context.close();
  listening = undefined;
  endCalibration();
  recent = [];
  misses = 0;
  light(undefined, 0);
  showLevel(0);
  micButton.textContent = 'Turn on the microphone';
  micButton.setAttribute('aria-pressed', 'false');
  readoutEl.dataset.state = 'off';
  show(message);
}

// ---- Events ----

micButton.addEventListener('click', () => {
  if (listening === undefined) void start();
  else stop();
});
calibrateButton.addEventListener('click', () => void startCalibration());
retryButton.addEventListener('click', () => void startCalibration());
cancelButton.addEventListener('click', endCalibration);
resetButton.addEventListener('click', () => {
  range = null;
  saveRange();
  showRange();
  show('Back to the default bands.');
});
clearButton.addEventListener('click', () => {
  for (const button of deck.cells) button.classList.remove('x');
});
deck.cells.forEach((button, cell) => button.addEventListener('click', () => sounds.place('X', cell)));

// A hidden page keeps no microphone open.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stop('The microphone stops when the page is out of view. Turn it on again to go on.');
});
addEventListener('pagehide', () => stop());

addEventListener('resize', fit);
sideLayout.addEventListener('change', fit);
showRange();
// The web font changes the height of the text above the deck, so fit again once it is in.
void document.fonts.ready.then(fit);
