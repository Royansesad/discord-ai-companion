/** Discord mengirim audio Opus 48 kHz; setelah decode hasilnya PCM s16le stereo. */
export const SAMPLE_RATE = 48_000;
export const BYTES_PER_SAMPLE = 2;

/** Downmix PCM s16le stereo -> mono s16le. */
export function downmixToMono(stereo: Buffer): Buffer {
  const frames = Math.floor(stereo.length / 4);
  const mono = Buffer.allocUnsafe(frames * BYTES_PER_SAMPLE);
  for (let frame = 0; frame < frames; frame += 1) {
    const left = stereo.readInt16LE(frame * 4);
    const right = stereo.readInt16LE(frame * 4 + 2);
    mono.writeInt16LE((left + right) >> 1, frame * BYTES_PER_SAMPLE);
  }
  return mono;
}

/** Bungkus PCM mono s16le menjadi WAV (header 44 byte) tanpa library eksternal. */
export function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * BYTES_PER_SAMPLE;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** PCM stereo dari Discord -> WAV mono siap kirim ke Groq. */
export function utteranceToWav(stereoPcm: Buffer): { wav: Buffer; durationMs: number } {
  const mono = downmixToMono(stereoPcm);
  const durationMs = Math.round((mono.length / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000);
  return { wav: pcmToWav(mono), durationMs };
}
