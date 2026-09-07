// Auth routes:
//   POST /auth/telegram      — Telegram Login Widget (one-tap sign-in)
//   POST /auth/whatsapp/start — WhatsApp OTP start
//   POST /auth/whatsapp/verify — WhatsApp OTP verify
//
// Telegram widget hash validation lives in ./telegram.js (this dir).
// Mini App init data validation (used by WhatsApp OTP path) lives in ../otp/telegram.js.

import { putCode, getCode, deleteCode, bumpCounter, getTelegramChat, putTelegramChat, randomCode, sha256Hex, timingSafeEqual, hashOtp, putChallenge, getChallenge, deleteChallenge, incrementAttempts, checkResendCooldown, setResendCooldown } from '../otp/kv.js';
import { sendTelegramCode, validateTelegramInitData } from '../otp/telegram.js';
import { sendWhatsAppCode } from '../otp/whatsapp.js';
import { createCustomToken } from '../otp/custom_token.js';
import { validateTelegramHash } from './telegram.js';
import { normalizeE164, E164_RE } from '../phone.js';

const E164 = E164_RE;
const ALLOWED_PROVIDERS = new Set(['telegram', 'whatsapp']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleWhatsappStart(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'bad_json' }, 400);
  }
  const { phone } = body || {};
  if (!phone) return json({ error: 'bad_request' }, 400);
  const phoneE164 = normalizeE164(phone);
  if (!phoneE164 || !E164_RE.test(phoneE164)) return json({ error: 'bad_phone', message: 'Invalid phone number. Use format 09XXXXXXXX or +2519XXXXXXXX.' }, 400);

  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const ipCount = await bumpCounter(env, 'rl:ip', ip);
  if (ipCount > 20) return json({ error: 'rate_limited' }, 429);

  const phoneCount = await bumpCounter(env, 'rl:start', phoneE164);
  if (phoneCount > 3) return json({ error: 'rate_limited', message: 'Too many requests. Try again later.' }, 429);

  const cooldown = await checkResendCooldown(env, phoneE164);
  if (cooldown > 0) return json({ error: 'cooldown', message: `Wait ${cooldown}s before resending.` }, 429);

  const challengeId = await sha256Hex(`${phoneE164}:${Date.now()}:${crypto.randomUUID()}`);
  const otp = randomCode();
  const otpHash = await hashOtp(challengeId, otp);
  await putChallenge(env, phoneE164, challengeId, otpHash);
  await setResendCooldown(env, phoneE164);

  try {
    await sendWhatsAppCode(env, phoneE164, otp);
  } catch (e) {
    await deleteChallenge(env, phoneE164);
    return json({ error: 'whatsapp_send_failed', message: 'Could not send WhatsApp code. Try again.', meta: String(e.message || e).slice(0, 300) }, 502);
  }

  return json({ challengeId, expiresIn: 600 });
}

