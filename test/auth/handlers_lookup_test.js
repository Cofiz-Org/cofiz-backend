import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, generateKeyPairSync } from 'node:crypto';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const { handleTelegramLogin } = await import('../../src/auth/handlers.js');
const { computeTelegramHash } = await import('../../src/auth/telegram.js');

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const privatePem = privateKey
  .replace('-----BEGIN PRIVATE KEY-----', '')
  .replace('-----END PRIVATE KEY-----', '')
  .replace(/\n/g, '');

const baseEnv = {
  TELEGRAM_BOT_TOKEN: '5768337698:AAH5Y7t9oT6XR_lIq5O9C7bW4Kq5Yq1X2XI',
  FIREBASE_PROJECT_ID: 'p',
  FIREBASE_CLIENT_EMAIL: 'svc@p.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${privatePem}\n-----END PRIVATE KEY-----`,
};

const baseFields = {
  id: 313131,
  first_name: 'Abebe',
  last_name: 'Beso',
  username: 'abebe',
  photo_url: 'https://t.me/i/userpic/320/name.jpg',
  auth_date: 1657994581,
};

async function freshValidFields(overrides = {}) {
  const f = { ...baseFields, ...overrides };
  f.hash = await computeTelegramHash(f, baseEnv.TELEGRAM_BOT_TOKEN);
  return f;
}

function withFetchStub(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = original; });
}

test('handleTelegramLogin returns 400 telegram_no_phone when phone missing', async () => {
  const fields = await freshValidFields();
  delete fields.phone;
  const res = await handleTelegramLogin(
    new Request('https://x/auth/telegram', { method: 'POST', body: JSON.stringify(fields) }),
    baseEnv,
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'telegram_no_phone');
});

test('handleTelegramLogin returns 401 invalid_hash when tampered', async () => {
  const fields = await freshValidFields({ phone: '+251911234567' });
  fields.first_name = 'Other';
  const res = await handleTelegramLogin(
    new Request('https://x/auth/telegram', { method: 'POST', body: JSON.stringify(fields) }),
    baseEnv,
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'invalid_hash');
});

test('handleTelegramLogin returns 403 phone_not_registered when user missing', async () => {
  const fields = await freshValidFields({ phone: '+251911234567' });
  const res = await withFetchStub(async (url) => {
    const u = new URL(typeof url === 'string' ? url : url.toString());
    if (u.hostname === 'oauth2.googleapis.com') {
      return new Response(JSON.stringify({ access_token: 'a' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }, () => handleTelegramLogin(
    new Request('https://x/auth/telegram', { method: 'POST', body: JSON.stringify(fields) }),
    baseEnv,
  ));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'phone_not_registered');
});

test('handleTelegramLogin returns 400 bad_phone for invalid phone', async () => {
  const fields = await freshValidFields({ phone: 'notaphone' });
  const res = await handleTelegramLogin(
    new Request('https://x/auth/telegram', { method: 'POST', body: JSON.stringify(fields) }),
    baseEnv,
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'bad_phone');
});
