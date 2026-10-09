// Renders the sounds of a video with the game's own sound code in an OfflineAudioContext, into a WAV file:
// 44.1 kHz stereo, `seconds` long, the peak at -1 dBFS, and a fade to silence over the last 50 ms.
import { OfflineAudioContext } from 'node-web-audio-api';
import { SIXTEENTH } from '../../src/song.ts';
import { type ScheduledSound, scheduleNotes } from '../../src/sound.ts';
import { encodeWav } from '../../src/wav.ts';

const RATE = 44_100;
const FADE_SECONDS = 0.05;

// `at` of each sound counts sixteenths of the beat grid.
export async function mixdown(sounds: readonly ScheduledSound[], seconds: number): Promise<Buffer> {
  const length = Math.round(seconds * RATE);
  const ctx = new OfflineAudioContext(2, length, RATE);
  scheduleNotes(sounds.map((sound) => ({ ...sound, at: sound.at * SIXTEENTH })), ctx);
  const buffer = await ctx.startRendering();

  const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
  // The song mix plays as loud as a move in the game. A video plays louder: the peak goes to -1 dBFS.
  let peak = 0;
  for (const channel of channels) for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
  if (!(peak > 0)) throw new Error('the soundtrack is silent');
  const gain = 10 ** (-1 / 20) / peak;
  for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] = (channel[i] ?? 0) * gain;
  // The last 50 ms fade to silence, so the cut at the end does not click.
  const fade = Math.round(FADE_SECONDS * RATE);
  for (const channel of channels) {
    for (let i = 0; i < fade; i++) channel[length - fade + i] = (channel[length - fade + i] ?? 0) * (1 - (i + 1) / fade);
  }
  return Buffer.from(encodeWav(channels, RATE));
}