export async function handleWhatsappVerify(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'bad_json' }, 400);
  }
  const { phone, challengeId, code } = body || {};
  if (!phone || !challengeId || !code) return json({ error: 'bad_request' }, 400);
  const phoneE164 = normalizeE164(phone);
  if (!phoneE164 || !E164_RE.test(phoneE164)) return json({ error: 'bad_phone', message: 'Invalid phone number. Use format 09XXXXXXXX or +2519XXXXXXXX.' }, 400);

  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const ipCount = await bumpCounter(env, 'rl:verify', ip);
  if (ipCount > 30) return json({ error: 'rate_limited' }, 429);

  const challenge = await getChallenge(env, phoneE164);
  if (!challenge) return json({ error: 'expired', message: 'Code expired. Request a new one.' }, 400);
  if (challenge.challengeId !== challengeId) return json({ error: 'wrong_challenge' }, 400);
  if (challenge.attempts >= 5) {
    await deleteChallenge(env, phoneE164);
    return json({ error: 'locked', message: 'Too many attempts. Request a new code.' }, 429);
  }

  const suppliedHash = await hashOtp(challengeId, code);
  if (!timingSafeEqual(suppliedHash, challenge.otpHash)) {
    const attempts = await incrementAttempts(env, phoneE164);
    if (attempts >= 5) {
      await deleteChallenge(env, phoneE164);
      return json({ error: 'locked', message: 'Too many attempts. Request a new code.' }, 429);
    }
    return json({ error: 'bad_code', message: `Wrong code. ${5 - attempts} attempts left.` }, 400);
  }

  await deleteChallenge(env, phoneE164);
  const uid = await sha256Hex(phoneE164);
  const accessToken = await getAccessToken(env);
  const userUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  const head = await fetch(userUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (head.status === 404) {
    return json({ error: 'phone_not_registered', message: 'This phone is not in the workspace.' }, 403);
  }
  if (!head.ok) return json({ error: 'firestore_unavailable' }, 502);
  const userDoc = await head.json();
  if (userDoc.fields?.role?.stringValue === 'pending') {
    return json({ error: 'pending_approval', message: 'Your account is pending approval. You will be notified once approved.' }, 403);
  }
  const loginMask = `updateMask.fieldPaths=${encodeURIComponent('lastLoginAt')}`;
  await fetch(`${userUrl}?${loginMask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFields({ lastLoginAt: Date.now() }) }),
  });
  const customToken = await createCustomToken(env, uid);
  return json({ customToken, uid, isNewUser: false });
}

export async function handleWhatsappResend(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'bad_json' }, 400);
  }
  const { phone } = body || {};
  if (!phone) return json({ error: 'bad_request' }, 400);
  const phoneE164 = normalizeE164(phone);
  if (!phoneE164 || !E164_RE.test(phoneE164)) return json({ error: 'bad_phone', message: 'Invalid phone number. Use format 09XXXXXXXX or +2519XXXXXXXX.' }, 400);

  const cooldown = await checkResendCooldown(env, phoneE164);
  if (cooldown > 0) return json({ error: 'cooldown', message: `Wait ${cooldown}s before resending.` }, 429);

  await deleteChallenge(env, phoneE164);

  const phoneCount = await bumpCounter(env, 'rl:start', phoneE164);
  if (phoneCount > 3) return json({ error: 'rate_limited', message: 'Too many requests. Try again later.' }, 429);

  const challengeId = await sha256Hex(`${phoneE164}:${Date.now()}:${crypto.randomUUID()}`);
  const otp = randomCode();
  const otpHash = await hashOtp(challengeId, otp);
  await putChallenge(env, phoneE164, challengeId, otpHash);
  await setResendCooldown(env, phoneE164);

  try {
    await sendWhatsAppCode(env, phoneE164, otp);
  } catch (e) {
    await deleteChallenge(env, phoneE164);
    return json({ error: 'whatsapp_send_failed', message: 'Could not send WhatsApp code. Try again.', meta: String(e.message || e).slice(0, 300) }, 502);
  }

  return json({ challengeId, expiresIn: 600 });
}

// POST /auth/telegram — Telegram Login Widget callback.
// Body: { id, first_name, last_name?, username?, photo_url?, auth_date, hash, phone? }
//
// Validates the hash using the official Login Widget algorithm, requires the
// user to have granted phone access (`request_access=write`), then looks up the
// pre-provisioned `users/{sha256(phone)}` record. If absent, rejects with
// `phone_not_registered`. On success, PATCHes telegramId/lastLoginAt and
// returns a Firebase custom token keyed by the same uid.
export async function handleTelegramLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'bad_json' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return json({ error: 'bad_request' }, 400);
  }
  const { id, first_name, last_name, username, photo_url, auth_date, hash, phone } = body;
  if (id == null || !first_name || !auth_date || !hash) {
    return json({ error: 'missing_fields' }, 400);
  }
  if (!(await validateTelegramHash(body, env.TELEGRAM_BOT_TOKEN))) {
    return json({ error: 'invalid_hash' }, 401);
  }
  if (!phone) {
    return json({ error: 'telegram_no_phone', message: 'Telegram did not share a phone. Re-open with request_access=write.' }, 400);
  }
  const phoneE164 = normalizeE164(phone);
  if (!phoneE164 || !E164_RE.test(phoneE164)) {
    return json({ error: 'bad_phone', message: 'Invalid phone number. Use format 09XXXXXXXX or +2519XXXXXXXX.' }, 400);
  }
  const uid = await sha256Hex(phoneE164);
  const accessToken = await getAccessToken(env);
  const firestoreBase = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const userUrl = `${firestoreBase}/users/${encodeURIComponent(uid)}`;
  const head = await fetch(userUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (head.status === 404) {
    return json({ error: 'phone_not_registered', message: 'This phone is not in the workspace.' }, 403);
  }
  if (!head.ok) {
    return json({ error: 'firestore_unavailable' }, 502);
  }
  const userDoc = await head.json();
  if (userDoc.fields?.role?.stringValue === 'pending') {
    return json({ error: 'pending_approval', message: 'Your account is pending approval. You will be notified once approved.' }, 403);
  }
  const patchFields = {
    telegramId: Number(id),
    lastLoginAt: Date.now(),
  };
  const displayName = `${first_name} ${last_name || ''}`.trim();
  if (displayName) patchFields.displayName = displayName;
  if (photo_url) patchFields.photoUrl = photo_url;
  if (username) patchFields.username = username;
  const mask = Object.keys(patchFields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const patch = await fetch(`${userUrl}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFields(patchFields) }),
  });
  if (!patch.ok) {
    return json({ error: 'firestore_patch_failed' }, 502);
  }
  const customToken = await createCustomToken(env, uid);
  return json({ customToken, uid, isNewUser: false });
}

