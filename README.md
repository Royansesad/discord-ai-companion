# Discord AI Companion

Bot Discord yang masuk ke voice channel, mendengar **tiap orang secara terpisah**, lalu menjawab dengan suara.
Audio tetap **Opus end-to-end** — tidak butuh ffmpeg.

- **STT:** Groq `whisper-large-v3-turbo` (free tier, tanpa kartu)
- **LLM:** OpenRouter (model bisa diganti di `.env`)
- **TTS:** ElevenLabs (`eleven_flash_v2_5`, `language_code=id`), cadangan fish.audio
- **Identifikasi pembicara:** dari stream per-user Discord (SSRC → userId), tanpa layanan diarization

## Kenapa tidak perlu diarization

Discord tidak mengirim satu campuran audio; `@discordjs/voice` menerima paket Opus **per pembicara**
(`receiver.subscribe(userId)`). Jadi nama pembicara selalu tepat, gratis, dan tanpa model tambahan.
Yang mahal (diarization) tidak dipakai sama sekali di sini.

## 1. Prasyarat

- Node.js **≥ 22.12** (di mesin ini v25.9.0 sudah terpasang)
- Server Discord + voice channel
- 3 API key wajib: Discord bot token, Groq, OpenRouter — plus ElevenLabs (atau fish.audio)

## 2. Buat bot Discord

1. <https://discord.com/developers/applications> → **New Application** → tab **Bot** → **Reset Token** → salin.
2. Tidak perlu privileged intent (bot ini hanya butuh `Guilds` + `GuildVoiceStates`).
3. Undang bot ke server dengan scope `bot` + `applications.commands` dan izin
   **View Channel (1024) + Connect (1048576) + Speak (2097152) + Use Voice Activity (33554432)** → total `36701184`:

   ```
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot%20applications.commands&permissions=36701184
   ```

4. (Opsional) isi `DISCORD_GUILD_ID` agar slash command langsung muncul. Tanpa itu, command global bisa telat ~1 jam.

## 3. Isi key

```bash
cp .env.example .env
```

