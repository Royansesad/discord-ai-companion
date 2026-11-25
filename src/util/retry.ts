import { log } from '../log.js';

export class RetryableError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'RetryableError';
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse `Retry-After` (seconds) / `x-ratelimit-reset-after` into milliseconds. */
export function retryAfterFromHeaders(headers: Headers): number | undefined {
  for (const name of ['retry-after', 'x-ratelimit-reset-after']) {
    const raw = headers.get(name);
    if (!raw) continue;
    const seconds = Number.parseFloat(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  }
  return undefined;
}

export async function withRetry<T>(
  label: string,
  run: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof RetryableError;
      if (!retryable || attempt === attempts) break;
      const delay = error.retryAfterMs ?? 500 * 2 ** (attempt - 1);
      log.warn(`${label}: ${error.message} — percobaan ulang ${attempt}/${attempts} dalam ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}
