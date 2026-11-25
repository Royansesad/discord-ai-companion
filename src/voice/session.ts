import {
  EndBehaviorType,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Guild, GuildMember, VoiceBasedChannel } from 'discord.js';
import OpusScript from 'opusscript';
import { voiceConfig } from '../config.js';
import { chat, summarize, type ChatMessage } from '../llm/openrouter.js';
import { log } from '../log.js';
import { buildSystemPrompt } from '../persona.js';
import { getGuildSettings, updateGuildSettings, type StoredTurn } from '../store.js';
import { transcribe } from '../stt/groq.js';
import { TtsBudgetError, synthesize, ttsStatus } from '../tts/index.js';
import { PlaybackQueue } from './playback.js';
import { isAddressed, sanitizeForSpeech, splitForSpeech, stripWakeWords } from './text.js';
import { utteranceToWav } from './utterance.js';

/** TTS dijeda sebentar untuk membedakan gema speaker dari orang yang benar-benar bicara. */
const BARGE_IN_PROBE_MS = 300;
/** Setelah dijeda, gema speaker berhenti; paket yang masih datang lewat batas ini berarti manusia. */
const ECHO_SETTLE_MS = 100;
const MAX_SUMMARY_CHARS = 600;
const MAX_PENDING_SUMMARY = 60;

export type CompanionMode = 'auto' | 'mention';

export interface SessionOptions {
  channel: VoiceBasedChannel;
  persona: string;
  mode: CompanionMode;
  transcript: boolean;
  notify: (text: string) => Promise<unknown>;
  onLeft: () => void;
}

export interface SessionStatus {
  channel: string;
  mode: CompanionMode;
  transcript: boolean;
  speaking: boolean;
  queued: number;
  historyTurns: number;
  participants: string[];
  hasMemory: boolean;
  ignored: { short: number; echo: number; notAddressed: number };
  stt: { count: number; errors: number; lastMs: number };
  llm: { count: number; errors: number; lastMs: number };
  tts: { count: number; errors: number; lastMs: number } & {
    providers: string[];
    limit: number;
    used: number;
    remaining: number;
  };
  reconnects: number;
}

export class VoiceSession {
  private readonly history: ChatMessage[] = [];
  /** Giliran lama yang menunggu dirangkum jadi memori. */
  private pendingSummary: ChatMessage[] = [];
  private readonly capturing = new Set<string>();
  private readonly lastPacketAt = new Map<string, number>();
  private readonly queue: PlaybackQueue;
  private readonly config = voiceConfig();
  private readonly channel: VoiceBasedChannel;
  private readonly guild: Guild;
  private readonly notify: (text: string) => Promise<unknown>;
  private readonly onLeft: () => void;
  private readonly wakeWords: string[];
  private persona: string;
  private mode: CompanionMode;
  private transcriptEnabled: boolean;
  private summary = '';
  private autoLeaveTimer?: NodeJS.Timeout;
  private bargeInTimer?: NodeJS.Timeout;
  private emptySince: number | null = null;
  private left = false;
  private recovering = false;
  private readonly stats = {
    ignoredShort: 0,
    ignoredEcho: 0,
    ignoredNotAddressed: 0,
    sttMs: 0,
    sttCount: 0,
    sttErrors: 0,
    llmMs: 0,
    llmCount: 0,
    llmErrors: 0,
    ttsMs: 0,
    ttsCount: 0,
    ttsErrors: 0,
    reconnects: 0,
  };

  private constructor(
    private readonly connection: VoiceConnection,
    options: SessionOptions,
  ) {
    this.channel = options.channel;
    this.guild = options.channel.guild;
    this.persona = options.persona;
    this.mode = options.mode;
    this.transcriptEnabled = options.transcript;
    this.notify = options.notify;
    this.onLeft = options.onLeft;
    this.wakeWords = VoiceSession.collectWakeWords(this.guild, this.config.wakeWords);

    const player = createAudioPlayer();
    this.connection.subscribe(player);
    this.queue = new PlaybackQueue(player, this.config.maxQueue);

    const stored = getGuildSettings(this.guild.id);
    if (stored.memory) {
      this.summary = stored.memory.summary.slice(0, MAX_SUMMARY_CHARS);
      for (const turn of stored.memory.turns.slice(-this.config.historyTurns)) {
        this.history.push(turn);
      }
      log.debug(`memori dimuat: ${this.history.length} giliran, ringkasan ${this.summary.length} karakter`);
    }

    this.connection.receiver.speaking.on('start', (userId) => this.onSpeakingStart(userId));

    this.connection.on('stateChange', (_, next) => {
      log.debug(`voice connection: ${next.status}`);
      if (next.status === VoiceConnectionStatus.Disconnected) void this.recover();
    });

    this.autoLeaveTimer = setInterval(() => void this.checkAutoLeave(), 30_000);
    this.autoLeaveTimer.unref();
  }

