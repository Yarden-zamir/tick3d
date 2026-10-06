// The Voice room (/sound-input): the pitch from the microphone lights a cell of the board, live. It holds the
// calibration and the stickiness settings, free play, and the practice modes (practice-room.ts): targets,
// echo and the playoff. The voice engine (src/voice/engine.ts) does the listening. The board is the board of
// the game (src/board/), with the view and the layout that the game stores.
import '../style.css';
import '../sound-training/training.css';
import './input.css';
import './practice.css';
import { element } from '../element.ts';
import { toCoords } from '../game.ts';
import { setupPageHeader } from '../header/header.ts';
import { applyCamera, boardClass, buildBoard, showMark } from '../board/board.ts';
import { setupSpinDrag } from '../board/spin-drag.ts';
import { onSegmented, showSegmented } from '../board/view-controls.ts';
import { DEFAULTS, oneOf, saveSettings, settings as gameSettings } from '../page/settings.ts';
import { LAYOUTS, VIEWS, normalizeCode } from '../protocol.ts';
import { SOUND_SETS, type SoundSetId } from '../sound-sets.ts';
import { setSoundSet, sounds } from '../sound.ts';
import { isSmallRange, median, rangeFrom, type Retry } from '../voice/calibration.ts';
import { type VoiceFrame, createVoice } from '../voice/engine.ts';
import { noteName } from '../voice/mapping.ts';
import { buildRail, showRailPitch, showRailRange } from '../voice/rail.ts';
import { type Tab, createPracticeRoom } from './practice-room.ts';

setupPageHeader();
// A tap on a cell, and the echo rounds, play the sound set of the game. Classic does not name cells, so the
// room uses Cells then, as the ear training does.
const soundSet: SoundSetId = SOUND_SETS[gameSettings.soundSet].parts === undefined ? 'cells' : gameSettings.soundSet;
setSoundSet(soundSet);

const tabButtons = [...element('#tabs', HTMLDivElement).querySelectorAll<HTMLButtonElement>('button[data-tab]')];
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
const stageEl = element('#stage', HTMLDivElement);
const boardEl = element('#board', HTMLDivElement);
const viewControls = element('#view-controls', HTMLDivElement);
const resetAngleButton = element('#reset-angle', HTMLButtonElement);
const stickinessInput = element('#stickiness', HTMLInputElement);
const stickinessValue = element('#stickiness-value', HTMLOutputElement);
const buildUpInput = element('#build-up', HTMLInputElement);
const buildUpValue = element('#build-up-value', HTMLOutputElement);
const holdBox = element('#hold', HTMLInputElement);
const clearButton = element('#clear', HTMLButtonElement);

// A note on one cell for this long places an X there (free play).
const HOLD_MS = 1000;
// Each calibration step needs this much time with a clear pitch.
const STEP_MS = 2000;
// The page scrolls to the layer of the voice once its cell holds this long, so a passing slide does not
// make the page jump between layers.
const SCROLL_AFTER_MS = 300;

// One calibration in progress. `heard` holds the pitches of the step now, and `lows` the pitches of the
// low step once it is done.
type Calibration = { step: 'low' | 'high'; heard: number[]; lows: number[]; time: number };

const voice = createVoice();
let calibration: Calibration | undefined;
let tab: Tab = 'free';
let lit: number | undefined;
let holdDone = false;
// The layer that the page scrolled to last.
let shownLayer: number | undefined;

const board = buildBoard(boardEl);
const rail = buildRail(railEl);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// The view and the layout of the game (src/page/settings.ts): the game and this room share them.
function showBoard(): void {
  boardEl.className = `${boardClass(gameSettings.view, gameSettings.layout)} voice-board`;
  applyCamera(board, gameSettings.view, gameSettings.spin);
  showSegmented(viewControls, gameSettings, false);
  resetAngleButton.disabled = gameSettings.spin === DEFAULTS.spin;
}

// Scrolls the layer into view when part of it is out of view: out of the window, or out of a board that
// scrolls sideways.
function showLayer(layer: number): void {
  const layerEl = board.layers[layer];
  if (layerEl === undefined) throw new RangeError(`no layer ${layer}`);
  const rect = layerEl.getBoundingClientRect();
  const box = boardEl.getBoundingClientRect();
  const inView = rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= Math.max(0, box.left) && rect.right <= Math.min(innerWidth, box.right);
  if (!inView) layerEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion.matches ? 'instant' : 'smooth' });
}

