import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E164_RE, normalizeE164, sha256Hex } from '../src/phone.js';

test('E164_RE accepts valid e164', () => {
  assert.equal(E164_RE.test('+251911234567'), true);
});

test('E164_RE rejects bare local number', () => {
  assert.equal(E164_RE.test('0911234567'), false);
});

test('normalizeE164 passes through e164 input', () => {
  assert.equal(normalizeE164('+251911234567'), '+251911234567');
});

test('normalizeE164 strips spaces and dashes', () => {
  assert.equal(normalizeE164('+251 91 123 4567'), '+251911234567');
  assert.equal(normalizeE164('+251-911-234-567'), '+251911234567');
});

test('normalizeE164 converts 00 prefix to +', () => {
  assert.equal(normalizeE164('00251911234567'), '+251911234567');
});

test('normalizeE164 converts local 0 prefix using default region ET', () => {
  assert.equal(normalizeE164('0911234567'), '+251911234567');
});

test('normalizeE164 returns null for empty / invalid', () => {
  assert.equal(normalizeE164(''), null);
  assert.equal(normalizeE164('abc'), null);
  assert.equal(normalizeE164(null), null);
});

test('sha256Hex matches known vector', async () => {
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
