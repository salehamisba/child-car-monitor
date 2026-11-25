/* =========================================================
   /api/health – quick check after deploying.
   Open https://<your-project>.vercel.app/api/health
   It never shows the secret values, only whether they are set.
   ========================================================= */
import { KEYS, handle, json, redis, dbCreds, parseJson } from './_shared.js';

export default {
  async fetch(request) {
    return handle(request, async () => {
      const out = {
        ok: false,
        database: false,
        deviceKeySet: !!process.env.DEVICE_KEY,
        controlPinSet: !!process.env.CONTROL_KEY,
        lastReadingSecondsAgo: null
      };
      if (!dbCreds()) {
        out.help = 'Database not connected. Open Storage in Vercel, connect Upstash Redis to this project, then redeploy.';
        return json(200, out);
      }
      try {
        const [pong, last] = await redis([['PING'], ['LINDEX', KEYS.history, '0']]);
        out.database = pong === 'PONG';
        const r = parseJson(last);
        if (r && r.ts) out.lastReadingSecondsAgo = Math.round((Date.now() - r.ts) / 1000);
      } catch (e) {
        out.help = e.message;
      }
      out.ok = out.database && out.deviceKeySet;
      if (out.database && !out.deviceKeySet) out.help = 'Add DEVICE_KEY in Vercel > Settings > Environment Variables, then redeploy.';
      return json(200, out);
    });
  }
};
