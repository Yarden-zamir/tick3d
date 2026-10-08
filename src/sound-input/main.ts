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
import { oneOf, saveSettings, settings as gameSettings } from '../page/settings.ts';
import { LAYOUTS, VIEWS, normalizeCode } from '../protocol.ts';
import { readReturn } from '../return-path.ts';
import { SOUND_SETS, type SoundSetId } from '../sound-sets.ts';
import { setSoundSet, sounds } from '../sound.ts';
import { isSmallRange, median, rangeFrom, type Retry, typedRange } from '../voice/calibration.ts';
import { type VoiceFrame, createVoice } from '../voice/engine.ts';
import { SPREADS, STEPS, type Spread, cellOfStep, frequencyAt, noteName } from '../voice/mapping.ts';
import { buildRail, showRailPitch, showRailRange } from '../voice/rail.ts';
import { MAX_TILT_STEPS } from '../voice/tilt.ts';
import { type HoldFill, createVoiceCells } from '../voice/visuals.ts';
import { HOLD_MS } from '../page/voice-gate.ts';
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
const stickinessInput = element('#stickiness', HTMLInputElement);
const stickinessValue = element('#stickiness-value', HTMLOutputElement);
const buildUpInput = element('#build-up', HTMLInputElement);
const buildUpValue = element('#build-up-value', HTMLOutputElement);
const holdBox = element('#hold', HTMLInputElement);
const rangeLow = element('#range-low', HTMLInputElement);
const rangeHigh = element('#range-high', HTMLInputElement);
const rangeLowNote = element('#range-low-note', HTMLOutputElement);
const rangeHighNote = element('#range-high-note', HTMLOutputElement);
const setLowButton = element('#set-low', HTMLButtonElement);
const setHighButton = element('#set-high', HTMLButtonElement);
const spreadGroup = element('#spread', HTMLDivElement);
const spreadNote = element('#spread-note', HTMLParagraphElement);
const SPREAD_NOTES: Record<Spread, string> = {
  log: 'The same musical interval for each cell.',
  linear: 'The same width in Hz for each cell: wide low cells, narrow high cells.',
  middle: 'More room for the cells in the middle of the range.',
  notes: 'Each layer sits on C, D, E or G, and each row spans one octave.',
};
const rangeNote = element('#range-note', HTMLParagraphElement);
const clearButton = element('#clear', HTMLButtonElement);
const tiltEditor = element('#tilt-editor', HTMLFieldSetElement);
const tiltOn = element('#tilt-on', HTMLInputElement);
const tiltSteps = element('#tilt-steps', HTMLInputElement);
const tiltStepsValue = element('#tilt-steps-value', HTMLOutputElement);
const tiltRecentre = element('#tilt-recentre', HTMLButtonElement);

// A note on one cell for HOLD_MS places an X there (free play), as in the game.
// Each calibration step needs this much time with a clear pitch.
const STEP_MS = 2000;
// The page scrolls to the layer of the voice once its cell holds this long, so a passing slide does not
// make the page jump between layers.
const SCROLL_AFTER_MS = 300;
// The board shows the frequency of each cell this long after a change of the range or the spread, for this long.
const PREVIEW_AFTER_MS = 1000;
const PREVIEW_MS = 4000;
// The fade of the preview in input.css.
const PREVIEW_FADE_MS = 600;

// One calibration in progress. `heard` holds the pitches of the step now, and `lows` the pitches of the
// low step once it is done.
type Calibration = { step: 'low' | 'high'; heard: number[]; lows: number[]; time: number };

