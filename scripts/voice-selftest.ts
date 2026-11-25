/**
 * Gate DAVE: buktikan bahwa bot benar-benar menerima dan bisa men-decode audio
 * per pembicara. Jalankan saat 1-2 orang bicara di voice channel:
 *
 *   npm run selftest -- --channel <voiceChannelId> [--seconds 30]
 *
 * Exit 0 = audio terdekripsi. Exit 1 = 0 audio (kemungkinan DAVE receive rusak,
 * lihat catatan di README).
 */
import { ChannelType, Client, Events, GatewayIntentBits } from 'discord.js';
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import OpusScript from 'opusscript';
import { discordConfig } from '../src/config.js';
import { log } from '../src/log.js';

interface Stats {
  packets: number;
  samples: number;
  decodeErrors: number;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const channelId = argValue('--channel');
const seconds = Number.parseInt(argValue('--seconds') ?? '30', 10);

if (!channelId) {
  console.error('Pemakaian: npm run selftest -- --channel <voiceChannelId> [--seconds 30]');
  process.exit(2);
}

const davey = await import('@snazzah/davey')
  .then((module) => `loaded (${Object.keys(module).length} export)`)
  .catch((error: Error) => `GAGAL: ${error.message}`);
log.info(`@snazzah/davey: ${davey}`);

const stats = new Map<string, Stats>();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once(Events.ClientReady, async (ready) => {
  log.info(`login sebagai ${ready.user.tag}`);

  const channel = await client.channels.fetch(channelId);
  if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
    log.error('channel tidak ditemukan atau bukan voice channel');
    process.exit(2);
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    log.error('gagal connect ke voice dalam 20 detik');
    process.exit(1);
  }

  const networking = (connection as unknown as { state?: { networking?: { state?: { dave?: unknown } } } })
    .state?.networking?.state;
  log.info(`voice ready di #${channel.name} | DAVE session: ${networking?.dave ? 'aktif' : 'tidak ada'}`);
  log.info(`mendengarkan ${seconds} detik — silakan bicara sekarang...`);

  connection.receiver.speaking.on('start', (userId) => {
    if (stats.has(userId)) {
      log.info(`speaking start: ${userId} (stream sudah jalan)`);
    } else {
      stats.set(userId, { packets: 0, samples: 0, decodeErrors: 0 });
      log.info(`speaking start: ${userId}`);
    }

    if (connection.receiver.subscriptions.has(userId)) return;

    const decoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
    const stream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 700 },
    });
    const entry = stats.get(userId)!;

    stream.on('data', (packet: Buffer) => {
      entry.packets += 1;
      try {
        const pcm = decoder.decode(packet);
        for (let offset = 0; offset < pcm.length; offset += 2) {
          if (Math.abs(pcm.readInt16LE(offset)) > 200) {
            entry.samples += 1;
          }
        }
      } catch {
        entry.decodeErrors += 1;
      }
    });
    stream.once('close', () => {
      decoder.delete();
      log.info(`speaking end: ${userId} (${entry.packets} paket)`);
    });
  });

  connection.receiver.speaking.on('end', (userId) => {
    const entry = stats.get(userId);
    log.debug(`speaking selesai: ${userId} | paket=${entry?.packets ?? 0}`);
  });

  setTimeout(() => {
    connection.destroy();
    void client.destroy();

    const entries = [...stats.entries()];
    if (entries.length === 0) {
      log.error('tidak ada event speaking sama sekali — cek izin, DAVE, dan apakah ada yang bicara.');
      process.exit(1);
    }

    let audioOk = false;
    for (const [userId, entry] of entries) {
      const verdict = entry.samples > 0 ? 'OK' : 'SENYAP';
      if (entry.samples > 0) audioOk = true;
      log.info(`${userId}: ${entry.packets} paket, ${entry.samples} sample non-silent, ${entry.decodeErrors} decode error -> ${verdict}`);
    }

    if (audioOk) {
      log.info('HASIL: receive + decode audio BERFUNGSI.');
      process.exit(0);
    }

    log.error('HASIL: audio 0 sample. Kemungkinan DAVE receive rusak di versi stable.');
    log.error('Coba: npm install @discordjs/voice@dev lalu ulangi selftest (lihat README bagian DAVE).');
    process.exit(1);
  }, seconds * 1000);
});

client.login(discordConfig().token).catch((error: Error) => {
  log.error('login gagal:', error.message);
  process.exit(1);
});
