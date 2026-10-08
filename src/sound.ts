import type { Player } from './game.ts';
import type { Song, SongNote } from './song.ts';
import { SOUND_SETS, type SoundSetId, type SoundSet, type Voice, midiHz } from './sound-sets.ts';

// All sounds are synthesized with Web Audio, so the app ships no audio files.
let context: AudioContext | undefined;
let muted = false;
// The end of the last live sound, in performance.now() milliseconds. Play by voice does not listen until then.
let soundUntil = 0;

export const liveSoundUntil = (): number => soundUntil;

// Counts the live sounds that the page asks for, muted or not. A press uses it to see whether its
// handler played an own sound (src/click-sound.ts).
let soundRequests = 0;

export const soundRequestCount = (): number => soundRequests;

export function setMuted(value: boolean): void {
  muted = value;
}

function audio(): AudioContext | undefined {
  soundRequests++;
  if (muted || typeof AudioContext === 'undefined') return undefined;
  context ??= new AudioContext();
  // Browsers start the context suspended until a user gesture. A sound without a gesture (a chat
  // message or the other player's move before the first tap) is skipped: a suspended context would
  // queue it and play it late, together with the next sounds.
  if (context.state === 'suspended') {
    // Safari before 16.4 has no userActivation, and then plays the sound as before.
    if (navigator.userActivation && !navigator.userActivation.isActive) return undefined;
    void context.resume();
  }
  return context;
}

type Tone = { frequency: number; at?: number; duration: number; type?: OscillatorType; volume?: number; slideTo?: number; pan?: number };

function tone({ frequency, at = 0, duration, type = 'sine', volume = 0.2, slideTo, pan = 0 }: Tone): void {
  play([{ wave: type, frequency, at, attack: 0.01, decay: duration, level: volume, ...(slideTo === undefined ? {} : { slideTo }), pan }]);
}

let noiseBuffer: AudioBuffer | undefined;

// One second of white noise, made once. Drums, wind and rain filter it.
function noise(ctx: BaseAudioContext): AudioBuffer {
  if (noiseBuffer === undefined) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const samples = noiseBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

// Plays the voices of src/sound-sets.ts. Each voice is a source, an envelope, an optional filter and a side.
// `scale` makes all levels softer or louder, and `delay` starts all voices later. `ctx` is the live
// context, or an OfflineAudioContext that renders a sound file. `output` is the speaker, or the mix of a song.
function play(voices: readonly Voice[], scale = 1, delay = 0, ctx: BaseAudioContext | undefined = audio(), output?: AudioNode): void {
  if (!ctx) return;
  for (const voice of voices) {
    if (!(voice.level > 0) || !(voice.decay > 0)) throw new RangeError(`a voice needs a level and a decay: ${JSON.stringify(voice)}`);
    const start = ctx.currentTime + delay + (voice.at ?? 0);
    const end = start + voice.decay + 0.02;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(voice.level * scale, start + (voice.attack ?? 0.005));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + voice.decay);
    let source: AudioScheduledSourceNode;
    if (voice.wave === 'noise') {
      const buffer = ctx.createBufferSource();
      buffer.buffer = noise(ctx);
      buffer.loop = true;
      source = buffer;
    } else {
      const oscillator = ctx.createOscillator();
      oscillator.type = voice.wave;
      oscillator.frequency.setValueAtTime(voice.frequency, start);
      if (voice.slideTo !== undefined) oscillator.frequency.exponentialRampToValueAtTime(voice.slideTo, start + (voice.slideTime ?? voice.decay));
      if (voice.vibrato !== undefined) {
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        lfo.frequency.setValueAtTime(voice.vibrato.rate, start);
        depth.gain.setValueAtTime(voice.frequency * voice.vibrato.depth, start);
        lfo.connect(depth).connect(oscillator.frequency);
        lfo.start(start);
        lfo.stop(end);
      }
      source = oscillator;
    }
    let out: AudioNode = source.connect(gain);
    if (voice.filter !== undefined) {
      const { type, frequency, to, time, q } = voice.filter;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.setValueAtTime(frequency, start);
      if (to !== undefined) filter.frequency.exponentialRampToValueAtTime(to, start + (time ?? voice.decay));
      if (q !== undefined) filter.Q.setValueAtTime(q, start);
      out = out.connect(filter);
    }
    // Left (-1) to right (1). The column of a cell comes from its side on headphones.
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(voice.pan ?? 0, start);
    out.connect(panner).connect(output ?? ctx.destination);
    source.start(start);
    source.stop(end);
    if (ctx === context) soundUntil = Math.max(soundUntil, performance.now() + (end - ctx.currentTime) * 1000);
  }
}

