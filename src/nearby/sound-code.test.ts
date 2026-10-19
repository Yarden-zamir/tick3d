import factory from 'ggwave';
import { describe, expect, it, vi } from 'vitest';
import { canSendSoundReply, soundPackets, soundReply } from './sound-code.ts';

const offer = 'T3A1.this-is-the-current-offer';
const answer = (length = 180) => 'T3B1.' + btoa(String.fromCharCode(...Array.from({ length }, (_, i) => (i * 73 + 19) & 255))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

describe('sound reply packets', () => {
  it('preflights sound availability before offering the send control', () => {
    expect(canSendSoundReply(answer(180))).toBe(true);
    expect(canSendSoundReply(answer(768))).toBe(true);
    expect(canSendSoundReply(answer(769))).toBe(false);
    expect(canSendSoundReply(answer(1100))).toBe(false);
    expect(canSendSoundReply('T3A1.wrong-direction')).toBe(false);
    expect(canSendSoundReply('T3B1.A')).toBe(false);
  });

  it('does not let a forged first reply id block a genuine complete reply', async () => {
    const packets = await soundPackets(offer, answer());
    const forged = Uint8Array.from(packets[0]!);
    forged[12] = (forged[12] ?? 0) ^ 1;
    const collect = await soundReply(offer, vi.fn());
    expect(await collect(forged)).toBeUndefined();
    expect(await collect(packets[0]!)).toBeUndefined();
    expect(await collect(packets[1]!)).toBe(answer());
    expect(await collect(packets[1]!)).toBeUndefined();
  });

  it('reassembles out-of-order and duplicate parts into the original reply', async () => {
    const code = answer(220);
    const packets = await soundPackets(offer, code);
    const progress = vi.fn();
    const collect = await soundReply(offer, progress);
    expect(packets).toHaveLength(3);
    expect(packets.every((part) => part.length <= 120)).toBe(true);
    expect(await collect(packets[2]!)).toBeUndefined();
    expect(await collect(packets[0]!)).toBeUndefined();
    expect(await collect(packets[0]!)).toBeUndefined();
    expect(await collect(packets[1]!)).toBe(code);
    expect(progress).toHaveBeenCalledTimes(3);
  });

  it('ignores replies for other offers, including expired invites', async () => {
    const progress = vi.fn();
    const collect = await soundReply('T3A1.a-different-invite', progress);
    for (const part of await soundPackets(offer, answer())) expect(await collect(part)).toBeUndefined();
    expect(progress).not.toHaveBeenCalled();
  });

  it('does not combine parts from two replies', async () => {
    const first = await soundPackets(offer, answer(180));
    const second = await soundPackets(offer, answer(190));
    const collect = await soundReply(offer, vi.fn());
    expect(await collect(first[0]!)).toBeUndefined();
    expect(await collect(second[1]!)).toBeUndefined();
    expect(await collect(first[1]!)).toBe(answer(180));
  });

  it('checks the full reply fingerprint and accepts a clean retry after corruption', async () => {
    const packets = await soundPackets(offer, answer());
    const damaged = Uint8Array.from(packets[0]!);
    damaged[24] = (damaged[24] ?? 0) ^ 1;
    const collect = await soundReply(offer, vi.fn());
    expect(await collect(damaged)).toBeUndefined();
    expect(await collect(packets[1]!)).toBeUndefined();
    expect(await collect(packets[0]!)).toBeUndefined();
    expect(await collect(packets[1]!)).toBe(answer());
  });

  it('bounds the payload and ignores malformed packet headers', async () => {
    await expect(soundPackets(offer, answer(769))).rejects.toThrow('too long');
    await expect(soundPackets(offer, 'T3A1.wrong-direction')).rejects.toThrow('not a Wi-Fi reply');
    const collect = await soundReply(offer, vi.fn());
    expect(await collect(new Uint8Array(100_000))).toBeUndefined();
    const [part] = await soundPackets(offer, answer(10));
    part![21] = 255;
    expect(await collect(part!)).toBeUndefined();
  });
});

it.each([44100, 48000])('transfers a multi-packet reply with %i Hz hardware resampling, gain loss and noise', async (rate) => {
  const gg = await factory({ print: () => undefined, printErr: () => undefined });
  gg.disableLog();
  const parameters = gg.getDefaultParameters();
  parameters.sampleFormatInp = gg.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  parameters.sampleFormatOut = gg.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  const tx = gg.init(parameters);
  const rx = gg.init(parameters);
  const code = answer(220);
  const collect = await soundReply(offer, vi.fn());
  let received: string | undefined;
  try {
    for (const part of await soundPackets(offer, code)) {
      let wave = new Float32Array(Uint8Array.from(gg.encode(tx, part, gg.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 30)).buffer);
      if (rate !== 48000) {
        const resample = (input: Float32Array, from: number, to: number) => Float32Array.from({ length: Math.round(input.length * to / from) }, (_, i) => {
          const at = i * from / to;
          const index = Math.floor(at);
          const fraction = at - index;
          return (input[index] ?? 0) * (1 - fraction) + (input[index + 1] ?? 0) * fraction;
        });
        wave = resample(resample(wave, 48000, rate), rate, 48000);
      }
      for (let i = 0; i < wave.length; i++) wave[i] = (wave[i] ?? 0) * 0.6 + 0.002 * Math.sin(i * 1.71);
      for (let at = 0; at < wave.length; at += 2048) {
        const samples = wave.subarray(at, at + 2048);
        const decoded = gg.decode(rx, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
        if (decoded.length > 0) received = await collect(Uint8Array.from(decoded));
      }
    }
    expect(received).toBe(code);
  } finally {
    gg.free(tx);
    gg.free(rx);
  }
});
