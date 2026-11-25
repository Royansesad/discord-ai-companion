export const DEFAULT_PERSONA = [
  'Kamu adalah "Nao", teman ngobrol yang hangat dan santai di voice channel Discord.',
  'Kamu mendengar percakapan lewat speech-to-text, jadi kadang ada kata yang salah dengar —',
  'kalau maksudnya tidak jelas, tanya singkat daripada menebak.',
].join(' ');

const STYLE_RULES = [
  'Aturan gaya:',
  '- Balas seperti orang ngobrol di voice chat: 1-3 kalimat pendek, maksimal ~60 kata.',
  '- Jangan pakai markdown, bullet, emoji, atau tautan — jawabanmu akan dibacakan sebagai suara.',
  '- Ikuti bahasa yang dipakai lawan bicara (Indonesia atau Inggris).',
  '- Sebut nama pembicara hanya kalau perlu; jangan mengulang pertanyaannya.',
  '- Kalau tidak ada yang perlu ditanggapi, jawab seperlunya saja, jangan mengarang.',
].join('\n');

export interface PromptContext {
  guild?: string;
  channel?: string;
  /** Nama orang yang sedang ada di voice channel. */
  participants?: string[];
  /** Ringkasan percakapan sebelumnya (memori lintas sesi). */
  summary?: string;
}

export function buildSystemPrompt(persona: string, context: PromptContext = {}): string {
  const sections = [persona, STYLE_RULES];

  const where: string[] = [];
  if (context.channel) {
    where.push(`Kamu sedang di voice channel #${context.channel}${context.guild ? ` di server ${context.guild}` : ''}.`);
  }
  if (context.participants?.length) {
    where.push(
      `Yang ada di channel sekarang: ${context.participants.join(', ')}. Sebut nama mereka kalau relevan, dan jangan mengira ada orang lain di luar daftar itu.`,
    );
  }
  if (where.length > 0) sections.push(where.join(' '));

  if (context.summary) {
    sections.push(`Catatan dari percakapan sebelumnya (pakai kalau relevan, jangan dibacakan): ${context.summary}`);
  }

  return sections.join('\n\n');
}