let soundSet: SoundSet = SOUND_SETS.cells;

export function setSoundSet(id: SoundSetId): void {
  soundSet = SOUND_SETS[id];
}

// Whether the keypad plays a typed cell before Place. Classic keeps it quiet.
export const keypadPreviews = (): boolean => soundSet.keypadPreview !== false;

// The demo of a set: the main diagonal of the tower, X and O in turn, one layer after the other.
const DEMO_CELLS = [0, 21, 42, 63] as const;
const DEMO_GAP = 0.42;

export function playDemo(id: SoundSetId): void {
  DEMO_CELLS.forEach((cell, index) => play(SOUND_SETS[id].voices(cell, index % 2 === 0 ? 'X' : 'O'), 1, index * DEMO_GAP));
}

// One cell of a set, as a move of X: the sound when a player picks the set.
export function playSample(id: SoundSetId): void {
  play(SOUND_SETS[id].voices(DEMO_CELLS[1], 'X'));
}

// ---- The game as a song (src/song.ts) ----

// A melody note of the song is a short pluck: each voice rises within PLUCK_ATTACK and fades out within
// PLUCK_DECAY. A voice of the set that starts after LATE_VOICE (an echo, a run of notes) is left out.
const PLUCK_ATTACK = 0.01;
const PLUCK_DECAY = 0.28;
const LATE_VOICE = 0.05;

// The voices of a melody note: the voices of its cell in the sound set, tuned to the note and cut to a
// pluck, so the song has the timbre of the set. A set without a pitched voice plays a soft triangle.
// X sits on the left, O on the right.
function melodyVoices(note: Extract<SongNote, { kind: 'melody' }>, set: SoundSet): Voice[] {
  const target = midiHz(note.midi);
  const pan = note.player === 'X' ? -0.35 : 0.35;
  const voices = set.voices(note.cell, note.player).filter((voice) => (voice.at ?? 0) < LATE_VOICE);
  const lead = voices.find((voice) => voice.wave !== 'noise');
  if (lead === undefined || !('frequency' in lead)) return [{ wave: 'triangle', frequency: target, attack: 0.005, decay: 0.22, level: 0.2 * note.level, pan }];
  const ratio = target / lead.frequency;
  return voices.map((voice) => {
    const filter = voice.filter && { ...voice.filter, frequency: voice.filter.frequency * ratio, ...(voice.filter.to === undefined ? {} : { to: voice.filter.to * ratio }) };
    const decay = Math.min(voice.decay, PLUCK_DECAY);
    const attack = Math.min(voice.attack ?? 0.005, PLUCK_ATTACK, decay / 2);
    const tuned = { ...voice, attack, decay, level: voice.level * note.level, pan, ...(filter === undefined ? {} : { filter }) };
    if (tuned.wave === 'noise') return tuned;
    return { ...tuned, frequency: tuned.frequency * ratio, ...(tuned.slideTo === undefined ? {} : { slideTo: tuned.slideTo * ratio }) };
  });
}

// A chord note is a plucked triangle that rings for its length. A bass note is a short round triangle under a low filter.
function noteVoices(note: SongNote, set: SoundSet): Voice[] {
  const frequency = midiHz(note.midi);
  switch (note.kind) {
    case 'melody':
      return melodyVoices(note, set);
    case 'chord':
      return [{ wave: 'triangle', frequency, attack: 0.005, decay: note.length, level: 0.07 }];
    case 'bass':
      return [{ wave: 'triangle', frequency, attack: 0.005, decay: note.length, level: 0.16, filter: { type: 'lowpass', frequency: 600 } }];
  }
}

