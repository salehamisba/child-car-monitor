/* =========================================================
   Shared helpers for the Vercel backend.
   Files that start with "_" are not turned into API routes.

   The database is Upstash Redis. We talk to it over its REST
   API with plain fetch(), so no npm packages are needed.
   ========================================================= */
import { timingSafeEqual } from 'node:crypto';

export const KEYS = {
  history: 'ccm:history',   // list of readings, newest first
  cmd: 'ccm:cmd'            // last command sent from the dashboard
};
export const MAX_HISTORY = 300;  // about 15 minutes at one reading every 3 s

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-device-key, x-control-key',
  'Access-Control-Max-Age': '86400'
};

export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS }
  });
}

// Wraps every route: answers CORS pre-flight and turns errors into JSON
export async function handle(request, fn) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { ok: false, error: e.message });
    console.error(e);
    return json(500, { ok: false, error: 'Server error. Open Vercel > Logs to see the details.' });
  }
}

export async function readBody(request, maxBytes = 2048) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Request is too large');
  try { return JSON.parse(text || '{}'); } catch (e) { throw new HttpError(400, 'Body must be JSON'); }
}

// Compares a secret without leaking timing information
export function checkSecret(given, envName) {
  const expected = process.env[envName];
  if (!expected) throw new HttpError(503, `${envName} is not set. Add it in Vercel > Settings > Environment Variables, then redeploy.`);
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(401, envName === 'DEVICE_KEY' ? 'Wrong device key' : 'Wrong control PIN');
  }
}

/* ---------------- Upstash Redis over REST ---------------- */
// Vercel's Upstash integration adds KV_REST_API_URL / KV_REST_API_TOKEN.
// A database made on upstash.com uses UPSTASH_REDIS_REST_URL / _TOKEN.
// If a custom prefix was chosen, we look for any matching pair.
export function dbCreds() {
  const env = process.env;
  let url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  let token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    for (const name of Object.keys(env)) {
      if (!/(_REST_API_URL|_REDIS_REST_URL)$/.test(name)) continue;
      const t = env[name.replace(/URL$/, 'TOKEN')];
      if (t) { url = env[name]; token = t; break; }
    }
  }
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

// Runs several Redis commands in one HTTP call. Returns one result per command.
export async function redis(commands) {
  const c = dbCreds();
  if (!c) throw new HttpError(503, 'Database not connected. In Vercel open Storage, connect an Upstash Redis database to this project, then redeploy.');
  let res;
  try {
    res = await fetch(`${c.url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(5000)
    });
  } catch (e) {
    throw new HttpError(502, 'Database not reachable');
  }
  if (!res.ok) throw new HttpError(502, `Database error (HTTP ${res.status})`);
  const out = await res.json();
  return out.map((x) => {
    if (x && x.error) throw new HttpError(502, `Database error: ${x.error}`);
    return x ? x.result : null;
  });
}

export function parseJson(s) {
  if (typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

/* ---------------- Input checks ---------------- */
export const num = (v, lo, hi) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};
export const bit = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1
  : v === false || v === 0 || v === '0' || v === 'false' ? 0 : null);