  static async join(options: SessionOptions): Promise<VoiceSession> {
    const { channel } = options;
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
      connection.destroy();
      throw new Error(
        'Tidak bisa tersambung ke voice channel (20 detik). Cek izin Connect/Speak, dan lihat catatan DAVE di README.',
        { cause: error },
      );
    }

    log.info(`tersambung ke voice channel #${channel.name} (${channel.guild.name})`);
    return new VoiceSession(connection, options);
  }

  /** Nama bot yang dianggap memanggilnya di mode `mention`. */
  private static collectWakeWords(guild: Guild, extra: string[]): string[] {
    const me = guild.members.me;
    const words = [me?.displayName ?? '', me?.user.username ?? '', ...extra]
      .map((word) => word.trim())
      .filter((word) => word.length >= 3);
    return [...new Set(words)];
  }

  get channelId(): string {
    return this.channel.id;
  }

  resetHistory(): void {
    this.history.length = 0;
    this.pendingSummary = [];
    this.summary = '';
    updateGuildSettings(this.guild.id, { memory: undefined });
  }

  setPersona(persona: string): void {
    this.persona = persona;
  }

  setMode(mode: CompanionMode): void {
    this.mode = mode;
  }

  setTranscript(enabled: boolean): void {
    this.transcriptEnabled = enabled;
  }

  status(): SessionStatus {
    return {
      channel: this.channel.name,
      mode: this.mode,
      transcript: this.transcriptEnabled,
      speaking: this.queue.isSpeaking,
      queued: this.queue.pending,
      historyTurns: this.history.length,
      participants: this.participants(),
      hasMemory: this.summary.length > 0,
      ignored: {
        short: this.stats.ignoredShort,
        echo: this.stats.ignoredEcho,
        notAddressed: this.stats.ignoredNotAddressed,
      },
      stt: { count: this.stats.sttCount, errors: this.stats.sttErrors, lastMs: this.stats.sttMs },
      llm: { count: this.stats.llmCount, errors: this.stats.llmErrors, lastMs: this.stats.llmMs },
      tts: {
        count: this.stats.ttsCount,
        errors: this.stats.ttsErrors,
        lastMs: this.stats.ttsMs,
        ...ttsStatus(),
      },
      reconnects: this.stats.reconnects,
    };
  }

  async leave(): Promise<void> {
    if (this.left) return;
    this.left = true;
    if (this.autoLeaveTimer) clearInterval(this.autoLeaveTimer);
    if (this.bargeInTimer) clearTimeout(this.bargeInTimer);
    this.persistMemory();
    this.queue.stopAll();
    try {
      this.connection.destroy();
    } catch (error) {
      log.debug('destroy connection:', (error as Error).message);
    }
    this.onLeft();
    log.info(`keluar dari voice channel #${this.channel.name}`);
  }

  private onSpeakingStart(userId: string): void {
    if (this.left || this.guild.members.cache.get(userId)?.user.bot) return;

    if (this.queue.isSpeaking) this.probeBargeIn(userId);

    if (this.capturing.has(userId)) return;
    this.capturing.add(userId);

    const maxBytes = Math.floor((this.config.maxUtteranceMs / 1000) * 48_000 * 4);
    const chunks: Buffer[] = [];
    let received = 0;
    let decodeErrors = 0;
    const decoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);

    const stream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.config.silenceMs },
    });

    stream.on('data', (packet: Buffer) => {
      this.lastPacketAt.set(userId, Date.now());
      if (received >= maxBytes) return;
      try {
        const pcm = decoder.decode(packet);
        chunks.push(Buffer.from(pcm));
        received += pcm.length;
      } catch {
        decodeErrors += 1;
      }
    });

    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      decoder.delete();
      this.capturing.delete(userId);
      if (decodeErrors > 0) {
        log.warn(`paket audio gagal didekripsi/di-decode: ${decodeErrors} (indikasi masalah DAVE)`);
      }
      const pcm = Buffer.concat(chunks);
      chunks.length = 0;
      void this.handleUtterance(userId, pcm);
    };

    stream.once('close', finish);
    stream.once('error', (error) => {
      log.warn('receive stream error:', error.message);
      finish();
    });
  }

  /**
   * Barge-in tanpa memotong suara bot sendiri: TTS dijeda sebentar, lalu dilihat
   * apakah paket audio pembicara masih mengalir. Gema dari speaker berhenti begitu
   * TTS berhenti; orang sungguhan terus bicara. Hanya kasus kedua yang menghentikan TTS.
   */
  private probeBargeIn(userId: string): void {
    if (this.bargeInTimer) return;

    const pausedAt = Date.now();
    this.queue.pause();

    this.bargeInTimer = setTimeout(() => {
      this.bargeInTimer = undefined;
      if (this.left) return;

      if ((this.lastPacketAt.get(userId) ?? 0) > pausedAt + ECHO_SETTLE_MS) {
        log.debug('barge-in: manusia bicara, TTS dihentikan');
        this.queue.stopAll();
        return;
      }
      log.debug('barge-in: diabaikan, itu gema TTS sendiri');
      this.queue.resume();
    }, BARGE_IN_PROBE_MS);
  }

  private async handleUtterance(userId: string, stereoPcm: Buffer): Promise<void> {
    if (stereoPcm.length === 0) return;

    const { wav, durationMs } = utteranceToWav(stereoPcm);
    if (durationMs < this.config.minSpeechMs) {
      this.stats.ignoredShort += 1;
      log.debug(`abaikan klip ${durationMs}ms dari ${userId} (terlalu pendek)`);
      return;
    }

    const name = await this.displayName(userId);
    const sttStarted = Date.now();
    let text = '';
    try {
      text = await transcribe(wav);
      this.stats.sttCount += 1;
      this.stats.sttMs = Date.now() - sttStarted;
    } catch (error) {
      this.stats.sttErrors += 1;
      log.error('STT gagal:', (error as Error).message);
      return;
    }
    if (!text) return;

    if (this.queue.isEcho(text)) {
      this.stats.ignoredEcho += 1;
      log.debug(`abaikan gema TTS sendiri: "${text}"`);
      return;
    }

    if (this.mode === 'mention' && !isAddressed(text, this.wakeWords)) {
      this.stats.ignoredNotAddressed += 1;
      log.debug(`abaikan (mode panggil, nama bot tidak disebut): "${text}"`);
      return;
    }

    const utterance = stripWakeWords(text, this.wakeWords) || text;
    log.info(`[${name}] ${utterance}`);

    this.history.push({ role: 'user', content: `${name}: ${utterance}` });
    this.trimHistory();

    const llmStarted = Date.now();
    let reply = '';
    try {
      reply = await chat([{ role: 'system', content: this.systemPrompt() }, ...this.history]);
      this.stats.llmCount += 1;
      this.stats.llmMs = Date.now() - llmStarted;
    } catch (error) {
      this.stats.llmErrors += 1;
      log.error('LLM gagal:', (error as Error).message);
      return;
    }

    this.history.push({ role: 'assistant', content: reply });
    this.trimHistory();
    const botName = this.guild.members.me?.displayName ?? 'bot';
    log.info(`[${botName}] ${reply}`);
    this.persistMemory();

    if (this.transcriptEnabled) {
      void this.notify(`**${name}**: ${utterance}\n**${botName}**: ${reply}`).catch(() => undefined);
    }

    await this.speak(reply);
  }

  private async speak(reply: string): Promise<void> {
    const spoken = sanitizeForSpeech(reply);
    if (!spoken) return;

    const parts = splitForSpeech(spoken);
    for (let index = 0; index < parts.length; index += 1) {
      const started = Date.now();
      try {
        this.queue.enqueue(await synthesize(parts[index]), parts[index]);
        this.stats.ttsCount += 1;
        this.stats.ttsMs = Date.now() - started;
      } catch (error) {
        this.stats.ttsErrors += 1;
        if (error instanceof TtsBudgetError) {
          log.warn(error.message);
          await this.notify(`_(Anggaran suara harian habis — ini teks balasannya)_\n${reply}`).catch(
            () => undefined,
          );
        } else {
          log.error('TTS gagal:', (error as Error).message);
          await this.notify(`_(TTS gagal, ini teks balasannya)_\n${reply}`).catch(() => undefined);
        }
        return;
      }
    }
  }

  private systemPrompt(): string {
    return buildSystemPrompt(this.persona, {
      guild: this.guild.name,
      channel: this.channel.name,
      participants: this.participants(),
      summary: this.summary,
    });
  }

  private participants(): string[] {
    return this.channel.members
      .filter((member) => !member.user.bot)
      .map((member) => member.displayName)
      .slice(0, 12);
  }

  private async displayName(userId: string): Promise<string> {
    const cached = this.guild.members.cache.get(userId);
    if (cached) return cached.displayName;
    try {
      const member = (await this.guild.members.fetch(userId)) as GuildMember;
      return member.displayName;
    } catch {
      return `pengguna-${userId.slice(-4)}`;
    }
  }

  private trimHistory(): void {
    const limit = this.config.historyTurns;
    if (this.history.length <= limit) return;

    const dropped = this.history.splice(0, this.history.length - limit);
    this.pendingSummary.push(...dropped);
    if (this.pendingSummary.length > MAX_PENDING_SUMMARY) {
      this.pendingSummary.splice(0, this.pendingSummary.length - MAX_PENDING_SUMMARY);
    }
    if (this.pendingSummary.length >= this.config.summaryEvery) void this.summarizeMemory();
  }

  private async summarizeMemory(): Promise<void> {
    if (this.left) return;
    const turns = this.pendingSummary.splice(0, this.pendingSummary.length);
    try {
      this.summary = (await summarize(turns as StoredTurn[], this.summary)).slice(0, MAX_SUMMARY_CHARS);
      this.persistMemory();
      log.debug(`memori diperbarui (${this.summary.length} karakter)`);
    } catch (error) {
      this.pendingSummary.unshift(...turns);
      log.warn('gagal merangkum memori:', (error as Error).message);
    }
  }

  private persistMemory(): void {
    const turns: StoredTurn[] = this.history
      .slice(-this.config.historyTurns)
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      }));
    updateGuildSettings(this.guild.id, { memory: { summary: this.summary, turns } });
  }

  /** Putus dari gateway voice → coba resume, lalu rejoin; kalau gagal, keluar bersih. */
  private async recover(): Promise<void> {
    if (this.left || this.recovering) return;
    this.recovering = true;
    this.stats.reconnects += 1;
    log.warn('voice terputus, mencoba menyambung ulang...');

    try {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (!this.connection.rejoin()) throw new Error('rejoin ditolak Discord');
        await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
      }
      log.info('voice tersambung kembali');
    } catch (error) {
      log.error('gagal menyambung ulang voice:', (error as Error).message);
      await this.notify(
        `Aku kehilangan koneksi ke voice channel #${this.channel.name} dan gagal kembali. Panggil \`/join\` lagi ya.`,
      ).catch(() => undefined);
      await this.leave();
    } finally {
      this.recovering = false;
    }
  }

  private async checkAutoLeave(): Promise<void> {
    const humans = this.channel.members.filter((member) => !member.user.bot).size;
    if (humans > 0) {
      this.emptySince = null;
      return;
    }
    if (this.emptySince === null) {
      this.emptySince = Date.now();
      return;
    }
    if (Date.now() - this.emptySince >= this.config.autoLeaveMs) {
      log.info('channel kosong terlalu lama, keluar otomatis');
      await this.notify('Aku keluar dulu ya, channel-nya kosong. Panggil `/join` kalau mau ngobrol lagi.').catch(
        () => undefined,
      );
      await this.leave();
    }
  }
}
