// Pitch detection in the time domain: the normalized square difference function (NSDF) of the McLeod
// pitch method. It finds the period of a whistle or a hum, and it tells how clear that period is.

export type Pitch = { frequency: number; clarity: number };

// A low male hum is near 80 Hz. A high whistle stays below 4 kHz.
export const MIN_FREQUENCY = 70;
export const MAX_FREQUENCY = 4000;
// Quieter input is silence. 0.01 is -40 dB below full scale.
const MIN_RMS = 0.01;
// A clear tone has a clarity near 1. Noise, breath and speech stay lower.
const MIN_CLARITY = 0.9;
// The first peak at this share of the highest peak is the period. A later peak of the same height is a
// multiple of the period, so the first one prevents a result one octave too low.
const PEAK_SHARE = 0.9;

// The root mean square level of the samples: 0 for silence, about 0.71 for a full-scale sine.
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

// The buffer size for detectPitch: the smallest power of two (an AnalyserNode fftSize) that holds two
// periods of MIN_FREQUENCY.
export function bufferSize(sampleRate: number): number {
  if (!(sampleRate > 0)) throw new RangeError(`not a sample rate: ${sampleRate}`);
  return 2 ** Math.ceil(Math.log2(2 * Math.ceil(sampleRate / MIN_FREQUENCY) + 2));
}

// Returns null for silence, for noise, and for a tone outside MIN_FREQUENCY to MAX_FREQUENCY.
export function detectPitch(samples: Float32Array, sampleRate: number): Pitch | null {
  if (!(sampleRate > 0)) throw new RangeError(`not a sample rate: ${sampleRate}`);
  const size = samples.length;
  const minLag = Math.floor(sampleRate / MAX_FREQUENCY);
  const maxLag = Math.ceil(sampleRate / MIN_FREQUENCY);
  // The lowest frequency needs two periods in the buffer.
  if (minLag < 2 || size < 2 * maxLag + 2) throw new RangeError(`${size} samples at ${sampleRate} Hz are too few for pitch detection`);
  if (rms(samples) < MIN_RMS) return null;

  // nsdf[lag] = 2 r(lag) / m(lag), from -1 to 1. r is the autocorrelation, and m is the energy of the
  // two overlapping parts. m drops by two squares at each lag.
  const at = (index: number): number => samples[index] ?? 0;
  const nsdf = new Float64Array(maxLag + 2);
  let energy = 0;
  for (const sample of samples) energy += 2 * sample * sample;
  for (let lag = 0; lag < nsdf.length; lag++) {
    let correlation = 0;
    for (let index = 0; index + lag < size; index++) correlation += at(index) * at(index + lag);
    nsdf[lag] = energy > 0 ? (2 * correlation) / energy : 0;
    energy -= at(lag) ** 2 + at(size - 1 - lag) ** 2;
  }
  const value = (lag: number): number => nsdf[lag] ?? 0;

  // The key maxima: the highest point of each positive part, after the first negative value. The
  // positive part at lag 0 is the signal against itself, so it tells nothing.
  const peaks: number[] = [];
  let lag = 1;
  while (lag <= maxLag && value(lag) > 0) lag++;
  let peak: number | undefined;
  for (; lag <= maxLag; lag++) {
    if (value(lag) > 0) {
      if (peak === undefined || value(lag) > value(peak)) peak = lag;
    } else if (peak !== undefined) {
      peaks.push(peak);
      peak = undefined;
    }
  }
  if (peak !== undefined && peak < maxLag) peaks.push(peak);
  if (peaks.length === 0) return null;

  const highest = Math.max(...peaks.map(value));
  const period = peaks.find((candidate) => value(candidate) >= PEAK_SHARE * highest);
  if (period === undefined || period < minLag) return null;

  // A parabola through the peak and its two neighbours gives a period between two samples.
  const before = value(period - 1);
  const top = value(period);
  const after = value(period + 1);
  const curve = before - 2 * top + after;
  const shift = curve === 0 ? 0 : (before - after) / (2 * curve);
  const clarity = Math.min(1, top - ((before - after) * shift) / 4);
  if (clarity < MIN_CLARITY) return null;
  return { frequency: sampleRate / (period + shift), clarity };
}