let jwksCache = null;
let jwksCacheAt = 0;
const JWKS_TTL_MS = 3600 * 1000;

async function getJwks() {
  const now = Date.now();
  if (jwksCache && (now - jwksCacheAt) < JWKS_TTL_MS) return jwksCache;
  const res = await fetch('https://oauth.telegram.org/.well-known/jwks.json');
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  jwksCache = await res.json();
  jwksCacheAt = now;
  return jwksCache;
}

function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyTelegramIdToken(idToken, env) {
  const parts = idToken.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts;
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  console.log('Telegram ID token payload:', JSON.stringify({ iss: payload.iss, aud: payload.aud, exp: payload.exp, sub: payload.sub, phone_number: payload.phone_number }));
  console.log('Expected TELEGRAM_CLIENT_ID:', env.TELEGRAM_CLIENT_ID, 'typeof:', typeof env.TELEGRAM_CLIENT_ID);
  if (payload.iss !== 'https://oauth.telegram.org') return { ok: false, reason: 'bad_iss' };
  if (String(payload.aud) !== env.TELEGRAM_CLIENT_ID) return { ok: false, reason: 'bad_aud' };
  if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' };
  }
  const jwks = await getJwks();
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'kid_not_found' };
  const alg = jwk.alg || (header.alg === 'ES256' ? 'ES256' : 'RS256');
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } : { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const sigBytes = b64urlToBytes(s);
  const data = new TextEncoder().encode(`${h}.${p}`);
  const ok = await crypto.subtle.verify(
    alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' },
    key,
    sigBytes,
    data,
  );
  if (!ok) return { ok: false, reason: 'bad_signature' };
  return { ok: true, payload };
}