// The mix of a song: a gain that makes the short notes about as loud as a move sound, then a limiter, so
// nothing clips. The voices go into the gain, and the limiter goes to the speaker.
function songMix(ctx: BaseAudioContext): AudioNode {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(1.6, 0);
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.setValueAtTime(-6, 0);
  limiter.ratio.setValueAtTime(20, 0);
  limiter.attack.setValueAtTime(0.003, 0);
  limiter.release.setValueAtTime(0.25, 0);
  gain.connect(limiter).connect(ctx.destination);
  return gain;
}

// A short recording of the player's voice for a move that the voice placed (src/page/voice.ts).
// `frequency` is the pitch that the voice engine heard.
export type VoiceClip = { samples: Float32Array<ArrayBuffer>; sampleRate: number; frequency: number };
// The clips of a game by move index. Most games have none.
export type VoiceClips = ReadonlyMap<number, VoiceClip>;

// A clip in the song plays this long at most, about two eighth notes, and the synthesized note under it this soft.
const CLIP_SECONDS = 0.4;
const UNDER_CLIP = 0.35;

// Plays a clip at the note of the song: playbackRate moves its pitch, at most one octave either way.
// The clip plays its end: the end of the held note, where the pitch is steady.
function playClip(ctx: BaseAudioContext, clip: VoiceClip, midi: number, start: number, output: AudioNode): void {
  if (!(clip.frequency > 0) || clip.samples.length === 0) throw new RangeError(`a voice clip needs samples and a pitch: ${clip.frequency} Hz`);
  const buffer = ctx.createBuffer(1, clip.samples.length, clip.sampleRate);
  buffer.copyToChannel(clip.samples, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const rate = Math.min(2, Math.max(0.5, midiHz(midi) / clip.frequency));
  source.playbackRate.setValueAtTime(rate, start);
  // The loudest sample of the clip goes to about half of full scale.
  let peak = 0;
  for (const sample of clip.samples) peak = Math.max(peak, Math.abs(sample));
  const level = peak > 0 ? 0.5 / peak : 0;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(level, start + 0.02);
  gain.gain.setValueAtTime(level, start + CLIP_SECONDS - 0.08);
  gain.gain.linearRampToValueAtTime(0, start + CLIP_SECONDS);
  source.connect(gain).connect(output);
  source.start(start, Math.max(0, buffer.duration - CLIP_SECONDS * rate));
  source.stop(start + CLIP_SECONDS);
}

// The clip that a note of the song plays: the clip of its move, else none (the synthesized note only).
// The chords, the bass and the ending have no move, so they never take a clip.
export const clipOf = (note: SongNote, clips: VoiceClips): VoiceClip | undefined =>
  note.kind === 'melody' && note.move !== undefined ? clips.get(note.move) : undefined;

// A sound to schedule: a note of a song with its set, or ready voices (a preview strike, the win jingle).
// `at` is the start in seconds after the current time of the context.
export type ScheduledSound = { at: number } & ({ note: SongNote; set: SoundSet } | { voices: readonly Voice[] });

// Plays the sounds in the song mix. The video spot (video/) times each sound itself. Returns the mix.
export function scheduleNotes(sounds: readonly ScheduledSound[], ctx: BaseAudioContext): AudioNode {
  const mix = songMix(ctx);
  for (const sound of sounds) play('voices' in sound ? sound.voices : noteVoices(sound.note, sound.set), 1, sound.at, ctx, mix);
  return mix;
}

function scheduleSong(song: Song, set: SoundSet, ctx: BaseAudioContext, delay: number, clips: VoiceClips): AudioNode {
  const mix = songMix(ctx);
  for (const note of song.notes) {
    const clip = clipOf(note, clips);
    // A move that the voice placed plays the player's own note, over a soft synthesized one.
    if (clip !== undefined) playClip(ctx, clip, note.midi, ctx.currentTime + delay + note.at, mix);
    play(noteVoices(note, set), clip === undefined ? 1 : UNDER_CLIP, delay + note.at, ctx, mix);
  }
  return mix;
}

// A song that plays: `elapsed` reads the song time from the audio clock, so a highlight stays in sync.
export type SongPlayback = { elapsed: () => number; stop: () => void };

// Plays a finished game as a song in the sound set of the screen. undefined: the sound is off.
export function playSong(song: Song, clips: VoiceClips): SongPlayback | undefined {
  const ctx = audio();
  if (!ctx) return undefined;
  // A short lead, so the first note is not late.
  const lead = 0.05;
  const start = ctx.currentTime + lead;
  const mix = scheduleSong(song, soundSet, ctx, lead, clips);
  return { elapsed: () => ctx.currentTime - start, stop: () => mix.disconnect() };
}

// The same song, rendered into stereo samples by the same voices and mix. The mute does not apply: the
// player asks for a file.
const SONG_RATE = 44_100;

export function renderSong(song: Song, clips: VoiceClips): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(song.duration * SONG_RATE), SONG_RATE);
  scheduleSong(song, soundSet, ctx, 0, clips);
  return ctx.startRendering();
}

