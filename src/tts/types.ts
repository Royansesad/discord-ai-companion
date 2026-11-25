/** Opus/Ogg siap diputar, atau PCM mono 48 kHz yang di-encode lokal oleh playback. */
export type SynthesizedAudio =
  | { container: 'ogg'; data: Buffer }
  | { container: 'pcm'; data: Buffer };
