import { groqConfig } from '../config.js';
import { log } from '../log.js';
import { RetryableError, retryAfterFromHeaders, withRetry } from '../util/retry.js';

const NOISE_PATTERNS = [
  /^(terima kasih( telah)? menonton\.?|thanks? for watching\.?)$/i,
  /^(silahkan berlangganan|subscribe to my channel)/i,
  /^[\s.,!?-]*$/,
  /^(musik|music|musik latar|\[musik\])$/i,
];

/** Buang hasil transkrip kosong / halusinasi Whisper yang umum. */
function cleanTranscript(text: string, minChars = 2): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length < minChars) return '';
  if (NOISE_PATTERNS.some((pattern) => pattern.test(trimmed))) return '';
  return trimmed;
}

/** Transkrip WAV mono 48 kHz lewat Groq Whisper. */
export async function transcribe(wav: Buffer): Promise<string> {
  const config = groqConfig();
  const text = await withRetry('groq-stt', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav');
    form.append('model', config.model);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (config.language) form.append('language', config.language);

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
    });

    if (response.status === 429 || response.status >= 500) {
      throw new RetryableError(
        `Groq STT HTTP ${response.status}`,
        retryAfterFromHeaders(response.headers),
      );
    }
    if (!response.ok) {
      throw new Error(`Groq STT HTTP ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as { text?: string };
    return (payload.text ?? '').trim();
  });

  log.debug(`groq-stt: "${text}"`);
  return cleanTranscript(text);
}
