// Optional, audible transfer of the reply after the first QR scan. ggwave supplies error-corrected
// data tones; a small game motif precedes them. Only explicit button presses open audio or the mic.
import type { GgWave } from 'ggwave';
import inputUrl from './sound-input-processor.ts?worker&url';
import { playPairingIntro } from '../sound.ts';
import { soundPackets, soundReply } from './sound-code.ts';
import { withPairingAudio } from './sound-audio.ts';

let modem: Promise<GgWave> | undefined;

async function loadModem(): Promise<GgWave> {
  modem ??= import('ggwave').then(({ default: factory }) => factory({ print: () => undefined, printErr: () => undefined })).then((loaded) => {
    loaded.disableLog();
    return loaded;
  }).catch((error: unknown) => {
    modem = undefined;
    throw error;
  });
  return modem;
}

function instance(gg: GgWave, rate: number): number {
  const parameters = gg.getDefaultParameters();
  parameters.sampleRateInp = rate;
  parameters.sampleRateOut = rate;
  parameters.sampleFormatInp = gg.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  parameters.sampleFormatOut = gg.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  const id = gg.init(parameters);
  if (id < 0) throw new Error('Sound pairing could not start. Try again or scan the reply.');
  return id;
}

async function playBuffer(context: AudioContext, samples: Float32Array<ArrayBuffer>, signal: AbortSignal, delay: number): Promise<void> {
  signal.throwIfAborted();
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  let aborted: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      aborted = () => {
        source.onended = null;
        source.stop();
        reject(signal.reason);
      };
      source.onended = () => {
        if (aborted !== undefined) signal.removeEventListener('abort', aborted);
        resolve();
      };
      signal.addEventListener('abort', aborted, { once: true });
      source.start(context.currentTime + delay);
    });
  } finally {
    if (aborted !== undefined) signal.removeEventListener('abort', aborted);
    source.onended = null;
    source.disconnect();
  }
}

export async function sendSoundReply(offer: string, answer: string, signal: AbortSignal, progress: (part: number, total: number) => void): Promise<void> {
  await withPairingAudio(signal, async (context, audio) => {
    const [gg, packets] = await Promise.all([loadModem(), soundPackets(offer, answer)]);
    audio.signal.throwIfAborted();
    const id = instance(gg, context.sampleRate);
    try {
      audio.start();
      playPairingIntro(context);
      for (const [i, packet] of packets.entries()) {
        audio.signal.throwIfAborted();
        // The module reuses its heap. Copy the waveform before the next encode/decode call.
        const bytes = Uint8Array.from(gg.encode(id, packet, gg.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 30));
        if (bytes.length === 0 || bytes.length % 4 !== 0) throw new Error('The sound reply could not be made. Scan the reply instead.');
        progress(i + 1, packets.length);
        await playBuffer(context, new Float32Array(bytes.buffer), audio.signal, i === 0 ? 0.3 : 0.2);
      }
    } finally {
      gg.free(id);
    }
  });
}

export async function listenForSoundReply(offer: string, signal: AbortSignal, progress: (received: number, total: number) => void): Promise<string> {
  return withPairingAudio(signal, async (context, audio) => {
    const bounded = audio.signal;
    if (navigator.mediaDevices?.getUserMedia === undefined || context.audioWorklet === undefined) {
      throw new Error('Sound pairing needs microphone access on HTTPS. Scan the reply instead.');
    }
    const [gg, collect] = await Promise.all([loadModem(), soundReply(offer, progress), context.audioWorklet.addModule(inputUrl)]);
    bounded.throwIfAborted();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    const tracks = stream.getTracks();
    const closeMic = () => { for (const track of stream.getTracks()) track.stop(); };
    let listening = false;
    const ended = () => audio.interrupt(new Error('Microphone was interrupted. Try again or scan the reply.'));
    const muted = () => { if (listening) ended(); };
    for (const track of tracks) {
      track.addEventListener('ended', ended);
      track.addEventListener('mute', muted);
    }
    let id: number | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let reader: AudioWorkletNode | undefined;
    let silent: GainNode | undefined;
    let aborted: (() => void) | undefined;
    bounded.addEventListener('abort', closeMic, { once: true });
    try {
      bounded.throwIfAborted();
      // Starting iOS microphone capture can interrupt the context that was unlocked by the tap.
      if (context.state !== 'running') await audio.resume();
      if (tracks.some((track) => track.readyState === 'ended')) ended();
      bounded.throwIfAborted();
      id = instance(gg, context.sampleRate);
      const current = id;
      source = context.createMediaStreamSource(stream);
      reader = new AudioWorkletNode(context, 'tick3d-sound-input');
      silent = context.createGain();
      silent.gain.value = 0;
      source.connect(reader).connect(silent).connect(context.destination);
      audio.start();
      listening = true;
      progress(0, 0);
      return await new Promise<string>((resolve, reject) => {
        aborted = () => reject(bounded.reason);
        bounded.addEventListener('abort', aborted, { once: true });
        reader!.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (bounded.aborted) return;
          try {
            const samples = event.data;
            const decoded = gg.decode(current, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
            if (decoded.length === 0) return;
            void collect(Uint8Array.from(decoded)).then((code) => {
              if (code === undefined || bounded.aborted) return;
              if (aborted !== undefined) bounded.removeEventListener('abort', aborted);
              resolve(code);
            }, reject);
          } catch (error) {
            if (aborted !== undefined) bounded.removeEventListener('abort', aborted);
            reject(error);
          }
        };
      });
    } finally {
      if (aborted !== undefined) bounded.removeEventListener('abort', aborted);
      bounded.removeEventListener('abort', closeMic);
      for (const track of tracks) {
        track.removeEventListener('ended', ended);
        track.removeEventListener('mute', muted);
      }
      closeMic();
      if (reader !== undefined) reader.port.onmessage = null;
      source?.disconnect();
      reader?.disconnect();
      silent?.disconnect();
      if (id !== undefined) gg.free(id);
    }
  }, 120_000);
}
