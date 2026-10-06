import { describe, expect, it } from 'vitest';
import { encodeWav } from './wav.ts';

const ascii = (view: DataView, offset: number, length: number) =>
  String.fromCharCode(...Array.from({ length }, (_, index) => view.getUint8(offset + index)));

describe('encodeWav', () => {
  const left = Float32Array.from([0, 0.5, -1, 1, 2]);
  const right = Float32Array.from([0, -0.5, 1, -1, -2]);
  const view = new DataView(encodeWav([left, right], 44_100));

  it('writes a RIFF WAVE header for 16-bit PCM with the channels and the sample rate', () => {
    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(ascii(view, 8, 8)).toBe('WAVEfmt ');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint32(28, true)).toBe(44_100 * 4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(view, 36, 4)).toBe('data');
  });

  it('sizes the file by its samples', () => {
    expect(view.getUint32(40, true)).toBe(5 * 2 * 2);
    expect(view.byteLength).toBe(44 + 5 * 2 * 2);
    expect(view.getUint32(4, true)).toBe(view.byteLength - 8);
  });

  it('interleaves the channels and clips the samples to the 16-bit range', () => {
    const samples = Array.from({ length: 10 }, (_, index) => view.getInt16(44 + index * 2, true));
    expect(samples).toEqual([0, 0, 16_384, -16_384, -32_768, 32_767, 32_767, -32_768, 32_767, -32_768]);
  });

  it('refuses channels of different lengths and no channels', () => {
    expect(() => encodeWav([left, Float32Array.from([0])], 44_100)).toThrow(RangeError);
    expect(() => encodeWav([], 44_100)).toThrow(RangeError);
  });
});
