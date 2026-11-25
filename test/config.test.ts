import assert from 'node:assert/strict';
import test from 'node:test';
import { ttsConfig, voiceConfig } from '../src/config.js';

test('voiceConfig memakai default dan menolak angka tidak valid', () => {
  delete process.env.VOICE_SILENCE_MS;
  assert.equal(voiceConfig().silenceMs, 700);

  process.env.VOICE_SILENCE_MS = '1200';
  assert.equal(voiceConfig().silenceMs, 1200);

  process.env.VOICE_SILENCE_MS = 'bukan-angka';
  assert.equal(voiceConfig().silenceMs, 700);

  delete process.env.VOICE_SILENCE_MS;
});

test('voiceConfig memecah daftar wake word dan membuang entri kosong', () => {
  process.env.VOICE_WAKE_WORD = 'nao, sayang ,';
  assert.deepEqual(voiceConfig().wakeWords, ['nao', 'sayang']);
  delete process.env.VOICE_WAKE_WORD;
});

test('ttsConfig membaca provider pilihan, anggaran harian, dan setelan ElevenLabs', () => {
  process.env.TTS_PROVIDER = 'fish';
  process.env.TTS_DAILY_CHAR_LIMIT = '5000';
  process.env.ELEVENLABS_MODEL = 'eleven_multilingual_v2';
  process.env.ELEVENLABS_STABILITY = '0.35';

  const config = ttsConfig();
  assert.equal(config.provider, 'fish');
  assert.equal(config.dailyCharLimit, 5000);
  assert.equal(config.elevenLabs.model, 'eleven_multilingual_v2');
  assert.equal(config.elevenLabs.stability, 0.35);
  assert.equal(config.elevenLabs.language, 'id');

  delete process.env.TTS_PROVIDER;
  delete process.env.TTS_DAILY_CHAR_LIMIT;
  delete process.env.ELEVENLABS_MODEL;
  delete process.env.ELEVENLABS_STABILITY;
});

test('ttsConfig memakai ElevenLabs sebagai default dan mengabaikan nilai asing', () => {
  delete process.env.TTS_PROVIDER;
  assert.equal(ttsConfig().provider, 'elevenlabs');

  process.env.TTS_PROVIDER = 'azure';
  assert.equal(ttsConfig().provider, 'elevenlabs');
  delete process.env.TTS_PROVIDER;
});