const show = (message: string): void => {
  messageEl.textContent = message;
};

// Opens the microphone from a tap. Returns false when it does not open.
async function startMic(): Promise<boolean> {
  if (voice.isListening()) return true;
  micButton.disabled = true;
  show('Waiting for the microphone…');
  const problem = await voice.start();
  micButton.disabled = false;
  if (problem !== null) {
    show(problem);
    return false;
  }
  micButton.textContent = 'Stop';
  micButton.setAttribute('aria-pressed', 'true');
  readoutEl.dataset.state = 'listening';
  show(tab === 'free' ? 'Listening. Whistle, hum or sing a steady note.' : '');
  return true;
}

function stopMic(message: string): void {
  voice.stop();
  shownLayer = undefined;
  endCalibration();
  practice.stopped(message);
  showRailPitch(rail, null, null, 0);
  light(undefined, 0);
  showLevel(0);
  micButton.textContent = 'Turn on the microphone';
  micButton.setAttribute('aria-pressed', 'false');
  readoutEl.dataset.state = 'off';
  show(message);
}

const practice = createPracticeRoom({ voice, board, rail, startMic, show });

// ---- Display ----

function showRange(): void {
  const settings = voice.settings();
  const { low, high } = voice.range();
  modeEl.textContent = `${settings.range === null ? 'Default range' : 'Calibrated'}: ${Math.round(low)}–${Math.round(high)} Hz`;
  resetButton.hidden = settings.range === null;
  hintEl.hidden = settings.range === null || !isSmallRange(settings.range);
  showRailRange(rail, voice.range());
  practice.settingsChanged();
}

function showStickiness(): void {
  const { share, buildUpMs } = voice.settings().stickiness;
  stickinessInput.value = String(Math.round(share * 100));
  buildUpInput.value = String(buildUpMs / 1000);
  stickinessValue.textContent = share === 0 ? 'Off' : `${Math.round(share * 100)}% of a cell`;
  buildUpValue.textContent = `${(buildUpMs / 1000).toFixed(1)} s`;
}

function showLevel(share: number): void {
  levelEl.setAttribute('aria-valuenow', String(Math.round(share * 100)));
  levelEl.style.setProperty('--level', String(share));
}

function showProgress(share: number): void {
  progressEl.setAttribute('aria-valuenow', String(Math.round(share * 100)));
  progressEl.style.setProperty('--level', String(share));
}

// Lights `cell` and lets the light of the cell before fade (input.css). undefined puts the light out.
function light(cell: number | undefined, heldMs: number): void {
  if (cell !== undefined && heldMs >= SCROLL_AFTER_MS) {
    const { layer } = toCoords(cell);
    if (layer !== shownLayer) {
      shownLayer = layer;
      showLayer(layer);
    }
  }
  if (cell === lit) {
    if (cell !== undefined && tab === 'free' && holdBox.checked && calibration === undefined && !holdDone && heldMs >= HOLD_MS) {
      holdDone = true;
      showMark(board, cell, 'X');
    }
    return;
  }
  if (lit !== undefined) board.cells[lit]?.classList.remove('lit');
  lit = cell;
  holdDone = false;
  if (cell === undefined) return;
  board.cells[cell]?.classList.add('lit');
  const { layer, row, column } = toCoords(cell);
  cellEl.textContent = `Layer ${layer + 1}, row ${row + 1}, column ${column + 1}`;
}

// ---- Tabs ----

function setTab(next: Tab): void {
  if (practice.running()) return;
  tab = next;
  for (const button of tabButtons) button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
  document.body.dataset.tab = tab;
  practice.setTab(tab);
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
}

async function startCalibration(): Promise<void> {
  if (practice.running()) return;
  if (!(await startMic())) return;
  calibration = { step: 'low', heard: [], lows: [], time: 0 };
  calibrateButton.disabled = true;
  showStep('low');
}

