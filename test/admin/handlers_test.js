import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, generateKeyPairSync } from 'node:crypto';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const { handleAdminWipe, WIPE_COLLECTIONS } = await import('../../src/admin/handlers.js');

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const privatePem = privateKey
  .replace('-----BEGIN PRIVATE KEY-----', '')
  .replace('-----END PRIVATE KEY-----', '')
  .replace(/\n/g, '');

const env = {
  FIREBASE_PROJECT_ID: 'p',
  FIREBASE_CLIENT_EMAIL: 'svc@p.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${privatePem}\n-----END PRIVATE KEY-----`,
  WIPE_BEARER: 'good',
  RELAY_SECRET: 'relay',
};

function post(token) {
  return new Request('https://x/admin/wipe-firestore', {
    method: 'POST',
    headers: { authorization: token ? `Bearer ${token}` : '' },
  });
}

test('401 without bearer', async () => {
  const res = await handleAdminWipe(post(null), env, {});
  assert.equal(res.status, 401);
});

test('403 with wrong bearer', async () => {
  const res = await handleAdminWipe(post('nope'), env, {});
  assert.equal(res.status, 403);
});

test('405 with non-POST', async () => {
  const req = new Request('https://x/admin/wipe-firestore', {
    method: 'GET',
    headers: { authorization: 'Bearer good' },
  });
  const res = await handleAdminWipe(req, env, {});
  assert.equal(res.status, 405);
});

test('200 with correct bearer and empty Firestore', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(typeof url === 'string' ? url : url.toString());
    if (u.hostname === 'oauth2.googleapis.com') {
      return new Response(JSON.stringify({ access_token: 'a' }), { status: 200 });
    }
    return new Response(JSON.stringify({ documents: [] }), { status: 200 });
  };
  try {
    const res = await handleAdminWipe(post('good'), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.deleted, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('200 with 5 docs per collection batched into commit', async () => {
  const calls = { list: 0, commit: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = new URL(typeof url === 'string' ? url : url.toString());
    if (u.hostname === 'oauth2.googleapis.com') {
      return new Response(JSON.stringify({ access_token: 'a' }), { status: 200 });
    }
    if (opts && opts.method === 'POST' && u.pathname.endsWith(':commit')) {
      calls.commit++;
      return new Response(JSON.stringify({ writeResults: [] }), { status: 200 });
    }
    calls.list++;
    const docs = Array.from({ length: 5 }, (_, i) => ({
      name: `projects/p/databases/(default)/documents/users/u${i}`,
    }));
    return new Response(JSON.stringify({ documents: docs }), { status: 200 });
  };
  try {
    const res = await handleAdminWipe(post('good'), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deleted, WIPE_COLLECTIONS.length * 5);
  } finally {
    globalThis.fetch = original;
  }
});
