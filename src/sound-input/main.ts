// The sound input page (/sound-input): the pitch from the microphone lights a cell of the board, live.
// pitch.ts finds the pitch, mapping.ts places it in the range, sticky.ts holds a cell against a wobble,
// rail.ts draws the range, calibration.ts measures the player's own range, and stored.ts keeps the choices.
// The deck of the ear training draws the board.
import '../style.css';
import '../sound-training/training.css';
import './input.css';
import { element } from '../element.ts';
import { toCoords } from '../game.ts';
import { setupPageHeader } from '../header/header.ts';
import { settings } from '../page/settings.ts';
import { setSoundSet, sounds } from '../sound.ts';
import { buildDeck, fitDeck } from '../sound-training/deck.ts';
import { isSmallRange, median, rangeFrom, type Retry } from './calibration.ts';
import { DEFAULT_RANGE, type Range, cellOfStep, noteName, positionOf } from './mapping.ts';
import { bufferSize, detectPitch, rms } from './pitch.ts';
import { buildRail, showRailPitch, showRailRange } from './rail.ts';
import { STORAGE_KEY, type Stored, parseStored, toStorage } from './stored.ts';
import { type Held, holdStep, marginAt } from './sticky.ts';

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
const railEl = element('#rail', HTMLDivElement);
const cardEl = element('#card', HTMLElement);
const deckEl = element('#deck', HTMLDivElement);
const dotsEl = element('#deck-dots', HTMLDivElement);
const stickinessInput = element('#stickiness', HTMLInputElement);
const stickinessValue = element('#stickiness-value', HTMLOutputElement);
const buildUpInput = element('#build-up', HTMLInputElement);
const buildUpValue = element('#build-up-value', HTMLOutputElement);
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
// The deck mainly shows the light, so its cells can be smaller than tap targets. On a phone this keeps all
// four layers in view (2 × 2) while the player sings.
const DISPLAY_MIN_CELL = 20;

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
let stored: Stored = loadStored();
let recent: number[] = [];
let misses = 0;
let held: Held | null = null;
let lit: number | undefined;
let litSince = 0;
let holdDone = false;

const range = (): Range => stored.range ?? DEFAULT_RANGE;

const deck = buildDeck(deckEl, dotsEl);
// The X piece of the game, for the cells that a held note places.
for (const button of deck.cells) {
  const piece = document.createElement('span');
  piece.className = 'piece';
  button.append(piece);
}
const rail = buildRail(railEl);

// A short landscape screen puts the deck beside the other card parts, as in training.css. The deck
// fits again when a part above it shows or hides.
const sideLayout = matchMedia('(orientation: landscape) and (max-height: 32rem)');
const fit = (): void => fitDeck(deckEl, cardEl, sideLayout.matches, DISPLAY_MIN_CELL);

// ---- Storage ----

function loadStored(): Stored {
  try {
    return parseStored(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return parseStored(null);
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStorage(stored)));
  } catch {
    // Private mode or a full storage: the choices still work for this visit.
  }
}

// ---- Display ----

function show(message: string): void {
  messageEl.textContent = message;
}

function showRange(): void {
  const { low, high } = range();
  modeEl.textContent = `${stored.range === null ? 'Default range' : 'Calibrated'}: ${Math.round(low)}–${Math.round(high)} Hz`;
  resetButton.hidden = stored.range === null;
  hintEl.hidden = stored.range === null || !isSmallRange(stored.range);
  showRailRange(rail, range());
  held = null;
  fit();
}

function showStickiness(): void {
  const { share, buildUpMs } = stored.stickiness;
  stickinessInput.value = String(Math.round(share * 100));
  buildUpInput.value = String(buildUpMs / 1000);
  stickinessValue.textContent = share === 0 ? 'Off' : `${Math.round(share * 100)}% of a cell`;
  buildUpValue.textContent = `${(buildUpMs / 1000).toFixed(1)} s`;
}

function describeCell(cell: number): string {
  const { layer, row, column } = toCoords(cell);
  return `Layer ${layer + 1}, row ${row + 1}, column ${column + 1}`;
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
  if (lit !== undefined) deck.cells[lit]?.classList.remove('lit');
  lit = cell;
  litSince = now;
  holdDone = false;
  if (cell === undefined) return;
  deck.cells[cell]?.classList.add('lit');
  cellEl.textContent = describeCell(cell);
  const { layer } = toCoords(cell);
  deck.dots.forEach((dot, index) => dot.classList.toggle('right', index === layer));
}

// ---- Calibration ----

const STEP_TEXT = {
  low: 'Step 1 of 2: make your lowest comfortable sound, and hold it.',
  high: 'Step 2 of 2: now make your highest comfortable sound, and hold it.',
} as const;

const RETRY_TEXT: Record<Retry, string> = {
  silent: 'No clear sound came in. Try again, a little louder.',
  order: 'Your high sound was not above your low sound. Try again, with a bigger gap between the two.',
  narrow: 'Your two sounds were less than half an octave apart. Try again, with a bigger gap between the two.',
};

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
  if (typeof result === 'string') {
    calibrationEl.dataset.step = 'retry';
    stepEl.textContent = RETRY_TEXT[result];
    progressEl.hidden = true;
    retryButton.hidden = false;
    fit();
    return;
  }
  stored = { ...stored, range: result };
  save();
  calibrationEl.hidden = true;
  showRange();
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
      held = null;
      readoutEl.dataset.state = 'listening';
      showRailPitch(rail, null, null, 0);
      light(undefined, now);
    }
  } else {
    misses = 0;
    recent = [...recent, pitch.frequency].slice(-SMOOTH_FRAMES);
    const frequency = median(recent);
    const position = positionOf(frequency, range());
    held = holdStep(held, position, now, stored.stickiness);
    readoutEl.dataset.state = 'heard';
    frequencyEl.textContent = `${Math.round(frequency)} Hz`;
    noteEl.textContent = noteName(frequency);
    showRailPitch(rail, position, held, marginAt(now - held.since, stored.stickiness));
    light(cellOfStep(held.step), now);
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
  held = null;
  showRailPitch(rail, null, null, 0);
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
  stored = { ...stored, range: null };
  save();
  showRange();
  show('Back to the default range.');
});
stickinessInput.addEventListener('input', () => {
  stored = { ...stored, stickiness: { ...stored.stickiness, share: Number(stickinessInput.value) / 100 } };
  save();
  showStickiness();
});
buildUpInput.addEventListener('input', () => {
  stored = { ...stored, stickiness: { ...stored.stickiness, buildUpMs: Math.round(Number(buildUpInput.value) * 1000) } };
  save();
  showStickiness();
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
showStickiness();
showRange();
// The web font changes the height of the text above the deck, so fit again once it is in.
void document.fonts.ready.then(fit);
