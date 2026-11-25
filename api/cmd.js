/* =========================================================
   /api/cmd  – commands from the dashboard to the ESP32

   POST  Body  any of {"mode":"auto|manual","fan":0|1,"buzzer":0|1,
                       "warn":32,"danger":38,"alone":60}
         Header x-control-key: <CONTROL_KEY>   (only if CONTROL_KEY is set)
   GET   shows the command that is waiting for the ESP32

   The ESP32 picks the command up with its next reading
   (within about 3 seconds).
   ========================================================= */
import { KEYS, HttpError, handle, json, readBody, checkSecret, redis, parseJson, num, bit } from './_shared.js';

function cleanCommand(b) {
  const c = {};
  if (b.mode === 'auto' || b.mode === 'manual') c.mode = b.mode;
  const fan = bit(b.fan); if (fan !== null) c.fan = fan;
  const buzzer = bit(b.buzzer); if (buzzer !== null) c.buzzer = buzzer;
  const warn = num(b.warn, 20, 60); if (warn !== null) c.warn = warn;
  const danger = num(b.danger, 20, 70); if (danger !== null) c.danger = danger;
  const alone = num(b.alone, 5, 3600); if (alone !== null) c.alone = Math.round(alone);
  if (!Object.keys(c).length) throw new HttpError(400, 'Nothing to send. Use mode, fan, buzzer, warn, danger or alone.');
  return c;
}

export default {
  async fetch(request) {
    return handle(request, async () => {
      if (request.method === 'GET') {
        const [raw] = await redis([['GET', KEYS.cmd]]);
        return json(200, { ok: true, cmd: parseJson(raw) });
      }
      if (request.method !== 'POST') throw new HttpError(405, 'Use GET or POST');

      if (process.env.CONTROL_KEY) checkSecret(request.headers.get('x-control-key'), 'CONTROL_KEY');
      const add = cleanCommand(await readBody(request));

      const [raw] = await redis([['GET', KEYS.cmd]]);
      const cmd = Object.assign(parseJson(raw) || {}, add);
      // Going back to Auto: the ESP32 decides the fan and buzzer again
      if (add.mode === 'auto') { delete cmd.fan; delete cmd.buzzer; }
      if (typeof cmd.warn === 'number' && typeof cmd.danger === 'number' && cmd.danger <= cmd.warn) {
        throw new HttpError(400, 'Danger temperature must be higher than warning temperature');
      }
      cmd.id = Date.now();
      await redis([['SET', KEYS.cmd, JSON.stringify(cmd)]]);
      return json(200, { ok: true, cmd });
    });
  }
};
