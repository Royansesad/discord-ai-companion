const ECHO_WINDOW_MS = 15_000;
const MIN_ECHO_CHARS = 12;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mengenali transkrip yang isinya potongan teks yang baru dibacakan bot — hampir pasti
 * gema TTS sendiri yang tertangkap mic, bukan orang yang bicara.
 */
export class EchoFilter {
  private recent: { text: string; at: number }[] = [];

  constructor(
    private readonly windowMs = ECHO_WINDOW_MS,
    private readonly minChars = MIN_ECHO_CHARS,
  ) {}

  /** Catat satu potongan teks yang mulai diputar. */
  remember(text: string, now = Date.now()): void {
    const normalized = normalize(text);
    if (!normalized) return;
    this.recent.push({ text: normalized, at: now });
    this.recent = this.recent.filter((entry) => now - entry.at <= this.windowMs);
  }

  matches(transcript: string, now = Date.now()): boolean {
    const said = normalize(transcript);
    if (said.length < this.minChars) return false;
    return this.recent.some(
      (entry) => now - entry.at <= this.windowMs && entry.text.includes(said),
    );
  }
}