const voice = createVoice();
let calibration: Calibration | undefined;
// The calibration box is open, with its own history entry, so the back button of the browser closes it.
let calibrationOpen = false;
// Where the close of the calibration goes: 'origin' is where the player came from (the page of the `return`
// parameter, else the tab), 'here' stays on the tab (for example when the microphone stops).
let closeTo: 'origin' | 'here' = 'origin';
// The page that a link to this room asked to return to after a calibration (src/return-path.ts).
const returnTo = readReturn(new URL(location.href));
let tab: Tab = 'free';
let lit: number | null = null;
let holdDone = false;
// The layer that the page scrolled to last.
let shownLayer: number | undefined;
// The last smoothed pitch, and its frame time, for Use my note.
let lastPitch: { frequency: number; at: number } | undefined;
let previewTimers: ReturnType<typeof setTimeout>[] = [];

const board = buildBoard(boardEl);
const rail = buildRail(railEl);
const voiceCells = createVoiceCells(board.cells);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

// The view and the layout of the game (src/page/settings.ts): the game and this room share them.
function showBoard(): void {
  boardEl.className = `${boardClass(gameSettings.view, gameSettings.layout)} voice-board`;
  applyCamera(board, gameSettings.view, gameSettings.spin);
  showSegmented(viewControls, gameSettings, false);
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
  show('Waiting for the mic…');
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
  closeCalibration('here');
  practice.stopped(message);
  showRailPitch(rail, null, null, 0, null);
  light(null);
  showLevel(0);
  micButton.textContent = 'Turn on the mic';
  micButton.setAttribute('aria-pressed', 'false');
  readoutEl.dataset.state = 'off';
  show(message);
}

const practice = createPracticeRoom({ voice, board, rail, cells: voiceCells, startMic, show });

// ---- Display ----

// Shows the frequency of each cell on the board for a moment, a second after a change.
function schedulePreview(): void {
  for (const timer of previewTimers) clearTimeout(timer);
  previewTimers = [setTimeout(showPreview, PREVIEW_AFTER_MS), setTimeout(endPreview, PREVIEW_AFTER_MS + PREVIEW_MS)];
}

function showPreview(): void {
  const map = voice.pitchMap();
  for (let step = 0; step < STEPS; step++) {
    const button = board.cells[cellOfStep(step)];
    if (button !== undefined) button.dataset.preview = String(Math.round(frequencyAt(step + 0.5, map)));
  }
  boardEl.classList.add('previewing');
}

function endPreview(): void {
  if (!boardEl.classList.contains('previewing')) return;
  boardEl.classList.remove('previewing');
  previewTimers.push(
    setTimeout(() => {
      for (const button of board.cells) delete button.dataset.preview;
    }, PREVIEW_FADE_MS),
  );
}

function showRange(): void {
  const settings = voice.settings();
  const { low, high } = voice.range();
  rangeLow.value = String(Math.round(low));
  rangeHigh.value = String(Math.round(high));
  rangeLowNote.textContent = noteName(low);
  rangeHighNote.textContent = noteName(high);
  for (const button of spreadGroup.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.value === settings.spread));
  spreadNote.textContent = SPREAD_NOTES[settings.spread];
  modeEl.textContent = `${settings.range === null ? 'Default range' : 'Your range'}: ${Math.round(low)}–${Math.round(high)} Hz`;
  resetButton.hidden = settings.range === null;
  hintEl.hidden = settings.range === null || !isSmallRange(settings.range);
  showRailRange(rail, voice.pitchMap());
  practice.settingsChanged();
}

// A new range from the inputs or a sung note. A range that does not work stays out, with a message.
function applyRange(low: number, high: number): void {
  const result = typedRange(low, high);
  if (typeof result === 'string') {
    rangeNote.textContent = result;
    showRange();
    return;
  }
  rangeNote.textContent = '';
  voice.saveSettings({ ...voice.settings(), range: result });
  showRange();
  schedulePreview();
}

// Use my note: the pitch that the player holds now (heard in the last half second).
function sungPitch(): number | undefined {
  if (lastPitch === undefined || performance.now() - lastPitch.at > 500) {
    rangeNote.textContent = voice.isListening() ? 'Hold the note, then tap Use my note.' : 'Turn on the mic, hold the note, then tap Use my note.';
    return undefined;
  }
  return lastPitch.frequency;
}

