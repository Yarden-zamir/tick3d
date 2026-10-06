// Play by voice: the microphone aims at the cell of your pitch, and a held note places your move.
// The pitch, the range, the sticky cells and the microphone come from /sound-input (src/sound-input/),
// so a calibration there applies here too. src/voice.ts decides when the microphone listens.
import { toCoords } from '../game.ts';
import { MIC_ICON } from '../icons.ts';
import { median } from '../sound-input/calibration.ts';
import { DEFAULT_RANGE, cellOfStep, positionOf } from '../sound-input/mapping.ts';
import { MISS_FRAMES, SMOOTH_FRAMES, type Mic, closeMic, hasMic, micError, openMic } from '../sound-input/mic.ts';
import { detectPitch } from '../sound-input/pitch.ts';
import { type Held, holdStep } from '../sound-input/sticky.ts';
import { type Stored, DEFAULT_STORED, loadStored } from '../sound-input/stored.ts';
import { liveSoundUntil, sounds } from '../sound.ts';
import { type VoiceGate, type VoiceState, holdPlaces, voiceState } from '../voice.ts';
import { voiceButton, voiceStateEl, voiceStatus } from './dom.ts';
import { showProblem } from './feedback.ts';
import { renderCoords } from './keypad.ts';
import { render } from './render.ts';
import { humanMove } from './sessions.ts';
import { saveSettings, settings } from './settings.ts';
import { current, isLive, page } from './state.ts';

const STATE_TEXT: Record<VoiceState, string> = {
  off: 'Voice: on in your next game',
  paused: 'Voice: paused',
  listening: 'Voice: listening',
};

let mic: Mic | undefined;
let opening = false;
let frame = 0;
// The choices of /sound-input. The voice reads them each time the microphone opens.
let stored: Stored = DEFAULT_STORED;
// The pitches of the last frames, the frames without a clear pitch since the last pitch, and the held step.
let recent: number[] = [];
let misses = 0;
let held: Held | null = null;
// The step of the last move from the voice. See holdPlaces.
let blockedStep: number | undefined;
// The cell that the voice shows on the board and on the keypad.
let aim: number | undefined;

function gate(): VoiceGate {
  const session = page.session;
  return {
    on: settings.voice,
    visible: !document.hidden,
    seated: session !== undefined && session.you !== null && page.viewing === undefined,
    live: isLive(),
    // In a friend game this screen plays both seats.
    myTurn: session !== undefined && (session.mode === 'friend' || current().turn === session.you),
    waiting: page.busy || page.thinking || page.review !== undefined,
    soundUntil: liveSoundUntil(),
    now: performance.now(),
  };
}

// The aim is the keypad entry: the board marks it, and the keypad slots show it with Hide board too.
function aimAt(cell: number | undefined): void {
  if (cell === aim) return;
  aim = cell;
  if (cell === undefined) page.coordDigits = [];
  else {
    const { layer, row, column } = toCoords(cell);
    page.coordDigits = [layer + 1, row + 1, column + 1];
  }
  renderCoords();
}

function forget(): void {
  recent = [];
  misses = 0;
  held = null;
  aimAt(undefined);
}

function showState(state: VoiceState): void {
  if (voiceButton.dataset.state === state) return;
  voiceButton.dataset.state = state;
  voiceStateEl.textContent = STATE_TEXT[state];
}

function listen(now: number): void {
  if (mic === undefined) return;
  frame = requestAnimationFrame(listen);
  const state = voiceState(gate());
  showState(state);
  if (state === 'off') return closeVoice();
  // A paused voice drops what it heard, so the sound of the game does not start a hold.
  if (state === 'paused') return forget();
  mic.analyser.getFloatTimeDomainData(mic.samples);
  const pitch = detectPitch(mic.samples, mic.context.sampleRate);
  if (pitch === null) {
    misses++;
    if (misses >= MISS_FRAMES) {
      forget();
      blockedStep = undefined;
    }
    return;
  }
  misses = 0;
  recent = [...recent, pitch.frequency].slice(-SMOOTH_FRAMES);
  held = holdStep(held, positionOf(median(recent), stored.range ?? DEFAULT_RANGE), now, stored.stickiness);
  if (held.step !== blockedStep) blockedStep = undefined;
  const cell = cellOfStep(held.step);
  aimAt(cell);
  if (!holdPlaces(held, now, blockedStep)) return;
  blockedStep = held.step;
  aimAt(undefined);
  // The normal move path: the same checks, refusals and sounds as a tap.
  humanMove(cell, 'keypad');
}

function closeVoice(): void {
  cancelAnimationFrame(frame);
  if (mic !== undefined) closeMic(mic);
  mic = undefined;
  forget();
}

function turnOff(problem: string): void {
  settings.voice = false;
  saveSettings();
  closeVoice();
  showProblem(problem);
  render();
}

async function openVoice(): Promise<void> {
  if (opening) return;
  if (!hasMic()) return turnOff('This browser gives the page no microphone. Open the page over https in a current browser.');
  opening = true;
  let opened: Mic;
  try {
    opened = await openMic();
  } catch (error) {
    return turnOff(micError(error));
  } finally {
    opening = false;
  }
  // The game ended, or the page went out of view, while the browser asked.
  if (mic !== undefined || voiceState(gate()) === 'off') return closeMic(opened);
  mic = opened;
  stored = loadStored();
  for (const track of opened.stream.getTracks()) track.addEventListener('ended', () => turnOff('The microphone stopped. Turn on play by voice again to go on.'));
  frame = requestAnimationFrame(listen);
}

// Opens or closes the microphone for the state of the page. render() calls it after every change.
export function syncVoice(): void {
  const state = voiceState(gate());
  if (state === 'off') closeVoice();
  else if (mic === undefined) void openVoice();
  voiceButton.hidden = page.viewing !== undefined || page.session === undefined || page.session.you === null;
  voiceButton.setAttribute('aria-pressed', String(settings.voice));
  voiceStatus.hidden = !settings.voice || voiceButton.hidden;
  showState(mic === undefined && state !== 'off' ? 'paused' : state);
}

export function setupVoice(): void {
  voiceButton.innerHTML = MIC_ICON;
  voiceButton.addEventListener('click', () => {
    settings.voice = !settings.voice;
    saveSettings();
    sounds.click();
    // The microphone opens during the tap, so the browser starts its audio.
    render();
  });
  document.addEventListener('visibilitychange', syncVoice);
  addEventListener('pagehide', closeVoice);
  // A microphone that opened without a tap (a new game, the page back in view) can start suspended.
  document.addEventListener('pointerdown', () => {
    if (mic?.context.state === 'suspended') void mic.context.resume();
  });
}
