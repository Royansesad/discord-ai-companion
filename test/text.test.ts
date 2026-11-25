import assert from 'node:assert/strict';
import test from 'node:test';
import { EchoFilter } from '../src/voice/echo.js';
import { isAddressed, sanitizeForSpeech, splitForSpeech, stripWakeWords } from '../src/voice/text.js';

test('sanitizeForSpeech membuang markdown, emoji, dan tautan', () => {
  const input = '**Halo** [Nao](https://x.test) 👋 https://contoh.test `kode`';
  assert.equal(sanitizeForSpeech(input), 'Halo Nao kode');
});

test('sanitizeForSpeech memotong teks sangat panjang', () => {
  assert.equal(sanitizeForSpeech('a'.repeat(500)).length, 400);
});

test('splitForSpeech memecah kalimat panjang tanpa menghilangkan isi', () => {
  const text =
    'Kalimat pertama pendek. Kalimat kedua juga lumayan panjang sekali supaya tidak digabung. Kalimat ketiga.';
  const parts = splitForSpeech(text, 60);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((part) => part.length <= 60));
  assert.equal(parts.join(' '), text);
});

test('splitForSpeech menggabungkan fragmen yang terlalu pendek', () => {
  assert.deepEqual(splitForSpeech('Iya. Oke. Aku setuju dengan itu.'), [
    'Iya. Oke. Aku setuju dengan itu.',
  ]);
});

test('isAddressed hanya cocok pada kata utuh', () => {
  assert.equal(isAddressed('Nao, halo semuanya', ['Nao']), true);
  assert.equal(isAddressed('halo semuanya', ['Nao']), false);
  assert.equal(isAddressed('naomi cantik', ['Nao']), false);
});

test('stripWakeWords membuang nama bot dari kalimat', () => {
  assert.equal(stripWakeWords('Nao, halo semuanya', ['Nao']), 'halo semuanya');
  assert.equal(stripWakeWords('halo Nao', ['Nao']), 'halo');
  assert.equal(stripWakeWords('Nao', ['Nao']), '');
});

test('EchoFilter mengenali potongan teks yang baru diputar', () => {
  const filter = new EchoFilter();
  filter.remember('Halo semuanya, apa kabar hari ini?');
  assert.equal(filter.matches('halo semuanya apa kabar'), true);
});

test('EchoFilter mengabaikan transkrip pendek dan kalimat lain', () => {
  const filter = new EchoFilter();
  filter.remember('Halo semuanya, apa kabar hari ini?');
  assert.equal(filter.matches('halo'), false);
  assert.equal(filter.matches('aku mau tidur dulu ya'), false);
});

test('EchoFilter melupakan teks setelah jendela waktu lewat', () => {
  const filter = new EchoFilter(1_000);
  filter.remember('Halo semuanya, apa kabar hari ini?', 0);
  assert.equal(filter.matches('halo semuanya apa kabar', 2_000), false);
});
