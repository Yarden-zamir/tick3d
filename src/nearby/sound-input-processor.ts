// The microphone is read on the audio thread, not animation frames (which can skip PCM samples).
declare const AudioWorkletProcessor: { new(): { port: MessagePort } };
declare function registerProcessor(name: string, processor: typeof NearbySoundInput): void;

class NearbySoundInput extends AudioWorkletProcessor {
  private pending = new Float32Array(2048);
  private used = 0;

  process(inputs: Float32Array[][]): boolean {
    const samples = inputs[0]?.[0];
    if (samples === undefined) return true;
    let at = 0;
    while (at < samples.length) {
      const count = Math.min(samples.length - at, this.pending.length - this.used);
      this.pending.set(samples.subarray(at, at + count), this.used);
      at += count;
      this.used += count;
      if (this.used === this.pending.length) {
        this.port.postMessage(this.pending, [this.pending.buffer]);
        this.pending = new Float32Array(2048);
        this.used = 0;
      }
    }
    return true;
  }
}

registerProcessor('tick3d-sound-input', NearbySoundInput);
