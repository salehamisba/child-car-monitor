/* =========================================================
   /api/data

   POST  (from the ESP32, every few seconds)
     Header  x-device-key: <DEVICE_KEY>
     Body    {"temp":31.0,"hum":60,"child":1,"locked":1,"fan":0,"buzzer":0,
              "mode":"auto","alone":25,"level":1,"warn":32,"danger":38,"aloneLimit":60}
     Reply   the latest dashboard command, as flat JSON that is easy
             to read on the ESP32:
             {"ok":true,"id":"1732512345678","age":4,"mode":"manual",
              "fan":1,"buzzer":-1,"warn":32,"danger":38,"alone":60}
             -1 or "" means "no change".

   GET   (from the dashboard)
     /api/data             -> {"ok":true,"latest":{...},"serverTime":...}
     /api/data?history=1   -> also "history": [oldest ... newest]
   ========================================================= */
import { KEYS, MAX_HISTORY, HttpError, handle, json, readBody, checkSecret, redis, parseJson, num, bit } from './_shared.js';

function cleanReading(b) {
  const temp = num(b.temp, -40, 125);
  const hum = num(b.hum, 0, 100);
  if (temp === null || hum === null) throw new HttpError(400, 'temp and hum must be numbers');
  const r = {
    temp: Math.round(temp * 10) / 10,
    hum: Math.round(hum),
    child: bit(b.child) ?? 0,
    locked: bit(b.locked) ?? 0,
    fan: bit(b.fan) ?? 0,
    buzzer: bit(b.buzzer) ?? 0,
    mode: b.mode === 'manual' ? 'manual' : 'auto'
  };
  // optional extras
  const extra = {
    alone: num(b.alone, 0, 864000), level: num(b.level, 0, 2),
    warn: num(b.warn, 0, 100), danger: num(b.danger, 0, 100), aloneLimit: num(b.aloneLimit, 0, 86400),
    rssi: num(b.rssi, -120, 0), uptime: num(b.uptime, 0, 1e9)
  };
  for (const [k, v] of Object.entries(extra)) if (v !== null) r[k] = v;
  return r;
}

// Turns the stored command into flat values for the ESP32
function forDevice(cmd, now) {
  const c = cmd || {};
  const n = (v) => (typeof v === 'number' ? v : -1);
  return {
    id: c.id ? String(c.id) : '',
    age: c.id ? Math.max(0, Math.round((now - c.id) / 1000)) : -1,
    mode: c.mode === 'auto' || c.mode === 'manual' ? c.mode : '',
    fan: n(c.fan), buzzer: n(c.buzzer),
    warn: n(c.warn), danger: n(c.danger), alone: n(c.alone)
  };
}

export default {
  async fetch(request) {
    return handle(request, async () => {
      const now = Date.now();

      if (request.method === 'POST') {
        checkSecret(request.headers.get('x-device-key'), 'DEVICE_KEY');
        const r = cleanReading(await readBody(request));
        r.ts = now;
        const [, , cmdRaw] = await redis([
          ['LPUSH', KEYS.history, JSON.stringify(r)],
          ['LTRIM', KEYS.history, '0', String(MAX_HISTORY - 1)],
          ['GET', KEYS.cmd]
        ]);
        return json(200, { ok: true, ...forDevice(parseJson(cmdRaw), now) });
      }

      if (request.method === 'GET') {
        const url = new URL(request.url);
        if (url.searchParams.has('history')) {
          const [list] = await redis([['LRANGE', KEYS.history, '0', String(MAX_HISTORY - 1)]]);
          const history = (list || []).map(parseJson).filter(Boolean).reverse();
          return json(200, { ok: true, latest: history[history.length - 1] || null, history, serverTime: now });
        }
        const [one] = await redis([['LINDEX', KEYS.history, '0']]);
        return json(200, { ok: true, latest: parseJson(one), serverTime: now });
      }

      throw new HttpError(405, 'Use GET or POST');
    });
  }
};