export async function handleTelegramNative(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const idToken = body && body.idToken;
  if (!idToken || typeof idToken !== 'string') return json({ error: 'missing_id_token' }, 400);
  const v = await verifyTelegramIdToken(idToken, env);
  if (!v.ok) {
    console.log('Telegram native token verify failed:', v.reason, 'aud_check:', env.TELEGRAM_CLIENT_ID);
    return json({ error: `token_${v.reason}`, message: `Token verification failed: ${v.reason}` }, 401);
  }
  const { sub, phone_number, name, preferred_username, picture } = v.payload;
  if (!sub) return json({ error: 'missing_sub' }, 400);
  if (!phone_number) return json({ error: 'telegram_no_phone' }, 400);
  const phoneE164 = normalizeE164(phone_number);
  if (!phoneE164 || !E164_RE.test(phoneE164)) return json({ error: 'bad_phone', message: `Invalid phone format from Telegram: "${phone_number}". Expected E.164 format (e.g. +251911223344).` }, 400);
  const uid = await sha256Hex(phoneE164);
  const accessToken = await getAccessToken(env);
  const firestoreBase = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const userUrl = `${firestoreBase}/users/${encodeURIComponent(uid)}`;
  const head = await fetch(userUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (head.status === 404) {
    return json({ error: 'phone_not_registered', message: 'Ask your admin to register this phone.' }, 403);
  }
  if (!head.ok) return json({ error: 'firestore_unavailable' }, 502);
  const userDoc = await head.json();
  const existing = (field) => {
    const v = userDoc.fields?.[field];
    return v && (v.stringValue || v.integerValue);
  };
  const patchFields = { lastLoginAt: Date.now() };
  if (!existing('displayName') && name) patchFields.displayName = name;
  if (!existing('photoUrl') && picture) patchFields.photoUrl = picture;
  if (Object.keys(patchFields).length <= 1) {
    const customToken = await createCustomToken(env, uid);
    return json({ customToken, uid, isNewUser: false });
  }
  const mask = Object.keys(patchFields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  await fetch(`${userUrl}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFields(patchFields) }),
  });
  const customToken = await createCustomToken(env, uid);
  return json({ customToken, uid, isNewUser: false });
}

export async function handleTelegramLoginGet(request, env) {
  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());
  if (params.code) {
    const code = params.code;
    const verifier = params.state || '';
    const redirectUri = `https://cofiz.natanim.dev/auth/telegram/login`;
    const TELEGRAM_APP_ID = '8777989279';
    const tokenBody = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: TELEGRAM_APP_ID });
    if (verifier) tokenBody.set('code_verifier', verifier);
    const basic = btoa(`${TELEGRAM_APP_ID}:${env.TELEGRAM_CLIENT_SECRET}`);
    let tokenRes;
    try {
      tokenRes = await fetch('https://oauth.telegram.org/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basic}` }, body: tokenBody });
    } catch (e) { return new Response('Token fetch failed', { status: 502 }); }
    if (!tokenRes.ok) {
      const t = await tokenRes.text();
      return new Response(`Token exchange failed: ${tokenRes.status} ${t}`, { status: 502 });
    }
    const tokenJson = await tokenRes.json();
    const idToken = tokenJson.id_token;
    if (!idToken) return new Response('Missing id_token', { status: 502 });
    let payload;
    try {
      const parts = idToken.split('.');
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      payload = JSON.parse(atob(b64));
      if (payload.iss !== 'https://oauth.telegram.org' || String(payload.aud) !== '8777989279') return new Response('Bad token claims', { status: 502 });
      if (payload.exp && payload.exp < Math.floor(Date.now()/1000)) return new Response('Token expired', { status: 502 });
    } catch { return new Response('Bad id_token', { status: 502 }); }
    const phone = payload.phone_number;
    const tid = payload.id || payload.sub;
    if (!phone) return new Response('Phone not shared. Approve phone in Telegram sheet.', { status: 400 });
    const phoneE164 = normalizeE164(phone);
    if (!phoneE164 || !E164_RE.test(phoneE164)) return new Response('Invalid phone', { status: 400 });
    const uid = await sha256Hex(phoneE164);
    const accessToken = await getAccessToken(env);
    const firestoreBase = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
    const userUrl = `${firestoreBase}/users/${encodeURIComponent(uid)}`;
    const head = await fetch(userUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (head.status === 404) return new Response('Phone not registered. Ask admin to create your account.', { status: 403 });
    if (!head.ok) return new Response('Firestore unavailable', { status: 502 });
    const userDoc = await head.json();
    if (userDoc.fields?.role?.stringValue === 'pending') {
      return new Response('Your account is pending approval. You will be notified once approved.', { status: 403 });
    }
    const patchFields = { telegramId: Number(tid), lastLoginAt: Date.now() };
    if (payload.name) patchFields.displayName = payload.name;
    if (payload.picture) patchFields.photoUrl = payload.picture;
    if (payload.preferred_username) patchFields.username = payload.preferred_username;
    const mask = Object.keys(patchFields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    await fetch(`${userUrl}?${mask}`, { method: 'PATCH', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: encodeFields(patchFields) }) });
    const customToken = await createCustomToken(env, uid);
    const redirect = `cofiz://auth/telegram/success?customToken=${encodeURIComponent(customToken)}&uid=${encodeURIComponent(uid)}`;
    return Response.redirect(redirect, 302);
  }
  const { id, first_name, last_name, username, photo_url, auth_date, hash } = params;
  if (id == null || !first_name || !auth_date || !hash) {
    return new Response('Missing fields', { status: 400 });
  }
  if (!(await validateTelegramHash(params, env.TELEGRAM_BOT_TOKEN))) {
    return new Response('Invalid hash', { status: 401 });
  }
  let phone = params.phone;
  if (!phone) {
    return new Response('Phone not shared', { status: 400 });
  }
  const phoneE164 = normalizeE164(phone);
  if (!phoneE164 || !E164_RE.test(phoneE164)) {
    return new Response('Invalid phone', { status: 400 });
  }
  const uid = await sha256Hex(phoneE164);
  const accessToken = await getAccessToken(env);
  const firestoreBase = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const userUrl = `${firestoreBase}/users/${encodeURIComponent(uid)}`;
  const head = await fetch(userUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (head.status === 404) {
    return new Response('Phone not registered. Ask admin to create your account.', { status: 403 });
  }
  if (!head.ok) {
    return new Response('Firestore unavailable', { status: 502 });
  }
  const patchFields = {
    telegramId: Number(id),
    lastLoginAt: Date.now(),
  };
  const displayName = `${first_name} ${last_name || ''}`.trim();
  if (displayName) patchFields.displayName = displayName;
  if (photo_url) patchFields.photoUrl = photo_url;
  if (username) patchFields.username = username;
  const mask = Object.keys(patchFields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  await fetch(`${userUrl}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFields(patchFields) }),
  });
  const customToken = await createCustomToken(env, uid);
  const redirect = `cofiz://auth/telegram/success?customToken=${encodeURIComponent(customToken)}&uid=${encodeURIComponent(uid)}`;
  return Response.redirect(redirect, 302);
}

// ---- Firestore REST helpers (used by /auth/telegram) ----
//
// Uses the Firestore REST API with an OAuth2 access token minted from
// the service account (FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY).
// Reuses the same JWT-bearer token pattern as the main relay index.js.

async function getAccessToken(env) {
  const FIREBASE_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
  const b64url = (bytes) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  const pemToPkcs8 = (pem) => {
    const b64 = pem
      .replace(/-----BEGIN PRIVATE KEY-----/, '')
      .replace(/-----END PRIVATE KEY-----/, '')
      .replace(/\\n/g, '\n')
      .replace(/[^\nA-Za-z0-9+/=]/g, '');
    const raw = atob(b64);
    const buf = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
    return buf.buffer;
  };
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(new TextEncoder().encode(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: FIREBASE_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(env.FIREBASE_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  const jwt = `${header}.${claims}.${b64url(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const j = await res.json();
  return j.access_token;
}

function encodeField(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  return { stringValue: String(val) };
}

function encodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = encodeField(v);
  return fields;
}

async function sendTelegramMessage(env, chatId, text, replyMarkup) {
  const payload = { chat_id: chatId, text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  console.log('sendTelegramMessage', chatId, res.status, body);
  return { status: res.status, body };
}

export async function handleEmailRequest(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const { uid } = body || {};
  if (!uid || typeof uid !== 'string') return json({ error: 'bad_request' }, 400);
  if (!env.RESEND_API_KEY) return json({ error: 'email_unavailable', message: 'Email service not configured.' }, 503);
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  const ipCount = await bumpCounter(env, 'email:ip', ip);
  if (ipCount > 20) return json({ error: 'rate_limited' }, 429);
  const accessToken = await getAccessToken(env);
  const firestoreBase = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const userUrl = `${firestoreBase}/users/${encodeURIComponent(uid)}`;
  const head = await fetch(userUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!head.ok) {
    if (head.status === 404) return json({ error: 'no_email', message: 'Account has no email address to verify.' }, 400);
    return json({ error: 'firestore_unavailable' }, 502);
  }
  const userDoc = await head.json();
  const email = userDoc.fields?.email?.stringValue;
  if (!email) return json({ error: 'no_email', message: 'Account has no email address to verify.' }, 400);
  const cdKey = `emailcd:${uid}`;
  const last = await env.OTP_KV.get(cdKey);
  if (last && (Date.now() - Number(last)) / 1000 < 60) {
    return json({ error: 'cooldown', message: 'Wait a minute before resending.' }, 429);
  }
  const code = randomCode();
  const salt = crypto.randomUUID();
  const codeHash = await sha256Hex(`${salt}:${code}`);
  await env.OTP_KV.put(`email:${uid}`, JSON.stringify({ email, codeHash, salt, attempts: 0 }), { expirationTtl: 600 });
  await env.OTP_KV.put(cdKey, String(Date.now()), { expirationTtl: 60 });
  const from = env.EMAIL_FROM || 'Cofiz <noreply@natanim.dev>';
  let sent = false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [email],
        subject: 'Your Cofiz verification code',
        text: `Your verification code is ${code}. It expires in 10 minutes.`,
      }),
    });
    sent = res.ok;
  } catch (_) {
    sent = false;
  }
  if (!sent) {
    await env.OTP_KV.delete(`email:${uid}`);
    return json({ error: 'email_send_failed', message: 'Could not send email. Try again.' }, 502);
  }
  return json({ ok: true });
}

export async function handleEmailVerify(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const { uid, code } = body || {};
  if (!uid || typeof uid !== 'string' || typeof code !== 'string') {
    return json({ error: 'bad_request' }, 400);
  }
  const raw = await env.OTP_KV.get(`email:${uid}`);
  if (!raw) return json({ error: 'not_found', message: 'No code requested yet. Tap resend.' }, 404);
  const doc = JSON.parse(raw);
  if ((doc.attempts || 0) >= 5) {
    await env.OTP_KV.delete(`email:${uid}`);
    return json({ error: 'too_many', message: 'Too many attempts. Resend code.' }, 429);
  }
  const hash = await sha256Hex(`${doc.salt}:${code.trim()}`);
  if (hash !== doc.codeHash) {
    doc.attempts = (doc.attempts || 0) + 1;
    await env.OTP_KV.put(`email:${uid}`, JSON.stringify(doc), { expirationTtl: 600 });
    return json({ error: 'bad_code', message: 'Invalid code. Try again.' }, 400);
  }
  const accessToken = await getAccessToken(env);
  const firestoreBase = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
  const userUrl = `${firestoreBase}/users/${encodeURIComponent(uid)}`;
  const patch = await fetch(`${userUrl}?updateMask.fieldPaths=${encodeURIComponent('emailVerified')}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFields({ emailVerified: true }) }),
  });
  if (!patch.ok) return json({ error: 'firestore_patch_failed' }, 502);
  await env.OTP_KV.delete(`email:${uid}`);
  return json({ verified: true });
}

export async function handleRegister(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const { phone, displayName, companyName, requestedRole, fcmToken } = body || {};
  if (!phone || !displayName || !companyName || !requestedRole) {
    return json({ error: 'bad_request', message: 'phone, displayName, companyName, requestedRole required' }, 400);
  }
  if (!['admin', 'viewer'].includes(requestedRole)) {
    return json({ error: 'bad_role', message: 'requestedRole must be admin or viewer' }, 400);
  }
  const phoneE164 = normalizeE164(phone);
  if (!phoneE164 || !E164_RE.test(phoneE164)) return json({ error: 'bad_phone', message: 'Invalid phone number. Use format 09XXXXXXXX or +2519XXXXXXXX.' }, 400);

  const uid = await sha256Hex(phoneE164);
  const accessToken = await getAccessToken(env);
  const userUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  const existing = await fetch(userUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (existing.ok) {
    const doc = await existing.json();
    const role = doc.fields?.role?.stringValue;
    if (role && role !== 'pending') {
      return json({ error: 'already_registered', message: 'This phone is already registered.' }, 409);
    }
    if (role === 'pending') {
      return json({ error: 'pending_approval', message: 'Registration already pending approval.' }, 409);
    }
  }

  const fields = {
    uid,
    phone: phoneE164,
    role: 'pending',
    requestedRole,
    displayName,
    companyName,
    isActive: false,
    createdAt: Date.now(),
  };
  if (typeof fcmToken === 'string' && fcmToken.length > 0) {
    fields.pendingFcmToken = fcmToken;
  }
  const mask = Object.keys(fields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  await fetch(`${userUrl}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFields(fields) }),
  });

  if (env.DEVELOPER_CHAT_ID) {
    const keyboard = {
      inline_keyboard: [
        [
          { text: 'Approve', callback_data: `approve:${phoneE164}` },
          { text: 'Deny', callback_data: `deny:${phoneE164}` },
        ],
      ],
    };
    const tgResult = await sendTelegramMessage(
      env,
      env.DEVELOPER_CHAT_ID,
      `New registration request\n\nName: ${displayName}\nPhone: ${phoneE164}\nCompany: ${companyName}\nRole: ${requestedRole}`,
      keyboard,
    );
    console.log('DEVELOPER_CHAT_ID:', env.DEVELOPER_CHAT_ID, 'result:', JSON.stringify(tgResult));
  } else {
    console.log('DEVELOPER_CHAT_ID is empty/undefined');
  }

  return json({ ok: true, message: 'Registration submitted. Waiting for approval.' });
}

async function sendDecisionPush(env, accessToken, fcmToken, { body, type }) {
  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: fcmToken,
            notification: { title: 'Cofiz', body },
            data: { type, click_action: 'FLUTTER_NOTIFICATION_CLICK' },
            android: {
              priority: 'high',
              notification: { channelId: 'cofiz_main_channel' },
            },
          },
        }),
      },
    );
    return res.ok;
  } catch (_) {
    return false;
  }
}

export async function handleApproveRegistration(phoneE164, env) {
  const uid = await sha256Hex(phoneE164);
  const accessToken = await getAccessToken(env);
  const userUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  const docRes = await fetch(userUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!docRes.ok) return null;
  const doc = await docRes.json();
  const requestedRole = doc.fields?.requestedRole?.stringValue || 'admin';
  const displayName = doc.fields?.displayName?.stringValue || '';
  const patchFields = { role: requestedRole, isActive: true, lastLoginAt: Date.now() };
  const mask = Object.keys(patchFields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  await fetch(`${userUrl}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFields(patchFields) }),
  });
  const pushToken = doc.fields?.pendingFcmToken?.stringValue || doc.fields?.fcmToken?.stringValue;
  if (pushToken) {
    await sendDecisionPush(env, accessToken, pushToken, {
      body: `Hi ${displayName}, your Cofiz registration was approved. You can now sign in.`,
      type: 'registrationApproved',
    });
  }
  return { displayName, requestedRole };
}

export async function handleDenyRegistration(phoneE164, env) {
  const uid = await sha256Hex(phoneE164);
  const accessToken = await getAccessToken(env);
  const userUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
  let pushToken = null;
  try {
    const docRes = await fetch(userUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (docRes.ok) {
      const doc = await docRes.json();
      pushToken = doc.fields?.pendingFcmToken?.stringValue || doc.fields?.fcmToken?.stringValue;
    }
  } catch (_) {}
  await fetch(userUrl, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (pushToken) {
    await sendDecisionPush(env, accessToken, pushToken, {
      body: 'Your Cofiz registration was not approved. Please contact your admin.',
      type: 'registrationDenied',
    });
  }
}
