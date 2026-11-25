import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { storeConfig } from './config.js';
import { log } from './log.js';

export interface StoredTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface GuildMemory {
  summary: string;
  turns: StoredTurn[];
}

export interface GuildSettings {
  persona?: string;
  mode?: 'auto' | 'mention';
  transcript?: boolean;
  memory?: GuildMemory;
}

/** Pemakaian OpenRouter hari ini (tanggal UTC). */
export interface LlmUsage {
  day: string;
  requests: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
}

interface StateFile {
  version: 1;
  guilds: Record<string, GuildSettings>;
  tts: { day: string; chars: number };
  llm: LlmUsage;
}

function emptyLlmUsage(): LlmUsage {
  return { day: '', requests: 0, failures: 0, promptTokens: 0, completionTokens: 0 };
}

function emptyState(): StateFile {
  return { version: 1, guilds: {}, tts: { day: '', chars: 0 }, llm: emptyLlmUsage() };
}

let state: StateFile | null = null;
let writeTimer: NodeJS.Timeout | null = null;

function load(): StateFile {
  if (state) return state;
  try {
    const parsed = JSON.parse(readFileSync(storeConfig().file, 'utf8')) as Partial<StateFile>;
    state = {
      version: 1,
      guilds: parsed.guilds ?? {},
      tts: { day: parsed.tts?.day ?? '', chars: parsed.tts?.chars ?? 0 },
      llm: { ...emptyLlmUsage(), ...(parsed.llm ?? {}) },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('state tidak bisa dibaca, mulai dari kosong:', (error as Error).message);
    }
    state = emptyState();
  }
  return state;
}

function flush(): void {
  const file = storeConfig().file;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(load(), null, 2));
    renameSync(tmp, file);
  } catch (error) {
    log.warn('gagal menyimpan state:', (error as Error).message);
  }
}

/** Tulisan ditunda sebentar supaya beberapa update beruntun hanya jadi satu write. */
function schedule(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flush();
  }, 500);
  writeTimer.unref();
}

export function getGuildSettings(guildId: string): GuildSettings {
  return load().guilds[guildId] ?? {};
}

/** Patch pengaturan guild; nilai `undefined` menghapus field (mis. memori). */
export function updateGuildSettings(guildId: string, patch: Partial<GuildSettings>): GuildSettings {
  const next: GuildSettings = { ...getGuildSettings(guildId), ...patch };
  for (const key of Object.keys(next) as (keyof GuildSettings)[]) {
    if (next[key] === undefined) delete next[key];
  }
  load().guilds[guildId] = next;
  schedule();
  return next;
}

/** Pemakaian karakter TTS hari ini (tanggal UTC); otomatis mulai dari 0 saat ganti hari. */
export function ttsUsage(): { day: string; chars: number } {
  const current = load();
  const today = new Date().toISOString().slice(0, 10);
  if (current.tts.day !== today) {
    current.tts = { day: today, chars: 0 };
    schedule();
  }
  return current.tts;
}

export function addTtsUsage(chars: number): void {
  ttsUsage().chars += chars;
  schedule();
}

/**
 * Pemakaian OpenRouter hari ini (tanggal UTC); otomatis mulai dari 0 saat ganti hari.
 * `requests` menghitung setiap HTTP request yang dikirim — termasuk yang gagal, karena
 * batas OpenRouter dihitung per request, bukan per token.
 */
export function llmUsage(): LlmUsage {
  const current = load();
  const today = new Date().toISOString().slice(0, 10);
  if (current.llm.day !== today) {
    current.llm = { ...emptyLlmUsage(), day: today };
    schedule();
  }
  return current.llm;
}

export function addLlmUsage(
  delta: { requests?: number; failures?: number; promptTokens?: number; completionTokens?: number },
): void {
  const current = llmUsage();
  current.requests += delta.requests ?? 0;
  current.failures += delta.failures ?? 0;
  current.promptTokens += delta.promptTokens ?? 0;
  current.completionTokens += delta.completionTokens ?? 0;
  schedule();
}

/** Paksa tulis ke disk (dipakai saat shutdown). */
export function flushState(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  flush();
}
