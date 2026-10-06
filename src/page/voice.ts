// Play by voice in the game: the voice engine (src/voice/engine.ts) aims at the cell of your pitch, and a
// held note places your move. The engine owns the microphone, the pitch, the range and the sticky cells,
// so a calibration in the Voice room (/sound-input) applies here too. voice-gate.ts decides when it listens.
import { toCoords } from '../game.ts';
import { MIC_ICON } from '../icons.ts';
import { liveSoundUntil, sounds } from '../sound.ts';
import { type Voice, type VoiceFrame, createVoice } from '../voice/engine.ts';
import { type Rail, buildRail, showRailPitch, showRailRange } from '../voice/rail.ts';
import { voiceButton, voicePanel, voiceRailEl, voiceRoomLink, voiceStateEl } from './dom.ts';
import { showProblem } from './feedback.ts';
import { renderCoords } from './keypad.ts';
import { render } from './render.ts';
import { humanMove } from './sessions.ts';
import { saveSettings, settings } from './settings.ts';
import { current, isLive, page } from './state.ts';
import { type VoiceGate, type VoiceState, holdPlaces, voiceState } from './voice-gate.ts';

const STATE_TEXT: Record<VoiceState, string> = {
  off: 'Voice: on in your next game',
  paused: 'Voice: paused',
  listening: 'Voice: listening',
};

let voice: Voice | undefined;
let rail: Rail | undefined;
let opening = false;
// The game paused the engine. A paused engine sends empty frames, and they are not silence.
let enginePaused = false;
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

function showState(state: VoiceState): void {
  if (voiceButton.dataset.state === state) return;
  voiceButton.dataset.state = state;
  voiceStateEl.textContent = STATE_TEXT[state];
}

function onFrame(frame: VoiceFrame): void {
  if (voice === undefined || rail === undefined) return;
  const state = voiceState(gate());
  showState(state);
  if (state === 'off') return syncVoice();
  if (state === 'paused') {
    // A paused engine drops the input, so the sound of the game does not start a hold.
    voice.pause();
    enginePaused = true;
    showRailPitch(rail, null, null, 0);
    return aimAt(undefined);
  }
  if (enginePaused) {
    // This frame is still an empty one of the pause.
    voice.resume();
    enginePaused = false;
    return;
  }
  showRailPitch(rail, frame.position, frame.held, frame.margin);
  if (frame.cell === null || frame.held === null) {
    // Silence ends the block of the last move.
    if (frame.raw === null) blockedStep = undefined;
    return aimAt(undefined);
  }
  const { step } = frame.held;
  if (step !== blockedStep) blockedStep = undefined;
  aimAt(frame.cell);
  if (!holdPlaces(step, frame.heldMs, blockedStep)) return;
  blockedStep = step;
  aimAt(undefined);
  // The normal move path: the same checks, refusals and sounds as a tap.
  humanMove(frame.cell, 'keypad');
}

function turnOff(problem: string): void {
  settings.voice = false;
  saveSettings();
  voice?.stop();
  showProblem(problem);
  render();
}

async function openVoice(engine: Voice): Promise<void> {
  opening = true;
  const problem = await engine.start();
  opening = false;
  if (problem !== null) return turnOff(problem);
  if (rail !== undefined) showRailRange(rail, engine.range());
  // The game ended, or the page went out of view, while the browser asked.
  syncVoice();
}

// Opens or closes the microphone for the state of the page. render() calls it after every change.
export function syncVoice(): void {
  if (voice === undefined) return;
  const state = voiceState(gate());
  if (state === 'off') {
    voice.stop();
    aimAt(undefined);
  } else if (!voice.isListening() && !opening) void openVoice(voice);
  voiceButton.hidden = page.viewing !== undefined || page.session === undefined || page.session.you === null;
  voiceButton.setAttribute('aria-pressed', String(settings.voice));
  voicePanel.hidden = !settings.voice || voiceButton.hidden;
  // In a seated online game, the Voice room opens on its playoff for this game.
  const online = page.session?.mode === 'online' && page.session.you !== null ? page.session.code : undefined;
  voiceRoomLink.href = online === undefined ? '/sound-input' : `/sound-input?code=${online}`;
  showState(!voice.isListening() && state !== 'off' ? 'paused' : state);
}

export function setupVoice(): void {
  const engine = createVoice();
  voice = engine;
  rail = buildRail(voiceRailEl);
  showRailRange(rail, engine.range());
  engine.subscribe(onFrame);
  engine.onStop(turnOff);
  voiceButton.innerHTML = MIC_ICON;
  voiceButton.addEventListener('click', () => {
    settings.voice = !settings.voice;
    saveSettings();
    sounds.click();
    // The microphone opens during the tap, so the browser starts its audio.
    render();
  });
  document.addEventListener('visibilitychange', syncVoice);
  addEventListener('pagehide', () => engine.stop());
}
