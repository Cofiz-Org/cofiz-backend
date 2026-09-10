// Cofiz FCM relay - deploy to Cloudflare Workers.
// Receives {targetUserId, title, body, type} from the app, looks up the
// target user's fcmToken in Firestore via REST, and sends the push through
// FCM HTTP v1 - all authenticated with a Firebase service account passed
// as environment variables.

import { handleTelegramLogin, handleTelegramLoginGet, handleTelegramNative, handleEmailRequest, handleEmailVerify, handleWhatsappStart, handleWhatsappVerify, handleWhatsappResend, handleRegister } from './auth/index.js';
import { handleAdminWipe, handleAdminCheck } from './admin/handlers.js';
import { handleTelegramWebhook, handleTelegramDebug } from './telegram/webhook.js';
import { sendDailyDebtDigest } from './cron/debt-reminder.js';


const FIREBASE_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const FIRESTORE_HOST = "firestore.googleapis.com";
const FCM_ENDPOINT = "https://fcm.googleapis.com/v1/projects";

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const pemToPkcs8 = (pem) => {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\\n/g, "\n")
    .replace(/[^\nA-Za-z0-9+/=]/g, "");
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
};

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64url(new TextEncoder().encode(JSON.stringify({
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: FIREBASE_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(env.FIREBASE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  const jwt = `${header}.${claims}.${b64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const json = await res.json();
  return json.access_token;
}

async function getFcmToken(env, accessToken, uid) {
  const url = `https://${FIRESTORE_HOST}/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`user lookup failed: ${res.status}`);
  const doc = await res.json();
  const data = decodeDoc(doc);
  if (!shouldSendPush(data)) return null;
  const token = data && typeof data.fcmToken === 'string' ? data.fcmToken : null;
  return token || null;
}

export function shouldSendPush(userData) {
  if (!userData) return true;
  return userData.pushNotificationsEnabled !== false;
}

async function sendPush(env, accessToken, fcmToken, payload) {
  const extras = {};
  if (payload.data && typeof payload.data === "object") {
    for (const [k, v] of Object.entries(payload.data)) extras[k] = String(v);
  }
  const message = {    message: {
      token: fcmToken,
      notification: { title: payload.title, body: payload.body },
      data: {
        type: payload.type || "info",
        click_action: "FLUTTER_NOTIFICATION_CLICK",
        ...extras,
      },
      android: {
        priority: "high",
        notification: {
          channelId: "cofiz_main_channel",
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: { payload: { aps: { sound: "default", badge: 1 } } },
    },
  };
  const res = await fetch(
    `${FCM_ENDPOINT}/${env.FIREBASE_PROJECT_ID}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    },
  );
  if (!res.ok) {
    const errBody = await res.text();
    console.error(`FCM send failed: ${res.status} ${errBody}`);
    // Stale token cleanup
    if (errBody.includes("registration-token-not-registered") ||
        errBody.includes("invalid-registration-token") ||
        errBody.includes("unregistered")) {
      await fetch(
        `https://${FIRESTORE_HOST}/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${payload.targetUserId}?updateMask.fieldPaths=fcmToken`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ fields: {} }),
        },
      );
    }
    return { ok: false, ...summarizeFcmError(res.status, errBody) };
  }
  return { ok: true };
}

// FCM v1 errors look like {"error":{"code":404,"message":"...","status":"NOT_FOUND"}}.
// Surface status + message (no tokens or secrets in these bodies) so callers
// can tell stale-token apart from project/config problems.
function summarizeFcmError(status, body) {
  try {
    const e = JSON.parse(body).error || {};
    return {
      fcmStatus: status,
      fcmCode: e.status || "UNKNOWN",
      fcmMessage: String(e.message || "").slice(0, 160),
    };
  } catch (_) {
    return { fcmStatus: status, fcmCode: "UNKNOWN", fcmMessage: String(body).slice(0, 160) };
  }
}

// ---- Cron helpers (exported for tests) ----

export function parseTimeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

export function isInWindow(baseTimeStr, nowMinutes) {
  const baseMin = parseTimeToMinutes(baseTimeStr);
  if (baseMin === null) return false;
  // Cron runs every 30 min; allow exact match at +0/+30/+60
  const offsets = [0, 30, 60];
  return offsets.some((o) => nowMinutes === baseMin + o);
}

export function getAddisNow(date = new Date()) {
  // Converts any instant to Addis wall-time Date (Africa/Addis_Ababa = UTC+3, no DST)
  // by extracting locale string then re-parsing as local.
  return new Date(date.toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' }));
}

export function formatAddisDate(addisNow) {
  const y = addisNow.getFullYear();
  const m = String(addisNow.getMonth() + 1).padStart(2, '0');
  const d = String(addisNow.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getAddisDayBoundsMs(addisNow) {
  const y = addisNow.getFullYear();
  const m = addisNow.getMonth();
  const d = addisNow.getDate();
  // Date.UTC gives UTC midnight of Addis calendar date; subtract 3h to get true UTC instant of Addis midnight
  const startMs = Date.UTC(y, m, d) - 3 * 3600 * 1000;
  const endMs = startMs + 24 * 3600 * 1000;
  return { startMs, endMs };
}

// ---- Firestore REST helpers for cron ----

function decodeField(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue === true || v.booleanValue === 'true';
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = decodeField(val);
    return out;
  }
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeField);
  return null;
}

function decodeDoc(doc) {
  if (!doc || !doc.fields) return null;
  const out = {};
  for (const [k, v] of Object.entries(doc.fields)) out[k] = decodeField(v);
  return out;
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

async function getDoc(env, accessToken, path) {
  const url = `https://${FIRESTORE_HOST}/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getDoc ${path} failed: ${res.status}`);
  const doc = await res.json();
  return decodeDoc(doc);
}

async function setDoc(env, accessToken, path, data) {
  const url = `https://${FIRESTORE_HOST}/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const fields = encodeFields(data);
  // PATCH with updateMask for each field (merge)
  const mask = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const patchUrl = mask ? `${url}?${mask}` : url;
  const res = await fetch(patchUrl, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`setDoc ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function runQuery(env, accessToken, structuredQuery) {
  const url = `https://${FIRESTORE_HOST}/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) throw new Error(`runQuery failed: ${res.status} ${await res.text()}`);
  const arr = await res.json();
  // Each entry is {document?: {...}, readTime?}
  return arr.filter((e) => e.document).map((e) => ({ id: e.document.name.split('/').pop(), data: decodeDoc(e.document), raw: e.document }));
}

async function getUsersByRole(env, accessToken, role) {
  const q = {
    from: [{ collectionId: 'users' }],
    where: { fieldFilter: { field: { fieldPath: 'role' }, op: 'EQUAL', value: { stringValue: role } } },
  };
  const docs = await runQuery(env, accessToken, q);
  return docs.map((d) => d.id);
}

async function hasTransactionToday(env, accessToken, addisNow) {
  const { startMs, endMs } = getAddisDayBoundsMs(addisNow);
  const q = {
    from: [{ collectionId: 'transactions' }],
    where: {
      compositeFilter: {
        op: 'AND',
        filters: [
          { fieldFilter: { field: { fieldPath: 'createdAt' }, op: 'GREATER_THAN_OR_EQUAL', value: { integerValue: String(startMs) } } },
          { fieldFilter: { field: { fieldPath: 'createdAt' }, op: 'LESS_THAN', value: { integerValue: String(endMs) } } },
        ],
      },
    },
    limit: 1,
  };
  const docs = await runQuery(env, accessToken, q);
  return docs.length > 0;
}

async function createNotificationDoc(env, accessToken, targetUserId, title, body, type, senderId = 'system-cron') {
  const url = `https://${FIRESTORE_HOST}/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/notifications`;
  const nowMs = Date.now();
  const fields = encodeFields({
    targetUserId,
    title,
    body,
    type,
    isRead: false,
    createdAt: nowMs,
    senderId,
    senderRole: 'system',
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) console.error(`createNotificationDoc failed: ${res.status} ${await res.text()}`);
  return res.ok;
}

// ---- App-update release announcements ----

// POST /release/announce {tag, notes?} — called by the GitHub Action on
// `release: published`. Fans out an `app_update` push + inbox doc to every
// user with an FCM token. Tapping it only opens Settings; the app re-checks
// fresh before downloading, so delayed pushes can never install stale builds.
async function handleReleaseAnnounce(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }
  const tag = String(body.tag || '');
  if (!tag) return Response.json({ error: 'tag required' }, { status: 400 });
  const notes = String(body.notes || '').slice(0, 500);

  try {
    const accessToken = await getAccessToken(env);
    const docs = await runQuery(env, accessToken, {
      from: [{ collectionId: 'users' }],
      limit: 500,
    });
    let sent = 0, failed = 0, skipped = 0;
    for (const d of docs) {
      const tok = d.data && d.data.fcmToken;
      if (!tok) { skipped++; continue; }
      const pushBody = `${tag} is ready to install`;
      const r = await sendPush(env, accessToken, tok, {
        title: 'New Cofiz update',
        body: pushBody,
        type: 'app_update',
        data: { version: tag },
        targetUserId: d.id,
      });
      if (r.ok) sent++; else failed++;
      await createNotificationDoc(
        env,
        accessToken,
        d.id,
        'New Cofiz update',
        notes ? `${pushBody}\n\n${notes}` : pushBody,
        'app_update',
        'system-release',
      );
    }
    return Response.json({ sent, failed, skipped, total: docs.length });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/telegram/webhook') {
      return handleTelegramWebhook(request, env);
    }
    if (url.pathname === '/telegram/debug') {
      return handleTelegramDebug(request, env);
    }
    if (url.pathname === '/auth/telegram/login' && request.method === 'GET') {
      return handleTelegramLoginGet(request, env);
    }
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response('ok', { status: 200 });
    }
    if (url.pathname === '/debug/telegram' && request.method === 'GET') {
      const chatId = url.searchParams.get('chat_id') || env.DEVELOPER_CHAT_ID;
      if (!chatId) return new Response('chat_id required', { status: 400 });
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: 'Test from Cofiz worker' }),
      });
      const body = await res.text();
      return new Response(JSON.stringify({ status: res.status, body }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/auth/register' && request.method === 'POST') {
      return handleRegister(request, env);
    }
    if (request.method !== "POST") {
      return Response.json({ error: "POST only" }, { status: 405 });
    }
    if (request.headers.get("X-Relay-Secret") !== env.RELAY_SECRET) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    if (url.pathname === '/admin/wipe-firestore') {
      return handleAdminWipe(request, env, ctx);
    }
    if (url.pathname === '/admin/check-firestore') {
      return handleAdminCheck(request, env);
    }
    if (url.pathname === '/release/announce') {
      return handleReleaseAnnounce(request, env);
    }
    if (url.pathname === '/auth/telegram') {
      return handleTelegramLogin(request, env);
    }
    if (url.pathname === '/auth/telegram/native') {
      return handleTelegramNative(request, env);
    }
    if (url.pathname === '/auth/whatsapp/start') {
      return handleWhatsappStart(request, env);
    }
    if (url.pathname === '/auth/whatsapp/verify') {
      return handleWhatsappVerify(request, env);
    }
    if (url.pathname === '/auth/whatsapp/resend') {
      return handleWhatsappResend(request, env);
    }
    if (url.pathname === '/auth/email/request') {
      return handleEmailRequest(request, env);
    }
    if (url.pathname === '/auth/email/verify') {
      return handleEmailVerify(request, env);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (_) {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }
    const { targetUserId, title, body } = payload;
    if (!targetUserId || !title) {
      return Response.json({ error: "targetUserId and title required" }, { status: 400 });
    }

    try {
      const accessToken = await getAccessToken(env);
      const fcmToken = await getFcmToken(env, accessToken, targetUserId);
      if (!fcmToken) {
        return Response.json({ sent: false, reason: "no fcm token" });
      }
      const r = await sendPush(env, accessToken, fcmToken, {
        title,
        body: body ?? "",
        type: payload.type,
      });
      if (r.ok) return Response.json({ sent: true });
      return Response.json(
        { sent: false, reason: "fcm_rejected", fcmStatus: r.fcmStatus, fcmCode: r.fcmCode, fcmMessage: r.fcmMessage },
        { status: 502 },
      );
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    // Cron every 30 min — nightly admin nudge + viewer weekly check-in (Africa/Addis_Ababa)
    try {
      const accessToken = await getAccessToken(env);
      const cfg = (await getDoc(env, accessToken, 'settings/app')) || {};
      const addisNow = getAddisNow(new Date(event?.scheduledTime ? new Date(event.scheduledTime) : Date.now()));
      const nowMin = addisNow.getHours() * 60 + addisNow.getMinutes();
      const todayStr = formatAddisDate(addisNow);

      // Nightly admin nudge: base +0/+30/+60
      if (cfg.reminderEnabled !== false && cfg.adminReminderTime) {
        const baseStr = String(cfg.adminReminderTime);
        if (isInWindow(baseStr, nowMin)) {
          if (cfg.lastReminderDate !== todayStr) {
            const hasTx = await hasTransactionToday(env, accessToken, addisNow);
            if (!hasTx) {
              const admins = await getUsersByRole(env, accessToken, 'admin');
              for (const uid of admins) {
                const tok = await getFcmToken(env, accessToken, uid);
                if (tok) {
                  await sendPush(env, accessToken, tok, {
                    title: 'Cofiz',
                    body: "No transaction recorded today — add today's purchases/distributions",
                    type: 'nightlyNoRecordReminder',
                    targetUserId: uid,
                  });
                }
                await createNotificationDoc(
                  env,
                  accessToken,
                  uid,
                  'Reminder: no record today',
                  "No transaction recorded today — add today's purchases/distributions",
                  'nightlyNoRecordReminder',
                );
              }
              await setDoc(env, accessToken, 'settings/app', { lastReminderDate: todayStr });
              console.log(`[cron] nightly nudge sent for ${todayStr} to ${admins.length} admins`);
            } else {
              console.log(`[cron] nightly nudge skipped — has transaction on ${todayStr}`);
            }
          } else {
            console.log(`[cron] nightly nudge deduped for ${todayStr}`);
          }
        }
      }

      if (isInWindow('09:00', nowMin)) {
        if (cfg.lastDebtDigestDate !== todayStr) {
          const digest = await sendDailyDebtDigest(env, accessToken);
          for (const uid of digest.targets || []) {
            const tok = await getFcmToken(env, accessToken, uid);
            if (tok) {
              await sendPush(env, accessToken, tok, {
                title: 'Debt reminder',
                body: digest.summary
                  ? `Reminder: ${digest.summary}`
                  : 'Reminder: open debts need attention',
                type: 'debtRecorded',
                targetUserId: uid,
              });
            }
          }
          await setDoc(env, accessToken, 'settings/app', { lastDebtDigestDate: todayStr });
          console.log(`[cron] debt digest sent for ${todayStr}: ${digest.sent} docs`);
        } else {
          console.log(`[cron] debt digest deduped for ${todayStr}`);
        }
      }

      // Viewer weekly check-in: Monday 09:00 Addis
      if (cfg.viewerCheckInEnabled === true && addisNow.getDay() === 1 && isInWindow('09:00', nowMin)) {
        if (cfg.lastViewerCheckInDate !== todayStr) {
          const viewers = await getUsersByRole(env, accessToken, 'viewer');
          for (const uid of viewers) {
            const tok = await getFcmToken(env, accessToken, uid);
            if (tok) {
                await sendPush(env, accessToken, tok, {
                    title: 'Cofiz',
                    body: "Check in: see this week's business",
                    type: 'viewerWeeklyCheckIn',
                    targetUserId: uid,
                  });
            }
            await createNotificationDoc(
              env,
              accessToken,
              uid,
              'Weekly check-in',
              "Check in: see this week's business",
              'viewerWeeklyCheckIn',
            );
          }
          await setDoc(env, accessToken, 'settings/app', { lastViewerCheckInDate: todayStr });
          console.log(`[cron] viewer weekly check-in sent for ${todayStr} to ${viewers.length} viewers`);
        } else {
          console.log(`[cron] viewer check-in deduped for ${todayStr}`);
        }
      }
    } catch (e) {
      console.error(`[cron] scheduled failed: ${e.message}`, e);
    }
  },
};
