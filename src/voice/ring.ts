// A ring buffer of audio samples: it keeps the newest `capacity` samples. The voice engine keeps the last
// seconds of the microphone in it for a replay (engine.ts, clip). It lives in memory only.
export type Ring = {
  push(samples: Float32Array): void;
  // A copy of the newest `count` samples, oldest first. Fewer when the ring holds fewer. A count that is
  // not a finite number of 0 or more throws a RangeError.
  last(count: number): Float32Array<ArrayBuffer>;
};

export function createRing(capacity: number): Ring {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`not a ring size: ${capacity}`);
  const buffer = new Float32Array(capacity);
  // The index of the next write, and how many samples the ring holds.
  let next = 0;
  let size = 0;
  return {
    push(samples) {
      // Only the newest `capacity` samples of a long push can stay.
      const from = Math.max(0, samples.length - capacity);
      for (let i = from; i < samples.length; i++) {
        buffer[next] = samples[i] ?? 0;
        next = (next + 1) % capacity;
      }
      size = Math.min(capacity, size + samples.length - from);
    },
    last(count) {
      if (!Number.isFinite(count) || count < 0) throw new RangeError(`not a sample count: ${count}`);
      const length = Math.max(0, Math.min(Math.floor(count), size));
      const copy = new Float32Array(length);
      const start = (next - length + capacity) % capacity;
      for (let i = 0; i < length; i++) copy[i] = buffer[(start + i) % capacity] ?? 0;
      return copy;
    }
  };
}
