// The sound input page (/sound-input): the pitch from the microphone lights a cell of the board, live.
// pitch.ts finds the pitch, mapping.ts picks the cell, and the deck of the ear training draws the board.
import '../style.css';
import '../sound-training/training.css';
import './input.css';
import { toCoords } from '../game.ts';
import { SOUND_NAMES, sounds } from '../sound.ts';
import { buildDeck, fitDeck } from '../sound-training/deck.ts';
import { cellOf, noteName } from './mapping.ts';
import { bufferSize, detectPitch, rms } from './pitch.ts';

function element<T extends HTMLElement>(selector: string, type: new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`sound-input.html misses ${selector}`);
  return found;
}

const micButton = element('#mic', HTMLButtonElement);
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

type Listening = {
  stream: MediaStream;
  context: AudioContext;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  frame: number;
};

let listening: Listening | undefined;
let starting = false;
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

function show(message: string): void {
  messageEl.textContent = message;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  if (middle === undefined) throw new RangeError('no values for a median');
  return middle;
}

function describeCell(cell: number): string {
  const { layer, row, column } = toCoords(cell);
  return `Layer ${layer + 1} (${SOUND_NAMES.layer[layer as 0 | 1 | 2 | 3]}), row ${row + 1}, column ${column + 1}`;
}

// `level` is the RMS of the samples. The meter shows -60 dB to 0 dB below full scale.
function showLevel(level: number): void {
  const share = Math.max(0, Math.min(1, (20 * Math.log10(level) + 60) / 60));
  levelEl.setAttribute('aria-valuenow', String(Math.round(share * 100)));
  levelEl.style.setProperty('--level', String(share));
}

// Lights `cell` and lets the light of the cell before fade (input.css). undefined puts the light out.
function light(cell: number | undefined, now: number): void {
  if (cell === lit) {
    if (cell !== undefined && holdBox.checked && !holdDone && now - litSince >= HOLD_MS) {
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
  // On a phone the deck shows one layer at a time: follow the light to its layer.
  if (layer !== before && deckEl.dataset.mode === 'scroll') {
    deck.layers[layer]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
  }
}

function listen(now: number): void {
  if (listening === undefined) return;
  const { analyser, samples, context } = listening;
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
    light(cellOf(frequency), now);
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
  listening = { stream, context, analyser, samples: new Float32Array(analyser.fftSize), frame: requestAnimationFrame(listen) };
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
  recent = [];
  misses = 0;
  light(undefined, 0);
  showLevel(0);
  micButton.textContent = 'Turn on the microphone';
  micButton.setAttribute('aria-pressed', 'false');
  readoutEl.dataset.state = 'off';
  show(message);
}

micButton.addEventListener('click', () => {
  if (listening === undefined) void start();
  else stop();
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

// A short landscape screen puts the deck beside the other card parts, as in training.css.
const sideLayout = matchMedia('(orientation: landscape) and (max-height: 32rem)');
const fit = (): void => fitDeck(deckEl, cardEl, sideLayout.matches);
addEventListener('resize', fit);
sideLayout.addEventListener('change', fit);
fit();
// The web font changes the height of the text above the deck, so fit again once it is in.
void document.fonts.ready.then(fit);
