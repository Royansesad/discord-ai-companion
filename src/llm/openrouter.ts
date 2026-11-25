import { openRouterConfig } from '../config.js';
import { log } from '../log.js';
import { RetryableError, retryAfterFromHeaders, withRetry } from '../util/retry.js';

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

interface CompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string; code?: number | string };
}

/**
 * Panggil OpenRouter. Model pertama yang berhasil dipakai; fallback hanya diisi
 * model murah / :free supaya percakapan tidak pernah menagih model mahal.
 */
export async function chat(messages: ChatMessage[], maxTokens = 220): Promise<string> {
  const config = openRouterConfig();
  const models = [config.model, ...config.fallbackModels].filter(Boolean);
  let lastError: unknown;

  for (const model of models) {
    try {
      const reply = await withRetry(`openrouter:${model}`, async () => {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'X-Title': 'discord-ai-companion',
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens,
            temperature: 0.8,
            stream: false,
          }),
        });

        if (response.status === 429 || response.status >= 500) {
          throw new RetryableError(
            `OpenRouter HTTP ${response.status}`,
            retryAfterFromHeaders(response.headers),
          );
        }

        const payload = (await response.json()) as CompletionResponse;
        if (!response.ok) {
          throw new Error(payload.error?.message ?? `OpenRouter HTTP ${response.status}`);
        }

        const content = payload.choices?.[0]?.message?.content?.trim() ?? '';
        if (!content) throw new Error('OpenRouter mengembalikan balasan kosong');
        return content;
      });
      log.debug(`openrouter[${model}]: ${reply.slice(0, 120)}`);
      return reply;
    } catch (error) {
      lastError = error;
      log.warn(`openrouter[${model}] gagal:`, (error as Error).message);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('OpenRouter tidak tersedia');
}

/**
 * Rangkum percakapan lama jadi catatan memori pendek. Dipanggil jarang (saat
 * riwayat dipangkas) supaya kuota gratis tidak habis untuk ini.
 */
export async function summarize(
  turns: { role: ChatRole; content: string }[],
  previous: string,
): Promise<string> {
  const transcript = turns.map((turn) => `${turn.role}: ${turn.content}`).join('\n');
  const prompt = [
    previous ? `Catatan sebelumnya:\n${previous}\n` : '',
    `Percakapan terbaru:\n${transcript}`,
    '',
    'Tulis ulang catatan memori: maksimal 80 kata, bahasa Indonesia, poin penting saja',
    '(siapa yang dibicarakan, topik, preferensi, kesepakatan). Jangan menambah cerita baru.',
  ]
    .filter(Boolean)
    .join('\n');

  return chat(
    [
      { role: 'system', content: 'Kamu merangkum percakapan voice menjadi catatan memori singkat.' },
      { role: 'user', content: prompt },
    ],
    200,
  );
}
