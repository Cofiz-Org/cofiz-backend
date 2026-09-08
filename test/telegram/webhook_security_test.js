import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, generateKeyPairSync } from 'node:crypto';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const { handleTelegramWebhook, handleTelegramDebug } = await import('../../src/telegram/webhook.js');

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const env = {
  TELEGRAM_BOT_TOKEN: 'dummy',
  DEVELOPER_CHAT_ID: '999',
  RELAY_SECRET: 'relay',
  FIREBASE_PROJECT_ID: 'p',
  FIREBASE_CLIENT_EMAIL: 'svc@p.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: privateKey,
};

function patchCapture(seen) {
  return async (url, opts) => {
    const u = new URL(typeof url === 'string' ? url : url.toString());
    if (u.hostname === 'oauth2.googleapis.com') {
      return new Response(JSON.stringify({ access_token: 'a' }), { status: 200 });
    }
    if (u.hostname === 'api.telegram.org') {
      return new Response('ok', { status: 200 });
    }
    if (opts && opts.method === 'PATCH') {
      seen.patched = true;
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response(JSON.stringify({
      fields: {
        role: { stringValue: 'pending' },
        requestedRole: { stringValue: 'admin' },
        displayName: { stringValue: 'Mallory' },
      },
    }), { status: 200 });
  };
}

function callbackReq(chatId, data) {
  return new Request('https://x/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query: {
        id: 'cq1',
        data,
        message: { chat: { id: chatId }, message_id: 7, text: 'req' },
      },
    }),
  });
}

test('approve callback from stranger chat changes nothing', async () => {
  const seen = {};
  const original = globalThis.fetch;
  globalThis.fetch = patchCapture(seen);
  try {
    const res = await handleTelegramWebhook(callbackReq(666, 'approve:+251911000000'), env);
    assert.equal(res.status, 200);
    assert.equal(seen.patched, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test('approve callback from developer chat applies role', async () => {
  const seen = {};
  const original = globalThis.fetch;
  globalThis.fetch = patchCapture(seen);
  try {
    const res = await handleTelegramWebhook(callbackReq(999, 'approve:+251911000000'), env);
    assert.equal(res.status, 200);
    assert.equal(seen.patched, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('debug endpoint rejects missing relay secret', async () => {
  const req = new Request('https://x/telegram/debug?chat_id=999');
  const res = await handleTelegramDebug(req, env);
  assert.equal(res.status, 401);
});

test('debug endpoint accepts relay secret', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('ok', { status: 200 });
  try {
    const req = new Request('https://x/telegram/debug?chat_id=999', {
      headers: { 'X-Relay-Secret': 'relay' },
    });
    const res = await handleTelegramDebug(req, env);
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = original;
  }
});
