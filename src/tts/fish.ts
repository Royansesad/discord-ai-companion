import { fishConfig } from '../config.js';
import { log } from '../log.js';
import { RetryableError, retryAfterFromHeaders, withRetry } from '../util/retry.js';
import type { SynthesizedAudio } from './types.js';

const ENDPOINT = 'https://api.fish.audio/v1/tts';
const OGG_MAGIC = Buffer.from('OggS', 'ascii');

type FishFormat = 'opus' | 'pcm';

async function requestTts(text: string, format: FishFormat): Promise<Buffer> {
  const config = fishConfig();
  const body: Record<string, unknown> = {
    text,
    format,
    latency: config.latency,
    chunk_length: 200,
  };
  if (config.voiceId) body.reference_id = config.voiceId;
  if (format === 'pcm') {
    body.sample_rate = 48_000;
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      model: config.model,
    },
    body: JSON.stringify(body),
  });

  if (response.status === 429 || response.status >= 500) {
    throw new RetryableError(`fish.audio HTTP ${response.status}`, retryAfterFromHeaders(response.headers));
  }
  if (!response.ok) {
    throw new Error(`fish.audio HTTP ${response.status}: ${await response.text()}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    throw new Error(`fish.audio mengembalikan JSON, bukan audio: ${await response.text()}`);
  }

  const data = Buffer.from(await response.arrayBuffer());
  if (data.length === 0) throw new Error('fish.audio mengembalikan audio kosong');
  return data;
}

/**
 * Ambil audio TTS. Utamakan Opus 48 kHz (bisa langsung diputar tanpa decoder),
 * dan kalau server tidak mengirim kontainer Ogg, jatuh ke PCM mentah yang
 * di-encode lokal oleh playback layer.
 */
export async function synthesizeFish(text: string): Promise<SynthesizedAudio> {
  const opus = await withRetry('fish-tts', () => requestTts(text, 'opus'));
  if (opus.subarray(0, 4).equals(OGG_MAGIC)) {
    log.debug(`fish-tts: opus/ogg ${opus.length} byte`);
    return { container: 'ogg', data: opus };
  }

  log.warn('fish-tts: respons opus bukan kontainer Ogg — fallback ke PCM');
  const pcm = await withRetry('fish-tts-pcm', () => requestTts(text, 'pcm'));
  if (pcm.subarray(0, 4).equals(OGG_MAGIC)) {
    return { container: 'ogg', data: pcm };
  }
  if (pcm.length % 2 !== 0) throw new Error('fish.audio PCM tidak valid (byte ganjil)');
  log.debug(`fish-tts: pcm ${pcm.length} byte`);
  return { container: 'pcm', data: pcm };
}
