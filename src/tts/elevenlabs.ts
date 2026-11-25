import { ttsConfig } from '../config.js';
import { log } from '../log.js';
import { RetryableError, retryAfterFromHeaders, withRetry } from '../util/retry.js';
import type { SynthesizedAudio } from './types.js';

const ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech';
const OGG_MAGIC = Buffer.from('OggS', 'ascii');
/** Parameter `language_code` hanya diterima model turbo/flash (v2.5). */
const LANGUAGE_AWARE = /turbo|flash|v2_5/;

export function elevenLabsConfigured(): boolean {
  const { elevenLabs } = ttsConfig();
  return Boolean(elevenLabs.apiKey && elevenLabs.voiceId);
}

async function requestTts(text: string, outputFormat: string): Promise<Buffer> {
  const config = ttsConfig().elevenLabs;
  const body: Record<string, unknown> = {
    text,
    model_id: config.model,
    voice_settings: {
      stability: config.stability,
      similarity_boost: config.similarity,
      use_speaker_boost: true,
    },
  };
  if (config.language && LANGUAGE_AWARE.test(config.model)) body.language_code = config.language;

  const url = `${ENDPOINT}/${encodeURIComponent(config.voiceId)}?output_format=${outputFormat}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': config.apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/*',
    },
    body: JSON.stringify(body),
  });

  if (response.status === 429 || response.status >= 500) {
    throw new RetryableError(
      `ElevenLabs TTS HTTP ${response.status}`,
      retryAfterFromHeaders(response.headers),
    );
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `ElevenLabs TTS HTTP ${response.status}: ${detail.slice(0, 300)}${
        response.status === 401 ? ' (cek ELEVENLABS_API_KEY)' : ''
      }`,
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    throw new Error(`ElevenLabs mengembalikan JSON, bukan audio: ${await response.text()}`);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) throw new Error('ElevenLabs mengembalikan audio kosong');
  return audio;
}

/**
 * ElevenLabs mengembalikan Ogg/Opus 48 kHz (langsung diputar) atau PCM mentah
 * 48 kHz mono, yang di-encode lokal oleh playback layer. Tanpa ffmpeg.
 */
export async function synthesizeElevenLabs(text: string): Promise<SynthesizedAudio> {
  const opus = await withRetry('elevenlabs-tts', () => requestTts(text, 'opus_48000_128'));
  if (opus.subarray(0, 4).equals(OGG_MAGIC)) {
    log.debug(`elevenlabs-tts: opus/ogg ${opus.length} byte`);
    return { container: 'ogg', data: opus };
  }

  log.warn('elevenlabs-tts: respons opus bukan kontainer Ogg — fallback ke PCM');
  const pcm = await withRetry('elevenlabs-tts-pcm', () => requestTts(text, 'pcm_48000'));
  if (pcm.subarray(0, 4).equals(OGG_MAGIC)) return { container: 'ogg', data: pcm };
  if (pcm.length % 2 !== 0) throw new Error('ElevenLabs PCM tidak valid (byte ganjil)');
  log.debug(`elevenlabs-tts: pcm ${pcm.length} byte`);
  return { container: 'pcm', data: pcm };
}
