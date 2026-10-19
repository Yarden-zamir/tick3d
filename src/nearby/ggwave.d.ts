declare module 'ggwave' {
  export type Parameters = {
    payloadLength: number;
    sampleRateInp: number;
    sampleRateOut: number;
    sampleRate: number;
    samplesPerFrame: number;
    soundMarkerThreshold: number;
    sampleFormatInp: unknown;
    sampleFormatOut: unknown;
    operatingMode: number;
  };
  export type GgWave = {
    getDefaultParameters(): Parameters;
    init(parameters: Parameters): number;
    free(instance: number): void;
    encode(instance: number, payload: Uint8Array, protocol: unknown, volume: number): Uint8Array;
    decode(instance: number, samples: Uint8Array): Uint8Array;
    disableLog(): void;
    SampleFormat: { GGWAVE_SAMPLE_FORMAT_F32: unknown };
    ProtocolId: { GGWAVE_PROTOCOL_AUDIBLE_FASTEST: unknown };
  };
  export default function factory(options?: { print?: (text: string) => void; printErr?: (text: string) => void }): Promise<GgWave>;
}