function endCalibration(): void {
  calibration = undefined;
  calibrationEl.hidden = true;
  calibrateButton.disabled = false;
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
    return;
  }
  voice.saveSettings({ ...voice.settings(), range: result });
  calibrationEl.hidden = true;
  showRange();
  show(`Calibrated to your voice: ${noteName(result.low)} to ${noteName(result.high)}.`);
}

// ---- Frames ----

function onFrame(frame: VoiceFrame): void {
  showLevel(frame.level);
  if (frame.cell === null) {
    readoutEl.dataset.state = 'listening';
    showRailPitch(rail, null, null, 0);
    light(undefined, 0);
  } else if (frame.frequency !== null && frame.note !== null) {
    readoutEl.dataset.state = 'heard';
    frequencyEl.textContent = `${Math.round(frame.frequency)} Hz`;
    noteEl.textContent = frame.note;
    showRailPitch(rail, frame.position, frame.held, frame.margin);
    light(frame.cell, frame.heldMs);
  }
  if (calibration !== undefined && frame.raw !== null) calibrate(calibration, frame.raw, frame.elapsed);
  practice.frame(frame);
}

// ---- Events ----

voice.subscribe(onFrame);
voice.onStop((message) => stopMic(message));
for (const button of tabButtons) {
  button.addEventListener('click', () => {
    const next = button.dataset.tab;
    if (next === 'free' || next === 'targets' || next === 'echo' || next === 'playoff') setTab(next);
  });
}
micButton.addEventListener('click', () => {
  if (voice.isListening()) stopMic('');
  else void startMic();
});
calibrateButton.addEventListener('click', () => void startCalibration());
retryButton.addEventListener('click', () => void startCalibration());
cancelButton.addEventListener('click', endCalibration);
resetButton.addEventListener('click', () => {
  voice.saveSettings({ ...voice.settings(), range: null });
  showRange();
  show('Back to the default range.');
});
stickinessInput.addEventListener('input', () => {
  const settings = voice.settings();
  voice.saveSettings({ ...settings, stickiness: { ...settings.stickiness, share: Number(stickinessInput.value) / 100 } });
  showStickiness();
  practice.settingsChanged();
});
buildUpInput.addEventListener('input', () => {
  const settings = voice.settings();
  voice.saveSettings({ ...settings, stickiness: { ...settings.stickiness, buildUpMs: Math.round(Number(buildUpInput.value) * 1000) } });
  showStickiness();
});
clearButton.addEventListener('click', () => {
  for (let cell = 0; cell < board.cells.length; cell++) showMark(board, cell, null);
});
onSegmented(viewControls, (setting, value) => {
  if (setting === 'view') gameSettings.view = oneOf(VIEWS, value, gameSettings.view);
  else if (setting === 'layout') gameSettings.layout = oneOf(LAYOUTS, value, gameSettings.layout);
  else throw new Error(`unknown board setting ${setting}`);
  saveSettings();
  showBoard();
});
resetAngleButton.addEventListener('click', () => {
  gameSettings.spin = DEFAULTS.spin;
  saveSettings();
  showBoard();
});
setupSpinDrag(stageEl, {
  active: () => gameSettings.view === 'tower',
  spin: () => gameSettings.spin,
  turn: (spin) => {
    gameSettings.spin = spin;
    applyCamera(board, gameSettings.view, spin);
  },
  started: () => undefined,
  ended: () => {
    saveSettings();
    showBoard();
  },
});
board.cells.forEach((button, cell) =>
  button.addEventListener('click', () => {
    if (!practice.running()) sounds.place('X', cell);
  }),
);

// A hidden page keeps no microphone open.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && voice.isListening()) stopMic('The microphone stops when the page is out of view. Turn it on again to go on.');
});
addEventListener('pagehide', () => voice.stop());

showBoard();
showStickiness();
showRange();
// ?mode= opens a tab. ?code= is an online game: the playoff tab, for a playoff with the other player.
const params = new URLSearchParams(location.search);
const code = normalizeCode(params.get('code') ?? '');
const asked = params.get('mode');
if (code !== undefined) {
  setTab('playoff');
  practice.openSession(code);
} else if (asked === 'targets' || asked === 'echo') {
  setTab(asked);
} else {
  setTab('free');
}
