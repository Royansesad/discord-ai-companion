import { ttsConfig } from '../config.js';
import { addTtsUsage, ttsUsage } from '../store.js';

export class TtsBudgetError extends Error {
  constructor(
    readonly limit: number,
    readonly used: number,
  ) {
    super(
      `Anggaran suara harian habis (${used}/${limit} karakter). Naikkan TTS_DAILY_CHAR_LIMIT atau tunggu besok.`,
    );
    this.name = 'TtsBudgetError';
  }
}

/** Cek anggaran sebelum memanggil provider; limit 0 berarti tanpa batas. */
export function reserveSpeech(chars: number): void {
  const { dailyCharLimit } = ttsConfig();
  const { chars: used } = ttsUsage();
  if (dailyCharLimit > 0 && used + chars > dailyCharLimit) {
    throw new TtsBudgetError(dailyCharLimit, used);
  }
}

export function chargeSpeech(chars: number): void {
  addTtsUsage(chars);
}

export function speechBudget(): { limit: number; used: number; remaining: number } {
  const { dailyCharLimit } = ttsConfig();
  const { chars } = ttsUsage();
  return {
    limit: dailyCharLimit,
    used: chars,
    remaining: dailyCharLimit > 0 ? Math.max(0, dailyCharLimit - chars) : -1,
  };
}
