const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}
function safeEq(a: string, b: string) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

export type TgUser = { id: number; first_name?: string; last_name?: string };
/** Telegram Mini App initData validation, per https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
export async function validateInitData(initData: string, botToken: string, maxAgeSec = 86400, now = Date.now()): Promise<TgUser | null> {
  if (!initData || !botToken || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  const calc = hex(await hmac(secret, dcs));
  if (!safeEq(calc, hash.toLowerCase())) return null;
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > maxAgeSec || authDate - now / 1000 > 300) return null;
  try { const u = JSON.parse(params.get('user') ?? ''); return typeof u?.id === 'number' ? u : null; } catch { return null; }
}

const hits = new Map<string, { n: number; t: number }>();
/** Best-effort per-isolate rate limit (Workers isolates are not shared globally). */
export function rateLimited(key: string, limit = 120, windowMs = 60_000, now = Date.now()): boolean {
  const h = hits.get(key);
  if (!h || now - h.t > windowMs) { hits.set(key, { n: 1, t: now }); if (hits.size > 5000) hits.clear(); return false; }
  h.n++;
  return h.n > limit;
}
