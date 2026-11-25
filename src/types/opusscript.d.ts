declare module 'opusscript' {
  class OpusScript {
    constructor(sampleRate?: number, channels?: number, application?: number);
    encode(pcm: Buffer): Buffer;
    decode(opus: Buffer): Buffer;
    delete(): void;
    static readonly Application: {
      readonly VOIP: number;
      readonly AUDIO: number;
      readonly RESTRICTED_LOWDELAY: number;
    };
  }
  export = OpusScript;
}
