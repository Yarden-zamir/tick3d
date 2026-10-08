// Renders the soundtrack of the spot with the game's own sound code in an OfflineAudioContext:
//   out/soundtrack.wav (44.1 kHz stereo, 15.0 s), a copy in public/ for Remotion, and out/beats.txt.
import { mkdirSync, writeFileSync } from 'node:fs';
import { OfflineAudioContext } from 'node-web-audio-api';
import { SIXTEENTH } from '../../src/song.ts';
import { scheduleNotes } from '../../src/sound.ts';
import { encodeWav } from '../../src/wav.ts';
import { spotNotes } from '../src/soundtrack.ts';
import { BEATS } from '../src/timeline.ts';

const RATE = 44_100;
const FADE_SECONDS = 0.05;
const out = new URL('../out/', import.meta.url);
const pub = new URL('../public/', import.meta.url);

const notes = spotNotes();
const length = BEATS.durationSeconds * RATE;
const ctx = new OfflineAudioContext(2, length, RATE);
scheduleNotes(notes.map(({ at, note, set }) => ({ note, set, at: at * SIXTEENTH })), ctx);
const buffer = await ctx.startRendering();

const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
// The song mix plays as loud as a move in the game. A video plays louder: the peak goes to -1 dBFS.
let peak = 0;
for (const channel of channels) for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
if (!(peak > 0)) throw new Error('the soundtrack is silent');
const gain = 10 ** (-1 / 20) / peak;
for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] = (channel[i] ?? 0) * gain;
// The last 50 ms fade to silence, so the cut at 15.0 s does not click.
const fade = Math.round(FADE_SECONDS * RATE);
for (const channel of channels) {
  for (let i = 0; i < fade; i++) channel[length - fade + i] = (channel[length - fade + i] ?? 0) * (1 - (i + 1) / fade);
}
const wav = Buffer.from(encodeWav(channels, RATE));
mkdirSync(out, { recursive: true });
mkdirSync(pub, { recursive: true });
writeFileSync(new URL('soundtrack.wav', out), wav);
writeFileSync(new URL('soundtrack.wav', pub), wav);
// The beat markers: the sixteenth and the time of every note onset.
const onsets = [...new Set(notes.map((note) => note.at))].sort((a, b) => a - b);
writeFileSync(new URL('beats.txt', out), onsets.map((at) => `${at}\t${(at * SIXTEENTH).toFixed(4)}`).join('\n') + '\n');
process.stdout.write(`soundtrack: ${notes.length} notes, ${onsets.length} onsets, ${(length / RATE).toFixed(3)} s\n`);
