// Play by voice in the game: the voice engine (src/voice/engine.ts) aims at the cell of your pitch, and a
// held note places your move. The engine owns the microphone, the pitch, the range and the sticky cells,
// so a calibration in the Voice room (/sound-input) applies here too. voice-gate.ts decides when it listens.
import { toCoords } from '../game.ts';
import { MIC_ICON } from '../icons.ts';
import { type VoiceClip, type VoiceClips, liveSoundUntil, sounds } from '../sound.ts';
import { type Voice, type VoiceFrame, createVoice } from '../voice/engine.ts';
import { type Rail, buildRail, showRailPitch, showRailRange } from '../voice/rail.ts';
import { type HoldFill, type VoiceCells, createVoiceCells } from '../voice/visuals.ts';
import { withReturn } from '../return-path.ts';
import { cells } from './board.ts';
import { coordsPlace, voiceButton, voicePanel, voiceRailEl, voiceRecentre, voiceRoomLink, voiceStateEl } from './dom.ts';
import { showProblem } from './feedback.ts';
import { renderCoords } from './keypad.ts';
import { render } from './render.ts';
import { humanMove } from './sessions.ts';
import { saveSettings, settings } from './settings.ts';
import { current, isLive, page } from './state.ts';
import { HOLD_MS, type VoiceGate, type VoiceState, holdPlaces, voiceState } from './voice-gate.ts';

const STATE_TEXT: Record<VoiceState, string> = {
  off: 'Voice: on in your next game',
  paused: 'Voice: paused',
  listening: 'Voice: listening',
};

let voice: Voice | undefined;
let rail: Rail | undefined;
// The light, the hold fill and the burst on the board: the same as in the Voice room (src/voice/visuals.ts).
let voiceCells: VoiceCells | undefined;
let opening = false;
// The game paused the engine. A paused engine sends empty frames, and they are not silence.
let enginePaused = false;
// The step of the last move from the voice. See holdPlaces.
let blockedStep: number | undefined;
// The cell that the voice shows on the board and on the keypad.
let aim: number | undefined;
// The player's voice for each move that the voice placed in one game, by move index. They stay in memory
// only: the page never uploads them. syncVoice drops them at the next game, and drops undone moves.
// `game` is "<session code>:<game index>".
let clips: { game: string; byMove: Map<number, VoiceClip> } | undefined;

const gameKey = (index: number) => `${page.session?.code ?? ''}:${index}`;

// The clips of game `index` of the open session: none for another game.
export function voiceClips(index: number): VoiceClips {
  return clips !== undefined && clips.game === gameKey(index) ? clips.byMove : new Map();
}

// A clip holds the held note and a short lead-in before it, at most CLIP_MAX_MS.
const CLIP_LEAD_MS = 150;
const CLIP_MAX_MS = 1500;

// The held note of `frame`, from the voice engine, with the pitch that the engine heard.
// undefined when the engine does not listen.
function takeClip(frame: VoiceFrame): VoiceClip | undefined {
  if (voice === undefined) return undefined;
  if (frame.frequency === null) throw new Error('a frame that places a move has a pitch');
  const clip = voice.clip(Math.min(CLIP_MAX_MS, frame.heldMs + CLIP_LEAD_MS));
  return clip === null ? undefined : { ...clip, frequency: frame.frequency };
}

// Keeps the clip of move `move`, which the voice just placed in the newest game.
function keepClip(clip: VoiceClip, move: number): void {
  const game = gameKey(page.games.length - 1);
  if (clips?.game !== game) clips = { game, byMove: new Map() };
  clips.byMove.set(move, clip);
}

// Drops the clips of an older game, and of moves that are not in the newest game any more (an undo).
function dropOldClips(): void {
  if (clips === undefined) return;
  if (clips.game !== gameKey(page.games.length - 1)) {
    clips = undefined;
    return;
  }
  const moves = page.games.at(-1)?.moves.length ?? 0;
  for (const move of clips.byMove.keys()) if (move >= moves) clips.byMove.delete(move);
}

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

