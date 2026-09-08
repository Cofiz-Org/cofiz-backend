export const E164_RE = /^\+[1-9]\d{7,14}$/;

const REGION_CODES = { ET: '251' };

export function normalizeE164(input, defaultRegion = 'ET') {
  if (input == null) return null;
  const trimmed = String(input).replace(/[\s\-()]/g, '');
  if (trimmed.length === 0) return null;
  if (E164_RE.test(trimmed)) return trimmed;
  if (trimmed.startsWith('00')) {
    const plused = '+' + trimmed.slice(2);
    return E164_RE.test(plused) ? plused : null;
  }
  if (trimmed.startsWith('0')) {
    const code = REGION_CODES[defaultRegion];
    if (!code) return null;
    const local = trimmed.slice(1);
    const plused = `+${code}${local}`;
    return E164_RE.test(plused) ? plused : null;
  }
  const digits = trimmed.replace(/^\+/, '');
  if (/^[1-9]\d{7,14}$/.test(digits)) return `+${digits}`;
  return null;
}

export async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, '0');
  return out;
}
