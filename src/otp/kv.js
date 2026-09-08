// Shared with src/index.js — keep in sync.
const CODE_TTL = 600;       // 10 min
const RL_TTL = 900;         // 15 min
const RESEND_COOLDOWN = 60; // 60 sec

export async function putCode(env, key, code) {
  await env.OTP_KV.put(`otp:${key}`, code, { expirationTtl: CODE_TTL });
}
export async function getCode(env, key) {
  return env.OTP_KV.get(`otp:${key}`);
}
export async function deleteCode(env, key) {
  return env.OTP_KV.delete(`otp:${key}`);
}

export async function bumpCounter(env, name, key) {
  const k = `rl:${name}:${key}`;
  const cur = parseInt((await env.OTP_KV.get(k)) || '0', 10);
  const next = cur + 1;
  await env.OTP_KV.put(k, String(next), { expirationTtl: RL_TTL });
  return next;
}

export async function putTelegramChat(env, phone, chatId) {
  await env.OTP_KV.put(`tg:phone:${phone}`, String(chatId));
}
export async function getTelegramChat(env, phone) {
  const v = await env.OTP_KV.get(`tg:phone:${phone}`);
  return v ? Number(v) : null;
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomCode() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  const n = bytes[0] % 1_000_000;
  return String(n).padStart(6, '0');
}

export async function hashOtp(challengeId, otp) {
  const input = `${challengeId}:${otp}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function putChallenge(env, phone, challengeId, otpHash) {
  const key = `challenge:${phone}`;
  const data = JSON.stringify({ challengeId, otpHash, attempts: 0, createdAt: Date.now() });
  await env.OTP_KV.put(key, data, { expirationTtl: CODE_TTL });
}

export async function getChallenge(env, phone) {
  const raw = await env.OTP_KV.get(`challenge:${phone}`);
  return raw ? JSON.parse(raw) : null;
}

export async function deleteChallenge(env, phone) {
  await env.OTP_KV.delete(`challenge:${phone}`);
}

export async function incrementAttempts(env, phone) {
  const ch = await getChallenge(env, phone);
  if (!ch) return 0;
  ch.attempts = (ch.attempts || 0) + 1;
  await env.OTP_KV.put(`challenge:${phone}`, JSON.stringify(ch), { expirationTtl: CODE_TTL });
  return ch.attempts;
}

export async function checkResendCooldown(env, phone) {
  const key = `resend:${phone}`;
  const last = await env.OTP_KV.get(key);
  if (last) {
    const elapsed = (Date.now() - Number(last)) / 1000;
    if (elapsed < RESEND_COOLDOWN) return Math.ceil(RESEND_COOLDOWN - elapsed);
  }
  return 0;
}

export async function setResendCooldown(env, phone) {
  await env.OTP_KV.put(`resend:${phone}`, String(Date.now()), { expirationTtl: RESEND_COOLDOWN });
}

export async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
