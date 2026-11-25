const debugEnabled = (process.env.DEBUG ?? '').toLowerCase() === 'true';

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export const log = {
  info(...args: unknown[]): void {
    console.log(`[${stamp()}]`, ...args);
  },
  warn(...args: unknown[]): void {
    console.warn(`[${stamp()}] WARN`, ...args);
  },
  error(...args: unknown[]): void {
    console.error(`[${stamp()}] ERROR`, ...args);
  },
  debug(...args: unknown[]): void {
    if (debugEnabled) console.log(`[${stamp()}] debug`, ...args);
  },
};
