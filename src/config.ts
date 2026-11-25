function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Environment variable ${name} belum diisi. Salin .env.example ke .env lalu isi nilainya.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Angka 0–1, dipakai untuk setelan TTS (stability/similarity). */
function fraction(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function list(name: string): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function discordConfig() {
  return {
    token: required('DISCORD_TOKEN'),
    guildId: optional('DISCORD_GUILD_ID', ''),
  };
}

export function groqConfig() {
  return {
    apiKey: required('GROQ_API_KEY'),
    model: optional('GROQ_STT_MODEL', 'whisper-large-v3-turbo'),
    language: optional('STT_LANGUAGE', ''),
  };
}

export function openRouterConfig() {
  return {
    apiKey: required('OPENROUTER_API_KEY'),
    model: optional('OPENROUTER_MODEL', 'google/gemini-2.5-flash-lite'),
    fallbackModels: list('OPENROUTER_FALLBACK_MODELS'),
  };
}

export function fishConfig() {
  return {
    apiKey: required('FISH_API_KEY'),
    model: optional('FISH_MODEL', 's2.1-pro-free'),
    voiceId: optional('FISH_VOICE_ID', ''),
    latency: optional('FISH_LATENCY', 'balanced'),
  };
}

export function ttsConfig() {
  const preferred = optional('TTS_PROVIDER', 'elevenlabs').toLowerCase();
  return {
    provider: (preferred === 'fish' ? 'fish' : 'elevenlabs') as 'fish' | 'elevenlabs',
    dailyCharLimit: number('TTS_DAILY_CHAR_LIMIT', 20_000),
    elevenLabs: {
      apiKey: optional('ELEVENLABS_API_KEY', ''),
      voiceId: optional('ELEVENLABS_VOICE_ID', ''),
      model: optional('ELEVENLABS_MODEL', 'eleven_flash_v2_5'),
      // Dipakai model flash/turbo supaya pelafalan & logatnya Indonesia.
      language: optional('ELEVENLABS_LANGUAGE_CODE', 'id'),
      stability: fraction('ELEVENLABS_STABILITY', 0.5),
      similarity: fraction('ELEVENLABS_SIMILARITY', 0.75),
    },
  };
}

export function storeConfig() {
  return {
    file: optional('STATE_FILE', 'state.json'),
  };
}

export function voiceConfig() {
  return {
    silenceMs: number('VOICE_SILENCE_MS', 700),
    minSpeechMs: number('VOICE_MIN_SPEECH_MS', 600),
    maxUtteranceMs: number('VOICE_MAX_UTTERANCE_MS', 15_000),
    maxQueue: number('VOICE_MAX_QUEUE', 3),
    autoLeaveMs: number('VOICE_AUTO_LEAVE_MS', 120_000),
    historyTurns: number('VOICE_HISTORY_TURNS', 20),
    summaryEvery: number('VOICE_SUMMARY_EVERY', 12),
    wakeWords: list('VOICE_WAKE_WORD'),
  };
}
