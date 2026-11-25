import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import { discordConfig, groqConfig, openRouterConfig } from './config.js';
import { log } from './log.js';
import { DEFAULT_PERSONA } from './persona.js';
import { flushState, getGuildSettings, updateGuildSettings } from './store.js';
import { assertTtsConfig } from './tts/index.js';
import { VoiceSession, type CompanionMode } from './voice/session.js';

const sessions = new Map<string, VoiceSession>();

const formatCount = (value: number): string => value.toLocaleString('id-ID');

const MODE_LABEL: Record<CompanionMode, string> = {
  auto: 'auto — menjawab setiap ucapan',
  mention: 'panggil — hanya menjawab kalau namanya disebut',
};

const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Panggil bot masuk ke voice channel kamu')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Suruh bot keluar dari voice channel')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('mode')
    .setDescription('Kapan bot menjawab: setiap ucapan atau hanya saat dipanggil')
    .addStringOption((option) =>
      option
        .setName('nilai')
        .setDescription('auto = jawab semua, panggil = hanya kalau namanya disebut')
        .setRequired(true)
        .addChoices({ name: 'auto', value: 'auto' }, { name: 'panggil', value: 'mention' }),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('transcript')
    .setDescription('Kirim transkrip percakapan voice ke text channel ini')
    .addStringOption((option) =>
      option
        .setName('nilai')
        .setDescription('nyala = kirim transkrip, mati = jangan')
        .setRequired(true)
        .addChoices({ name: 'nyala', value: 'on' }, { name: 'mati', value: 'off' }),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Lihat kesehatan sesi voice: latensi, klip diabaikan, anggaran suara')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('persona')
    .setDescription('Lihat atau ubah kepribadian bot di server ini')
    .addStringOption((option) =>
      option
        .setName('teks')
        .setDescription('Kepribadian baru (kosongkan untuk kembali ke default)')
        .setMaxLength(600),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Hapus riwayat dan memori percakapan bot di server ini')
    .toJSON(),
];

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, async (ready) => {
  log.info(`login sebagai ${ready.user.tag}`);

  try {
    if (discordConfig().guildId) {
      const guild = await ready.guilds.fetch(discordConfig().guildId);
      await guild.commands.set(commands);
      log.info(`slash command terdaftar di guild ${guild.name}`);
    } else {
      await ready.application.commands.set(commands);
      log.info('slash command terdaftar global (bisa butuh ~1 jam untuk muncul)');
    }
  } catch (error) {
    log.error('gagal mendaftarkan slash command:', (error as Error).message);
  }

  log.info('siap. Panggil /join di server Discord.');
});

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  void handleCommand(interaction).catch(async (error) => {
    log.error(`command /${interaction.commandName} gagal:`, (error as Error).message);
    const message = `Gagal: ${(error as Error).message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => undefined);
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  });
});

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !interaction.guildId) {
    await interaction.reply({ content: 'Command ini hanya bisa dipakai di server.', flags: MessageFlags.Ephemeral });
    return;
  }

  switch (interaction.commandName) {
    case 'join':
      await handleJoin(interaction);
      return;
    case 'leave':
      await handleLeave(interaction);
      return;
    case 'mode':
      await handleMode(interaction);
      return;
    case 'transcript':
      await handleTranscript(interaction);
      return;
    case 'status':
      await handleStatus(interaction);
      return;
    case 'persona':
      await handlePersona(interaction);
      return;
    case 'reset':
      await handleReset(interaction);
      return;
    default:
      await interaction.reply({ content: 'Command tidak dikenal.', flags: MessageFlags.Ephemeral });
  }
}

async function handleJoin(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  const member = interaction.member as GuildMember;
  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    await interaction.reply({
      content: 'Masuk ke voice channel dulu ya, baru panggil `/join`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const botMember = guild.members.me;
  const permissions = botMember ? voiceChannel.permissionsFor(botMember) : null;
  if (!permissions || !permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
    await interaction.reply({
      content: `Aku butuh izin **Connect** dan **Speak** di ${voiceChannel}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const existing = sessions.get(guild.id);
  if (existing?.channelId === voiceChannel.id) {
    await interaction.reply({
      content: `Aku sudah ada di **${voiceChannel.name}** — bicara saja, nanti kudengarkan.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  const textChannel = interaction.channel as TextChannel;
  const notify = (text: string) => textChannel.send(text);
  const settings = getGuildSettings(guild.id);

  try {
    // Kalau bot masih di channel lain, sesi lama keluar dan menghapus dirinya dari map.
    await existing?.leave();
    const session = await VoiceSession.join({
      channel: voiceChannel,
      persona: settings.persona ?? DEFAULT_PERSONA,
      mode: settings.mode ?? 'auto',
      transcript: settings.transcript ?? false,
      notify,
      onLeft: () => sessions.delete(guild.id),
    });
    sessions.set(guild.id, session);
    await interaction.editReply(
      `Aku masuk ke **${voiceChannel.name}**. Bicara saja — aku mendengar per orang, lalu menjawab dengan suara. ` +
        `Mode sekarang: ${MODE_LABEL[session.status().mode]}. Ketik \`/leave\` kalau sudah selesai.`,
    );
  } catch (error) {
    await interaction.editReply(`Gagal masuk voice: ${(error as Error).message}`);
  }
}

async function handleLeave(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.get(interaction.guildId!);
  if (!session) {
    await interaction.reply({ content: 'Aku sedang tidak di voice channel mana pun.', flags: MessageFlags.Ephemeral });
    return;
  }
  await session.leave();
  await interaction.reply('Oke, aku keluar dulu. Sampai jumpa!');
}

async function handleMode(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const mode: CompanionMode = interaction.options.getString('nilai', true) === 'mention' ? 'mention' : 'auto';
  updateGuildSettings(guildId, { mode });
  sessions.get(guildId)?.setMode(mode);
  await interaction.reply({
    content: `Mode sekarang: **${MODE_LABEL[mode]}**.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTranscript(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const enabled = interaction.options.getString('nilai', true) === 'on';
  updateGuildSettings(guildId, { transcript: enabled });
  sessions.get(guildId)?.setTranscript(enabled);
  await interaction.reply({
    content: enabled
      ? 'Transkrip **nyala** — tiap giliran dicatat ke text channel tempat `/join`.'
      : 'Transkrip **mati**.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const session = sessions.get(interaction.guildId!);
  if (!session) {
    await interaction.reply({ content: 'Aku sedang tidak di voice channel mana pun.', flags: MessageFlags.Ephemeral });
    return;
  }

  const status = session.status();
  const budget =
    status.tts.limit > 0
      ? `${status.tts.used}/${status.tts.limit} karakter hari ini (sisa ${status.tts.remaining})`
      : `tanpa batas (${status.tts.used} karakter hari ini)`;

  const lines = [
    `**#${status.channel}** · mode ${status.mode} · transkrip ${status.transcript ? 'nyala' : 'mati'}`,
    `Peserta: ${status.participants.length > 0 ? status.participants.join(', ') : '(kosong)'}`,
    `Antrean TTS: ${status.queued}${status.speaking ? ' (sedang bicara)' : ''} · riwayat ${status.historyTurns} giliran${status.hasMemory ? ' + memori' : ''}`,
    `STT ${status.stt.count}x (${status.stt.lastMs} ms, ${status.stt.errors} error) · LLM ${status.llm.count}x (${status.llm.lastMs} ms, ${status.llm.errors} error) · TTS ${status.tts.count}x (${status.tts.lastMs} ms, ${status.tts.errors} error)`,
    `OpenRouter ${status.llm.daily.day || 'hari ini'}: ${formatCount(status.llm.daily.requests)} request` +
      `${status.llm.daily.failures > 0 ? ` (${formatCount(status.llm.daily.failures)} gagal)` : ''}` +
      ` · ${formatCount(status.llm.daily.promptTokens + status.llm.daily.completionTokens)} token` +
      ` (${formatCount(status.llm.daily.promptTokens)} masuk + ${formatCount(status.llm.daily.completionTokens)} keluar)`,
    `Klip diabaikan: ${status.ignored.short} pendek, ${status.ignored.echo} gema, ${status.ignored.notAddressed} tidak dipanggil`,
    `TTS: ${status.tts.providers.join(' → ') || 'belum siap'} · ${budget}`,
    `Sambung ulang: ${status.reconnects}x`,
  ];

  await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
}

async function handlePersona(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const text = interaction.options.getString('teks');

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: 'Hanya pengurus server (Manage Server) yang bisa mengubah persona.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (text === null) {
    const current = getGuildSettings(guildId).persona ?? DEFAULT_PERSONA;
    await interaction.reply({ content: `Persona sekarang:\n>>> ${current}`, flags: MessageFlags.Ephemeral });
    return;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    updateGuildSettings(guildId, { persona: undefined });
    sessions.get(guildId)?.setPersona(DEFAULT_PERSONA);
    await interaction.reply({ content: 'Persona dikembalikan ke default.', flags: MessageFlags.Ephemeral });
    return;
  }

  updateGuildSettings(guildId, { persona: trimmed });
  sessions.get(guildId)?.setPersona(trimmed);
  await interaction.reply({
    content: 'Persona disimpan dan langsung dipakai.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handleReset(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  updateGuildSettings(guildId, { memory: undefined });
  sessions.get(guildId)?.resetHistory();
  await interaction.reply({
    content: 'Riwayat dan memori percakapan dihapus. Kita mulai dari awal.',
    flags: MessageFlags.Ephemeral,
  });
}

async function main(): Promise<void> {
  // Validasi key lebih awal supaya errornya jelas, bukan saat orang pertama bicara.
  const { token } = discordConfig();
  groqConfig();
  openRouterConfig();
  assertTtsConfig();

  await client.login(token);
}

async function shutdown(code: number): Promise<void> {
  for (const session of sessions.values()) await session.leave().catch(() => undefined);
  flushState();
  await client.destroy().catch(() => undefined);
  process.exitCode = code;
  // Jaring pengaman: jangan sampai proses menggantung karena handle gateway yang belum tertutup.
  setTimeout(() => process.exit(code), 1500);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info(`menerima ${signal}, mematikan bot...`);
    void shutdown(0);
  });
}

main().catch((error) => {
  log.error((error as Error).message);
  void shutdown(1);
});
