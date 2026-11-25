import { ttsConfig } from '../config.js';
import { log } from '../log.js';
import { chargeSpeech, reserveSpeech, speechBudget } from './budget.js';
import { elevenLabsConfigured, synthesizeElevenLabs } from './elevenlabs.js';
import { synthesizeFish } from './fish.js';
import type { SynthesizedAudio } from './types.js';

export { TtsBudgetError, speechBudget } from './budget.js';
export type { SynthesizedAudio } from './types.js';

type ProviderName = 'fish' | 'elevenlabs';

function fishConfigured(): boolean {
  return Boolean(process.env.FISH_API_KEY?.trim());
}

/** Provider pilihan dulu, lalu cadangan — hanya yang key-nya terisi. */
function providerOrder(): ProviderName[] {
  const preferred = ttsConfig().provider;
  const order: ProviderName[] =
    preferred === 'fish' ? ['fish', 'elevenlabs'] : ['elevenlabs', 'fish'];
  return order.filter((name) => (name === 'fish' ? fishConfigured() : elevenLabsConfigured()));
}

export function assertTtsConfig(): void {
  if (providerOrder().length === 0) {
    throw new Error(
      'Tidak ada provider TTS yang siap. Isi ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID, atau FISH_API_KEY.',
    );
  }
}

export function ttsStatus(): {
  providers: string[];
  limit: number;
  used: number;
  remaining: number;
} {
  const { limit, used, remaining } = speechBudget();
  return { providers: providerOrder(), limit, used, remaining };
}

/**
 * Sintesis dengan urutan provider + anggaran karakter harian. Anggaran dicek
 * sebelum request supaya kuota tidak habis di tengah kalimat.
 */
export async function synthesize(text: string): Promise<SynthesizedAudio> {
  reserveSpeech(text.length);

  const providers = providerOrder();
  if (providers.length === 0) throw new Error('Tidak ada provider TTS yang siap');

  let lastError: unknown;
  for (const provider of providers) {
    try {
      const audio =
        provider === 'elevenlabs' ? await synthesizeElevenLabs(text) : await synthesizeFish(text);
      chargeSpeech(text.length);
      log.debug(`tts[${provider}]: ${text.length} karakter`);
      return audio;
    } catch (error) {
      lastError = error;
      log.warn(`tts[${provider}] gagal:`, (error as Error).message);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('TTS tidak tersedia');
}
