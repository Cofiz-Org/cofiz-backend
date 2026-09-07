// Registration approve/deny direct FCM push.
// Run from workers/fcm-relay with: node test/auth/registration_decision_push_test.js

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const { handleApproveRegistration, handleDenyRegistration } =
  await import('../../src/auth/handlers.js');

const { privateKey } = await webcrypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign'],
);
const pkcs8B64 = Buffer.from(
  await webcrypto.subtle.exportKey('pkcs8', privateKey),
).toString('base64');
const pemBody = pkcs8B64.match(/.{1,64}/g).join('\n');

const env = {
  FIREBASE_PROJECT_ID: 'test-proj',
  FIREBASE_CLIENT_EMAIL: 'test@test-proj.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----`,
};

const calls = { fcm: [], deleted: [], deleteBeforeFcm: null };

function res(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const userDoc = {
  fields: {
    displayName: { stringValue: 'Abebe' },
    requestedRole: { stringValue: 'admin' },
    pendingFcmToken: { stringValue: 'tok-1' },
  },
};

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  if (u.includes('oauth2.googleapis.com/token')) {
    return res({ access_token: 'test-at' });
  }
  if (u.includes('/messages:send')) {
    if (calls.deleteBeforeFcm === null) {
      calls.deleteBeforeFcm = calls.deleted.length > 0;
    }
    calls.fcm.push(JSON.parse(opts.body));
    return res({ name: 'projects/test-proj/messages/1' });
  }
  if (u.includes('/documents/users/')) {
    if (method === 'DELETE') {
      calls.deleted.push(u);
      return res({});
    }
    if (method === 'PATCH') {
      return res({});
    }
    return res(userDoc);
  }
  throw new Error(`unexpected fetch: ${method} ${u}`);
};

console.log('Testing approve sends direct FCM to pendingFcmToken...');
{
  const result = await handleApproveRegistration('+251911234567', env);
  assert.equal(result.displayName, 'Abebe');
  assert.equal(result.requestedRole, 'admin');
  assert.equal(calls.fcm.length, 1);
  const msg = calls.fcm[0].message;
  assert.equal(msg.token, 'tok-1');
  assert.equal(msg.notification.title, 'Cofiz');
  assert.equal(msg.data.type, 'registrationApproved');
}
console.log('✓ approve push');

console.log('Testing deny reads token before delete, then pushes...');
{
  calls.fcm.length = 0;
  calls.deleted.length = 0;
  calls.deleteBeforeFcm = null;
  await handleDenyRegistration('+251911234567', env);
  assert.equal(calls.deleted.length, 1);
  assert.equal(calls.fcm.length, 1);
  assert.equal(calls.deleteBeforeFcm, true);
  const msg = calls.fcm[0].message;
  assert.equal(msg.token, 'tok-1');
  assert.equal(msg.data.type, 'registrationDenied');
}
console.log('✓ deny push');

console.log('All registration decision push tests passed.');
