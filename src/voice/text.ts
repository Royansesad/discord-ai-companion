const MAX_SPEECH_CHARS = 400;
const MAX_PART_CHARS = 220;
const MIN_PART_CHARS = 12;

/** Bersihkan teks LLM supaya enak dibacakan (tanpa markdown/emoji/tautan). */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_`~#>]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SPEECH_CHARS);
}

function hardSplit(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (!current) {
      current = word;
    } else if (current.length + word.length + 1 <= maxChars) {
      current = `${current} ${word}`;
    } else {
      chunks.push(current);
      current = word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Pecah balasan jadi potongan pendek supaya kalimat pertama bisa mulai berbunyi
 * saat sisanya masih disintesis (TTS dipanggil per potongan, berurutan).
 */
export function splitForSpeech(text: string, maxChars = MAX_PART_CHARS): string[] {
  const parts: string[] = [];
  for (const raw of text.match(/[^.!?…]+[.!?…]*/g) ?? [text]) {
    const sentence = raw.trim();
    if (!sentence) continue;

    if (sentence.length > maxChars) {
      parts.push(...hardSplit(sentence, maxChars));
      continue;
    }

    // Fragmen sangat pendek (mis. "Iya.") digabung agar tidak memicu TTS terpisah.
    const last = parts.length - 1;
    if (last >= 0 && parts[last].length < MIN_PART_CHARS) {
      parts[last] = `${parts[last]} ${sentence}`.trim();
      continue;
    }
    parts.push(sentence);
  }
  return parts;
}

export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Apakah ucapan menyebut salah satu wake word (nama bot) sebagai kata utuh. */
export function isAddressed(text: string, wakeWords: string[]): boolean {
  const said = ` ${normalizeForMatch(text)} `;
  return wakeWords.some((word) => {
    const needle = normalizeForMatch(word);
    return needle.length >= 3 && said.includes(` ${needle} `);
  });
}

/** Buang nama bot dari awal/akhir kalimat setelah dipanggil. */
export function stripWakeWords(text: string, wakeWords: string[]): string {
  let result = text;
  for (const word of wakeWords) {
    const needle = word.trim();
    if (needle.length < 3) continue;
    result = result.replace(new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'giu'), ' ');
  }
  return result
    .replace(/^[\s,.:;!?—-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