// The lit cell and its hold fill, on the board and on the Place button of the keypad. The Place button
// shows the hold with Hide board too.
function showHold(cell: number | null, hold: HoldFill | null): void {
  voiceCells?.show(cell, hold);
  coordsPlace.classList.toggle('voice-hold', hold !== null);
  if (hold === null) {
    coordsPlace.style.removeProperty('--voice-hold');
    delete coordsPlace.dataset.voiceMark;
    return;
  }
  coordsPlace.style.setProperty('--voice-hold', String(Math.min(1, Math.max(0, hold.share))));
  coordsPlace.dataset.voiceMark = hold.mark;
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
    showRailPitch(rail, null, null, 0, null);
    showHold(null, null);
    return aimAt(undefined);
  }
  if (enginePaused) {
    // This frame is still an empty one of the pause.
    voice.resume();
    enginePaused = false;
    return;
  }
  voiceRecentre.hidden = !voice.hasTilt() || !voice.settings().tilt.on;
  showRailPitch(rail, frame.position, frame.held, frame.margin, frame.tilt);
  if (frame.cell === null || frame.held === null) {
    // Silence ends the block of the last move.
    if (frame.raw === null) blockedStep = undefined;
    showHold(null, null);
    return aimAt(undefined);
  }
  const { step } = frame.held;
  if (step !== blockedStep) blockedStep = undefined;
  aimAt(frame.cell);
  // A taken cell and the cell of the last move fill nothing: a hold places nothing there.
  const game = current();
  const free = step !== blockedStep && game.board[frame.cell] === null;
  showHold(frame.cell, free ? { share: frame.heldMs / HOLD_MS, mark: game.turn } : null);
  if (!holdPlaces(step, frame.heldMs, blockedStep)) return;
  blockedStep = step;
  aimAt(undefined);
  showHold(frame.cell, null);
  // The normal move path: the same checks, refusals and sounds as a tap. It shows an accepted move at once.
  const move = current().moves.length;
  // The clip comes before the move: a move that ends the game stops the engine, and the engine has no clip then.
  const clip = takeClip(frame);
  humanMove(frame.cell, 'keypad');
  if (clip !== undefined && page.games.at(-1)?.moves.length === move + 1) keepClip(clip, move);
  if (page.games.at(-1)?.moves.length === move + 1) voiceCells?.burst(frame.cell);
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
  if (rail !== undefined) showRailRange(rail, engine.pitchMap());
  // The game ended, or the page went out of view, while the browser asked.
  syncVoice();
}

// Opens or closes the microphone for the state of the page. render() calls it after every change.
export function syncVoice(): void {
  dropOldClips();
  if (voice === undefined) return;
  const state = voiceState(gate());
  if (state === 'off') {
    voice.stop();
    showHold(null, null);
    if (rail !== undefined) showRailPitch(rail, null, null, 0, null);
    aimAt(undefined);
  } else if (!voice.isListening() && !opening) void openVoice(voice);
  voiceButton.hidden = page.viewing !== undefined || page.session === undefined || page.session.you === null;
  voiceButton.setAttribute('aria-pressed', String(settings.voice));
  voicePanel.hidden = !settings.voice || voiceButton.hidden;
  // In a seated online game, the Voice room opens on its playoff for this game.
  const online = page.session?.mode === 'online' && page.session.you !== null ? page.session.code : undefined;
  // The Voice room links back to this page.
  voiceRoomLink.href = withReturn(online === undefined ? '/sound-input' : `/sound-input?code=${online}`, `${location.pathname}${location.search}`);
  showState(!voice.isListening() && state !== 'off' ? 'paused' : state);
}

export function setupVoice(): void {
  const engine = createVoice();
  voice = engine;
  rail = buildRail(voiceRailEl);
  voiceCells = createVoiceCells(cells);
  showRailRange(rail, engine.pitchMap());
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
  // A tap: on iOS it also asks for the tilt sensor.
  voiceRecentre.addEventListener('click', () => {
    engine.recentre();
    sounds.click();
  });
  document.addEventListener('visibilitychange', syncVoice);
  addEventListener('pagehide', () => engine.stop());
}