| Variabel | Dari mana |
|---|---|
| `DISCORD_TOKEN` | Discord Developer Portal |
| `GROQ_API_KEY` | <https://console.groq.com/keys> — gratis, tanpa kartu |
| `OPENROUTER_API_KEY` | <https://openrouter.ai/keys> |
| `ELEVENLABS_API_KEY` | <https://elevenlabs.io/app/settings/api-keys> |
| `ELEVENLABS_VOICE_ID` | **wajib** — Voice ID voice Indonesia dari [Voice Library](https://elevenlabs.io/app/voice-library) |
| `ELEVENLABS_MODEL` | default `eleven_flash_v2_5`; `eleven_multilingual_v2` paling natural |
| `FISH_API_KEY` + `FISH_VOICE_ID` | opsional, TTS cadangan fish.audio (voice default fish berlogat Inggris) |
| `TTS_DAILY_CHAR_LIMIT` | default `20000` karakter/hari; `0` = tanpa batas |
| `VOICE_WAKE_WORD` | opsional, nama panggilan tambahan untuk mode *panggil* |

`.env` sudah di-`.gitignore`. Jangan commit.

## 4. Jalankan

```bash
npm install
npm run selftest -- --channel <VOICE_CHANNEL_ID>   # gerbang DAVE, minta 1 orang bicara
npm start
npm test                                            # test fungsi murni, tanpa jaringan
```

`selftest` membuktikan bot benar-benar menerima & men-decode suara per pembicara:

```
[12:00:01] speaking start: 123456789
[12:00:04] 123456789: 87 paket, 21450 sample non-silent, 0 decode error -> OK
[12:00:04] HASIL: receive + decode audio BERFUNGSI.
```

Kalau hasilnya `audio 0 sample`, lihat bagian **DAVE** di bawah.

## 5. Perintah

| Command | Fungsi |
|---|---|
| `/join` | Masuk ke voice channel kamu, mulai mendengar |
| `/leave` | Keluar dari voice |
| `/mode auto\|panggil` | Jawab setiap ucapan, atau hanya saat namanya disebut |
| `/transcript nyala\|mati` | Kirim transkrip tiap giliran ke text channel |
| `/status` | Latensi STT/LLM/TTS, pemakaian OpenRouter hari ini (request + token), klip diabaikan, sisa anggaran suara |
| `/persona [teks]` | Lihat/ubah kepribadian (butuh *Manage Server*), berlaku langsung |
| `/reset` | Hapus riwayat + memori percakapan |

## 6. Perilaku

- Balasan 1–3 kalimat, dipotong jadi beberapa kalimat yang dikirim ke TTS berurutan supaya
  kalimat pertama sudah berbunyi saat sisanya masih disintesis.
- **Tanpa filler:** bot tidak pernah memutar kalimat pengisi seperti "sebentar aku pikir dulu";
  suara hanya keluar setelah balasan LLM benar-benar siap.
- **Suara & logat:** teks dikirim ke TTS dengan `ELEVENLABS_LANGUAGE_CODE=id` dan voice Indonesia,
  jadi pelafalan serta logatnya Indonesia — bukan voice Inggris yang membaca teks Indonesia.
- **Barge-in sadar-gema:** bot berhenti kalau kamu benar-benar bicara, tapi tidak memotong dirinya
  sendiri ketika mic menangkap suara TTS-nya.
- Klip 0.6–15 detik, antrean TTS maks 3, keluar otomatis kalau channel kosong 2 menit.
- **Mode panggil:** hanya menanggapi ucapan yang menyebut nama bot (display name, username, atau
  `VOICE_WAKE_WORD`). Nama itu dibuang dari kalimat sebelum dikirim ke LLM.
- **Konteks peserta:** system prompt menyebut siapa saja yang ada di channel, jadi bot bisa menyapa nama.
- **Memori:** persona, mode, transkrip, dan riwayat terakhir disimpan di `state.json`; saat riwayat
  dipangkas, giliran lama dirangkum jadi catatan singkat (`VOICE_SUMMARY_EVERY`) supaya bot tidak lupa
  setelah `/leave` atau restart.

## 7. Alur audio (tanpa ffmpeg)

```
VoiceReceiver (DAVE)
 └─ AudioReceiveStream per userId, end: AfterSilence 700ms
     └─ opusscript decode -> PCM 48k stereo -> mono -> WAV (header ditulis sendiri)
         └─ Groq Whisper -> teks + nama pembicara
             └─ OpenRouter -> balasan
                 └─ ElevenLabs TTS (opus) -> AudioPlayer  [Ogg/Opus dipassthrough]
```

ElevenLabs `opus_48000_128` sudah berupa Ogg/Opus 48 kHz sehingga langsung diputar; kalau
kontainernya tidak cocok, bot meminta PCM 48 kHz dan meng-encode 20 ms frame dengan
`opusscript` (`StreamType.Opus`). fish.audio memakai jalur yang sama sebagai cadangan.
Tetap tanpa ffmpeg.

## 8. DAVE (penting)

Discord mewajibkan enkripsi E2EE **DAVE** di voice (rollout selesai ~Maret 2026). Ini menyentuh
kemampuan bot *mendengar*:

- Bot ini memakai `@discordjs/voice@0.19.2` + `@snazzah/davey` (prebuilt untuk Windows, tanpa Rust).
- Ada laporan masih ada paket hilang / 0 byte pada build stable
  ([#11419](https://github.com/discordjs/discord.js/issues/11419), [#11441](https://github.com/discordjs/discord.js/issues/11441)).
- `daveEncryption: false` **bukan** solusi: server akan menolak handshake dan join gagal.

Kalau `selftest` gagal:

```bash
npm install @discordjs/voice@dev
npm run selftest -- --channel <ID>
```

Build `dev` (1.0.0-dev) mengubah API receiver menjadi `AudioPacket`; kode di
`src/voice/session.ts` dan `scripts/voice-selftest.ts` perlu penyesuaian kecil saat itu
(`stream.on('data')` menerima objek `AudioPacket`, bukan `Buffer`).

## 9. Biaya & batas free tier

| Layanan | Free tier | Catatan |
|---|---|---|
| Groq STT | 20 RPM, 2.000 req/hari, 8 jam audio/hari | tanpa kartu, reset harian |
| OpenRouter | `:free` = 20 RPM / **50 req/hari** (1.000 setelah beli $10 kredit) | default `.env` memakai model murah; ringkasan memori juga memakai 1 request |
| fish.audio | `s2.1-pro-free` gratis **s/d 30 Nov 2026** | setelah itu $15/1M byte; ganti `FISH_MODEL=s2.1-pro` |
| ElevenLabs | 10k kredit/bulan (free) | `eleven_flash_v2_5` = 0.5 kredit/karakter (~20k karakter), `eleven_multilingual_v2` = 1 kredit/karakter |

`TTS_DAILY_CHAR_LIMIT` (default 20.000) menghentikan TTS sebelum kuota habis; kalau kena,
balasan tetap dikirim sebagai teks di channel. Untuk pemakaian serius, pakai model OpenRouter
murah berbayar karena batas `:free` terlalu kecil untuk ngobrol lama.

## 10. State

`state.json` (bisa dipindah lewat `STATE_FILE`) menyimpan per guild: persona, mode, transkrip,
memori percakapan, pemakaian karakter TTS hari ini, serta jumlah request + token OpenRouter hari ini
(reset otomatis saat ganti hari UTC). File ini di-`.gitignore` dan aman dihapus
kalau mau memulai dari nol.

## 11. Troubleshooting

| Gejala | Penyebab / solusi |
|---|---|
| `Environment variable ... belum diisi` | `.env` belum lengkap |
| Join gagal 20 detik | izin Connect/Speak, atau handshake DAVE ditolak |
| Transkrip kosong terus | cek `DEBUG=true`; pastikan `STT_LANGUAGE=id`; coba `whisper-large-v3` |
| Bot diam padahal ada yang bicara | mode `panggil` aktif — panggil namanya, atau `/mode auto` |
| Balasan tidak bersuara | cek log `TTS gagal` / `anggaran suara`; verifikasi key & kuota |
| Suara berlogat Inggris | voice TTS-nya bukan voice Indonesia — isi `ELEVENLABS_VOICE_ID` dari Voice Library (filter Indonesian), atau `FISH_VOICE_ID` |
| `429` | bot otomatis backoff; kurangi percakapan bersamaan |
| Voice putus lalu keluar sendiri | rejoin otomatis gagal — cek koneksi, lalu `/join` lagi |
| Slash command tidak muncul | isi `DISCORD_GUILD_ID`, lalu restart |

## 12. Struktur

```
src/index.ts             client + slash command
src/config.ts            env (lazy per modul)
src/store.ts             state.json: persona/mode/memori/pemakaian TTS
src/persona.ts           prompt karakter + konteks channel
src/voice/session.ts     capture per-user, STT→LLM→TTS, memori, rejoin, status
src/voice/text.ts        sanitasi, pemecah kalimat, deteksi wake word
src/voice/echo.ts        filter gema TTS
src/voice/utterance.ts   downmix + WAV (manual)
src/voice/playback.ts    antrean Opus + pause/resume untuk barge-in
src/stt/groq.ts          Groq Whisper
src/llm/openrouter.ts    chat completions + fallback + ringkasan memori
src/tts/index.ts         pemilihan provider + cadangan
src/tts/fish.ts          /v1/tts opus dengan fallback PCM
src/tts/elevenlabs.ts    ElevenLabs (opus 48 kHz, language_code id)
src/tts/budget.ts        anggaran karakter harian
test/                    test fungsi murni (node:test)
scripts/voice-selftest.ts gerbang DAVE
```
