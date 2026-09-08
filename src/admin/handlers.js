export const WIPE_COLLECTIONS = [
  'users', 'workers', 'transactions', 'debts',
  'expenses', 'income_records',
  'notifications', 'audit_logs', 'fcm_tokens',
  'pin_locks', 'preferences', 'workspaces',
  'settings', 'mail',
  'notifications_outbox', 'sessions',
];

const FIREBASE_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const FIRESTORE_HOST = 'firestore.googleapis.com';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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

async function getAccessToken(env) {
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

export async function handleAdminWipe(request, env, ctx) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401);
  const token = auth.slice('Bearer '.length).trim();
  if (!env.WIPE_BEARER || token !== env.WIPE_BEARER) {
    return json({ error: 'forbidden' }, 403);
  }
  if (env.WIPE_BURN === 'true' && env.__WIPE_USED === 'true') {
    return json({ error: 'already_used' }, 410);
  }
  const accessToken = await getAccessToken(env);
  const dbPath = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)`;
  let deleted = 0;
  for (const coll of WIPE_COLLECTIONS) {
    let pageToken;
    do {
      const listUrl = `https://${FIRESTORE_HOST}/v1/${dbPath}/documents/${coll}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const list = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!list.ok) return json({ error: 'list_failed', coll, status: list.status }, 502);
      const j = await list.json();
      const docs = j.documents || [];
      if (docs.length === 0) break;
      for (let i = 0; i < docs.length; i += 200) {
        const chunk = docs.slice(i, i + 200).map((d) => ({ delete: d.name }));
        const commit = await fetch(`https://${FIRESTORE_HOST}/v1/${dbPath}/documents:commit`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ writes: chunk }),
        });
        if (!commit.ok) return json({ error: 'delete_failed', coll, status: commit.status }, 502);
        deleted += chunk.length;
      }
      pageToken = j.nextPageToken;
    } while (pageToken);
  }
  if (env.WIPE_BURN === 'true' && ctx) {
    ctx.waitUntil(Promise.resolve().then(() => { env.__WIPE_USED = 'true'; }));
  }
  return json({ ok: true, deleted });
}

export async function handleAdminCheck(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401);
  const token = auth.slice('Bearer '.length).trim();
  if (!env.WIPE_BEARER || token !== env.WIPE_BEARER) {
    return json({ error: 'forbidden' }, 403);
  }
  const accessToken = await getAccessToken(env);
  const dbPath = `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)`;
  const result = {};
  for (const coll of WIPE_COLLECTIONS) {
    let count = 0;
    let pageToken;
    do {
      const listUrl = `https://${FIRESTORE_HOST}/v1/${dbPath}/documents/${coll}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const list = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!list.ok) { result[coll] = { error: list.status }; break; }
      const j = await list.json();
      count += (j.documents || []).length;
      pageToken = j.nextPageToken;
    } while (pageToken);
    result[coll] = { count };
  }
  return json(result);
}
