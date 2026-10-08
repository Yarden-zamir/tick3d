import { describe, expect, it } from 'vitest';
import { HOLD_MS, SOUND_TAIL_MS, type VoiceGate, holdPlaces, voiceState } from './voice-gate.ts';

const READY: VoiceGate = { on: true, visible: true, seated: true, live: true, myTurn: true, waiting: false, soundUntil: 0, now: 10_000 };

describe('voiceState', () => {
  it('listens on the turn of this screen, in a live game, with no sound playing', () => {
    expect(voiceState(READY)).toBe('listening');
  });

  it('closes the microphone when the voice is off, the page is hidden, the screen has no seat, or the game is over', () => {
    for (const change of [{ on: false }, { visible: false }, { seated: false }, { live: false }]) {
      expect(voiceState({ ...READY, ...change })).toBe('off');
    }
  });

  it('pauses on the turn of the other player and while a move or the computer is on its way', () => {
    expect(voiceState({ ...READY, myTurn: false })).toBe('paused');
    expect(voiceState({ ...READY, waiting: true })).toBe('paused');
  });

  it('pauses while a sound of the game plays, and for a short tail after it', () => {
    expect(voiceState({ ...READY, soundUntil: READY.now + 200 })).toBe('paused');
    expect(voiceState({ ...READY, soundUntil: READY.now - SOUND_TAIL_MS + 1 })).toBe('paused');
    expect(voiceState({ ...READY, soundUntil: READY.now - SOUND_TAIL_MS })).toBe('listening');
  });
});

describe('holdPlaces', () => {
  it('places after the hold time', () => {
    expect(holdPlaces(12, HOLD_MS - 1, undefined)).toBe(false);
    expect(holdPlaces(12, HOLD_MS, undefined)).toBe(true);
  });

  it('places once for one note on a step, and again on another step', () => {
    expect(holdPlaces(12, 5_000, 12)).toBe(false);
    expect(holdPlaces(13, 5_000, 12)).toBe(true);
  });
});
