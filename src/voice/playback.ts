import { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  StreamType,
  createAudioResource,
  type AudioPlayer,
  type AudioResource,
} from '@discordjs/voice';
import OpusScript from 'opusscript';
import { log } from '../log.js';
import type { SynthesizedAudio } from '../tts/types.js';
import { EchoFilter } from './echo.js';

const FRAME_SAMPLES = 960; // 20 ms @ 48 kHz
const FRAME_BYTES = FRAME_SAMPLES * 2; // mono s16le

/** Opus / Ogg-Opus sudah siap diputar; PCM mentah di-encode lokal (tanpa ffmpeg). */
function buildResource(audio: SynthesizedAudio): AudioResource {
  if (audio.container === 'ogg') {
    const stream = new Readable({
      read() {
        this.push(audio.data);
        this.push(null);
      },
    });
    return createAudioResource(stream, { inputType: StreamType.OggOpus });
  }

  const encoder = new OpusScript(48_000, 1, OpusScript.Application.AUDIO);
  const packets: Buffer[] = [];
  try {
    for (let offset = 0; offset + FRAME_BYTES <= audio.data.length; offset += FRAME_BYTES) {
      const frame = audio.data.subarray(offset, offset + FRAME_BYTES);
      packets.push(Buffer.from(encoder.encode(frame, FRAME_SAMPLES)));
    }
  } finally {
    encoder.delete();
  }
  if (packets.length === 0) throw new Error('PCM terlalu pendek untuk di-encode');

  return createAudioResource(Readable.from(packets, { objectMode: true }), {
    inputType: StreamType.Opus,
  });
}

interface QueueItem {
  audio: SynthesizedAudio;
  /** Teks yang dibacakan, dipakai untuk mengenali gema dari mic. */
  text: string;
}

export class PlaybackQueue {
  private items: QueueItem[] = [];
  private speaking = false;
  private readonly echo = new EchoFilter();

  constructor(
    private readonly player: AudioPlayer,
    private readonly maxQueue: number,
  ) {
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.speaking = false;
      this.next();
    });
    this.player.on('error', (error) => {
      log.error('audio player:', error.message);
      this.speaking = false;
      this.next();
    });
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  get pending(): number {
    return this.items.length;
  }

  isEcho(transcript: string): boolean {
    return this.echo.matches(transcript);
  }

  enqueue(audio: SynthesizedAudio, text: string): void {
    if (this.items.length >= this.maxQueue) {
      log.warn(`antrean TTS penuh (${this.maxQueue}), balasan dibuang`);
      return;
    }
    this.items.push({ audio, text });
    this.next();
  }

  /** Jeda singkat untuk mengecek apakah yang terdengar gema TTS atau manusia. */
  pause(): void {
    if (this.speaking) this.player.pause();
  }

  resume(): void {
    if (this.speaking) this.player.unpause();
  }

  stopAll(): void {
    this.items = [];
    if (this.speaking) {
      this.speaking = false;
      this.player.stop(true);
    }
  }

  private next(): void {
    if (this.speaking) return;
    const item = this.items.shift();
    if (!item) return;

    try {
      this.speaking = true;
      this.echo.remember(item.text);
      this.player.play(buildResource(item.audio));
    } catch (error) {
      this.speaking = false;
      log.error('gagal memutar TTS:', (error as Error).message);
      this.next();
    }
  }
}
