import assert from 'node:assert/strict';
import test from 'node:test';
import { SAMPLE_RATE, downmixToMono, pcmToWav, utteranceToWav } from '../src/voice/utterance.js';

test('downmixToMono merata-ratakan kanal kiri dan kanan', () => {
  const stereo = Buffer.alloc(8);
  stereo.writeInt16LE(100, 0);
  stereo.writeInt16LE(300, 2);
  stereo.writeInt16LE(-100, 4);
  stereo.writeInt16LE(-300, 6);

  const mono = downmixToMono(stereo);
  assert.equal(mono.length, 4);
  assert.equal(mono.readInt16LE(0), 200);
  assert.equal(mono.readInt16LE(2), -200);
});

test('pcmToWav menulis header WAV 44 byte yang benar', () => {
  const wav = pcmToWav(Buffer.alloc(960));
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(wav.length, 44 + 960);
});

test('utteranceToWav menghitung durasi dari PCM stereo', () => {
  const stereo = Buffer.alloc(SAMPLE_RATE * 4);
  const { wav, durationMs } = utteranceToWav(stereo);
  assert.equal(durationMs, 1000);
  assert.equal(wav.length, 44 + SAMPLE_RATE * 2);
});