function showStickiness(): void {
  const { share, buildUpMs } = voice.settings().stickiness;
  stickinessInput.value = String(Math.round(share * 100));
  buildUpInput.value = String(buildUpMs / 1000);
  stickinessValue.textContent = share === 0 ? 'Off' : `${Math.round(share * 100)}% of a cell`;
  buildUpValue.textContent = `${(buildUpMs / 1000).toFixed(1)} s`;
}

function showTilt(): void {
  const { on, steps } = voice.settings().tilt;
  tiltOn.checked = on;
  tiltSteps.max = String(MAX_TILT_STEPS);
  tiltSteps.value = String(steps);
  tiltSteps.disabled = !on;
  tiltRecentre.hidden = !on;
  tiltStepsValue.textContent = `up to ${steps} ${steps === 1 ? 'cell' : 'cells'}`;
}

function showLevel(share: number): void {
  levelEl.setAttribute('aria-valuenow', String(Math.round(share * 100)));
  levelEl.style.setProperty('--level', String(share));
}

function showProgress(share: number): void {
  progressEl.setAttribute('aria-valuenow', String(Math.round(share * 100)));
  progressEl.style.setProperty('--level', String(share));
}

// Lights the cell of `frame` (visuals.ts), or puts the light out (null). In free play with the hold on, the
// hold fills the cell, and a full hold places an X. A practice run fills its own hold.
function light(frame: VoiceFrame | null): void {
  const cell = frame?.cell ?? null;
  const heldMs = frame?.heldMs ?? 0;
  if (cell !== null && heldMs >= SCROLL_AFTER_MS) {
    const { layer } = toCoords(cell);
    if (layer !== shownLayer) {
      shownLayer = layer;
      showLayer(layer);
    }
  }
  if (cell !== lit) {
    lit = cell;
    // A cell that has an X already places nothing.
    holdDone = cell !== null && board.cells[cell]?.classList.contains('x') === true;
    if (cell !== null) {
      const { layer, row, column } = toCoords(cell);
      cellEl.textContent = `Layer ${layer + 1}, row ${row + 1}, column ${column + 1}`;
    }
  }
  const freeHold = cell !== null && tab === 'free' && holdBox.checked && calibration === undefined && !holdDone;
  if (cell !== null && freeHold && heldMs >= HOLD_MS) {
    holdDone = true;
    showMark(board, cell, 'X');
    voiceCells.burst(cell);
  }
  let hold: HoldFill | null = null;
  if (frame !== null && practice.running()) hold = practice.holdFill(frame);
  else if (freeHold && !holdDone) hold = { share: heldMs / HOLD_MS, mark: 'X' };
  voiceCells.show(cell, hold);
}

// ---- Tabs ----

function setTab(next: Tab): void {
  if (practice.running() || calibrationOpen) return;
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
  // A retry stays in the history entry of the first try.
  if (!calibrationOpen) {
    history.pushState({ calibration: true }, '');
    calibrationOpen = true;
    document.body.dataset.calibrating = '';
  }
  calibration = { step: 'low', heard: [], lows: [], time: 0 };
  calibrateButton.disabled = true;
  showStep('low');
}

function hideCalibration(): void {
  calibration = undefined;
  calibrationEl.hidden = true;
  calibrateButton.disabled = false;
  delete document.body.dataset.calibrating;
}

// Closes the calibration through its history entry: the popstate listener then goes to `to`. A cancel
// changes no settings, and the entry does not stay as a trap for the back button.
function closeCalibration(to: 'origin' | 'here'): void {
  hideCalibration();
  if (!calibrationOpen) return;
  closeTo = to;
  history.back();
}