// The preview plays softer than a move: 0.12 against 0.28 in the Cells set.
const PREVIEW_SCALE = 0.12 / 0.28;

// The preview strike of a cell: the strike of X in `set`, softer. The video spot (video/) plays it on a threat.
export const previewVoices = (set: SoundSet, cell: number): Voice[] => set.voices(cell, 'X').map((voice) => ({ ...voice, level: voice.level * PREVIEW_SCALE }));

// The win jingle: C5, E5, G5, C6, E6, `gap` seconds apart. The game plays it fast; the video spot one note per sixteenth.
const WIN_NOTES = [523.25, 659.25, 783.99, 1046.5, 1318.5] as const;
export const winVoices = (gap: number): Voice[] => WIN_NOTES.map((frequency, i) => ({ wave: 'triangle', frequency, at: i * gap, attack: 0.01, decay: 0.35, level: 0.2 }));

export const sounds = {
  place(player: Player, cell: number): void {
    play(soundSet.voices(cell, player));
  },
  // Plays the cells as moves of `player`, `gap` seconds apart, on the audio clock: a busy page or a
  // background tab does not move them. Returns a function that drops the cells that did not start yet.
  placeSeries(player: Player, cells: readonly number[], gap: number): () => void {
    const ctx = audio();
    if (!ctx) return () => undefined;
    const notes = cells.map((cell, index) => {
      // One output per cell, so a stop cuts the later cells and lets the sounding one ring out.
      const output = ctx.createGain();
      output.connect(ctx.destination);
      play(soundSet.voices(cell, player), 1, index * gap, ctx, output);
      return { start: ctx.currentTime + index * gap, output };
    });
    return () => {
      for (const note of notes) if (note.start > ctx.currentTime) note.output.disconnect();
    };
  },
  // The sound of a cell before it is played, for example from the keypad: the same strike, softer.
  preview(cell: number): void {
    play(previewVoices(soundSet, cell));
  },
  invalid(): void {
    tone({ frequency: 180, duration: 0.12, type: 'square', volume: 0.06 });
    tone({ frequency: 140, at: 0.11, duration: 0.16, type: 'square', volume: 0.06 });
  },
  // A chat message from the other player: a bright two-note ding.
  message(): void {
    tone({ frequency: 987.77, duration: 0.12, type: 'triangle', volume: 0.16 });
    tone({ frequency: 1318.51, at: 0.1, duration: 0.22, type: 'triangle', volume: 0.16 });
    tone({ frequency: 2637, at: 0.1, duration: 0.1, volume: 0.03 });
  },
  // Your chat message left: a short upward whoosh.
  sent(): void {
    tone({ frequency: 520, duration: 0.14, volume: 0.09, slideTo: 1240 });
  },
  // A clock tick in the last 10 seconds. The last 3 seconds sound higher.
  tick(urgent: boolean): void {
    tone({ frequency: urgent ? 1400 : 900, duration: 0.05, type: 'square', volume: 0.04 });
  },
  click(): void {
    tone({ frequency: 1200, duration: 0.04, volume: 0.05 });
  },
  win(): void {
    play(winVoices(0.09));
  },
  lose(): void {
    [392, 349.23, 311.13, 261.63].forEach((frequency, i) =>
      tone({ frequency, at: i * 0.16, duration: 0.3, type: 'sawtooth', volume: 0.06 }),
    );
  },
  draw(): void {
    tone({ frequency: 440, duration: 0.25, type: 'triangle' });
    tone({ frequency: 440, at: 0.22, duration: 0.35, type: 'triangle', slideTo: 415 });
  },
};
