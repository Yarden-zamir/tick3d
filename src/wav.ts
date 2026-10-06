// A WAV file from audio samples: 16-bit PCM, the channels interleaved. Stereo at 44.1 kHz is about
// 176 kB per second, so a song of 20 seconds is about 3.5 MB.

const HEADER_BYTES = 44;

export function encodeWav(channels: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  const first = channels[0];
  if (first === undefined) throw new RangeError('a WAV file needs a channel');
  if (channels.some((channel) => channel.length !== first.length)) throw new RangeError('the channels differ in length');
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError(`not a sample rate: ${sampleRate}`);
  const frameBytes = 2 * channels.length;
  const dataBytes = first.length * frameBytes;
  const view = new DataView(new ArrayBuffer(HEADER_BYTES + dataBytes));
  const text = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); // The size of the format block.
  view.setUint16(20, 1, true); // PCM.
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * frameBytes, true); // Bytes per second.
  view.setUint16(32, frameBytes, true);
  view.setUint16(34, 16, true); // Bits per sample.
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = HEADER_BYTES;
  for (let frame = 0; frame < first.length; frame++) {
    for (const channel of channels) {
      // Clip to -1..1, then scale to the 16-bit range.
      const sample = Math.max(-1, Math.min(1, channel[frame] ?? 0));
      view.setInt16(offset, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
      offset += 2;
    }
  }
  return view.buffer;
}