// Back to the page of the `return` parameter. When the page before this one in the history is that page,
// the room goes back to it, so no extra entry stays. Else the room replaces itself with it.
function leaveToReturn(target: string): void {
  if (document.referrer === target) history.back();
  else location.replace(target);
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
  showRange();
  schedulePreview();
  show(`Calibrated to your voice: ${noteName(result.low)} to ${noteName(result.high)}.`);
  closeCalibration('origin');
}

// ---- Frames ----

function onFrame(frame: VoiceFrame): void {
  showLevel(frame.level);
  if (frame.frequency !== null) {
    lastPitch = { frequency: frame.frequency, at: frame.now };
    // The preview steps aside when the player sings.
    endPreview();
  }
  if (voice.hasTilt()) tiltEditor.hidden = false;
  if (frame.cell === null) {
    readoutEl.dataset.state = 'listening';
    showRailPitch(rail, null, null, 0, null);
    light(null);
  } else if (frame.frequency !== null && frame.note !== null) {
    readoutEl.dataset.state = 'heard';
    frequencyEl.textContent = `${Math.round(frame.frequency)} Hz`;
    noteEl.textContent = frame.note;
    showRailPitch(rail, frame.position, frame.held, frame.margin, frame.tilt);
    light(frame);
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
cancelButton.addEventListener('click', () => closeCalibration('origin'));
// The back button of the browser, Cancel and a finished calibration all come here: the calibration entry is gone.
addEventListener('popstate', () => {
  if (!calibrationOpen) return;
  calibrationOpen = false;
  hideCalibration();
  const to = closeTo;
  closeTo = 'origin';
  if (to === 'origin' && returnTo !== undefined) leaveToReturn(returnTo);
});
resetButton.addEventListener('click', () => {
  voice.saveSettings({ ...voice.settings(), range: null });
  showRange();
  schedulePreview();
  show('Back to the default range.');
});
rangeLow.addEventListener('change', () => applyRange(Number(rangeLow.value), voice.range().high));
rangeHigh.addEventListener('change', () => applyRange(voice.range().low, Number(rangeHigh.value)));
setLowButton.addEventListener('click', () => {
  const frequency = sungPitch();
  if (frequency !== undefined) applyRange(frequency, voice.range().high);
});
setHighButton.addEventListener('click', () => {
  const frequency = sungPitch();
  if (frequency !== undefined) applyRange(voice.range().low, frequency);
});
for (const button of spreadGroup.querySelectorAll('button')) {
  button.addEventListener('click', () => {
    const spread = SPREADS.find((known) => known === button.dataset.value);
    if (spread === undefined) throw new Error(`unknown spread ${button.dataset.value}`);
    if (spread === voice.settings().spread) return;
    voice.saveSettings({ ...voice.settings(), spread });
    showRange();
    schedulePreview();
  });
}
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
tiltOn.addEventListener('change', () => {
  voice.saveSettings({ ...voice.settings(), tilt: { ...voice.settings().tilt, on: tiltOn.checked } });
  // The change is a tap: on iOS it asks for the sensor, and the angle now becomes neutral.
  if (tiltOn.checked) voice.recentre();
  showTilt();
});
tiltSteps.addEventListener('input', () => {
  voice.saveSettings({ ...voice.settings(), tilt: { ...voice.settings().tilt, steps: Number(tiltSteps.value) } });
  showTilt();
});
tiltRecentre.addEventListener('click', () => {
  voice.recentre();
  show('Tilt recentred: the angle now is neutral.');
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
  if (document.hidden && voice.isListening()) stopMic('The mic stops when the page is out of view. Turn it on again to go on.');
});
addEventListener('pagehide', () => voice.stop());

showBoard();
showStickiness();
// Limit: a touch screen is the guess for a tilt sensor, because iOS sends no reading before the player
// allows it, and it asks only when tilt turns on. A desktop with a sensor shows the editor after its first
// reading. Revisit if players with a touch screen and no sensor report a switch that does nothing.
tiltEditor.hidden = !matchMedia('(pointer: coarse)').matches;
showTilt();
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
