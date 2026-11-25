/* =========================================================
   Child-in-Car Safety Monitor – dashboard logic
   Plain JavaScript. No external libraries.

   Data sources:
     1. Demo       – built-in simulator (no hardware needed)
     2. Cloud      – the ESP32 posts readings to our Vercel backend
                     (/api/data); commands go to /api/cmd.
                     Works from any phone or laptop, on any network.
     3. ESP32 Live – reads http://<ESP32-IP>/data every few seconds
                     and sends commands to http://<ESP32-IP>/cmd?...
                     (laptop and ESP32 on the same Wi-Fi)
     4. ThingSpeak – reads the last readings from a ThingSpeak channel
   ========================================================= */
(() => {
  'use strict';

  /* ---------------- Settings (saved in this browser) ---------------- */
  const DEFAULTS = {
    source: 'demo', ip: 'childcar.local', tsId: '', tsKey: '', cloudUrl: '', ctrlKey: '',
    warn: 32, danger: 38, alone: 60, poll: 2,
    sound: true, voice: true, notify: true, theme: 'light'
  };
  const KEY = 'child-car-monitor-v2';
  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveSettings() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* storage not available */ }
  }
  const saved = loadSettings();
  const S = Object.assign({}, DEFAULTS, saved);
  // First visit to the online (Vercel) website: open in Cloud mode, but only if the cloud is set up (checked at the end)
  const firstVisitOnVercel = !saved.source && /\.vercel\.app$/.test(location.hostname);
  if (S.ip === '192.168.1.50') S.ip = DEFAULTS.ip;   // old default from an earlier version

  /* ---------------- Small helpers ---------------- */
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad2 = (n) => String(n).padStart(2, '0');
  const clockStr = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? `${m} min ${pad2(s)} s` : `${s} s`;
  }
  function fmtAgo(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (s < 86400) return `${Math.round(s / 3600)} h`;
    return `${Math.round(s / 86400)} days`;
  }
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // '#ff7a30' + 0.35 -> 'rgba(255,122,48,0.35)' (canvas cannot read CSS colour tricks)
  const withAlpha = (hex, a) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return `rgba(255,122,48,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  };

  /* "Feels like" temperature – US National Weather Service heat index formula */
  function feelsLikeC(tC, rh) {
    const T = tC * 9 / 5 + 32;
    let hi = 0.5 * (T + 61 + (T - 68) * 1.2 + rh * 0.094);
    if ((hi + T) / 2 >= 80) {
      hi = -42.379 + 2.04901523 * T + 10.14333127 * rh - 0.22475541 * T * rh
         - 0.00683783 * T * T - 0.05481717 * rh * rh + 0.00122874 * T * T * rh
         + 0.00085282 * T * rh * rh - 0.00000199 * T * T * rh * rh;
      if (rh < 13 && T >= 80 && T <= 112) hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
      else if (rh > 85 && T >= 80 && T <= 87) hi += ((rh - 85) / 10) * ((87 - T) / 5);
    }
    return (hi - 32) * 5 / 9;
  }

  /* Heat colour: mint (cool) -> sunshine -> tangerine -> cherry (hot).
     Used for the glow behind the 3D car, the cabin tint and the big temperature number. */
  const HEAT_STOPS = [[22, [25, 195, 156]], [30, [18, 184, 147]], [33, [255, 176, 32]], [36.5, [255, 122, 48]], [40, [236, 47, 75]], [47, [168, 14, 44]]];
  function heatColour(t) {
    if (t <= HEAT_STOPS[0][0]) return HEAT_STOPS[0][1];
    for (let i = 1; i < HEAT_STOPS.length; i++) {
      const [t1, c1] = HEAT_STOPS[i];
      const [t0, c0] = HEAT_STOPS[i - 1];
      if (t <= t1) {
        const f = (t - t0) / (t1 - t0);
        return c0.map((v, k) => Math.round(v + (c1[k] - v) * f));
      }
    }
    return HEAT_STOPS[HEAT_STOPS.length - 1][1];
  }

  /* ---------------- Semicircle gauge (SVG, built in code) ---------------- */
  function makeGauge(host, opt) {
    const NS = 'http://www.w3.org/2000/svg';
    const cx = 100, cy = 100, r = 78;
    const LEN = Math.PI * r;
    const el = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    };
    const arc = (f0, f1, rad) => {
      const a0 = Math.PI * (1 - f0), a1 = Math.PI * (1 - f1);
      const x0 = cx + rad * Math.cos(a0), y0 = cy - rad * Math.sin(a0);
      const x1 = cx + rad * Math.cos(a1), y1 = cy - rad * Math.sin(a1);
      return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${rad} ${rad} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    };
    const svg = el('svg', { viewBox: '0 0 200 130' });
    const zoneGroup = el('g', {});
    const LEN2 = Math.PI * (r - 3);
    const trackDark = el('path', { d: arc(0, 1, r), class: 'g-track-dark', fill: 'none', 'stroke-width': 18, 'stroke-linecap': 'round' });
    const track = el('path', { d: arc(0, 1, r), class: 'g-track', fill: 'none', 'stroke-width': 13, 'stroke-linecap': 'round', transform: 'translate(0 -0.8)' });
    const value = el('path', { d: arc(0, 1, r), class: 'g-value', fill: 'none', 'stroke-width': 12, 'stroke-linecap': 'round',
      'stroke-dasharray': LEN.toFixed(2), 'stroke-dashoffset': LEN.toFixed(2) });
    const gloss = el('path', { d: arc(0, 1, r - 3), class: 'g-gloss', fill: 'none', 'stroke-width': 2.5, 'stroke-linecap': 'round',
      'stroke-dasharray': LEN2.toFixed(2), 'stroke-dashoffset': LEN2.toFixed(2) });
    const marker = el('circle', { r: 9, cx: cx - r, cy: cy, class: 'g-knob', 'stroke-width': 3.5 });
    marker.style.fill = 'url(#knobGrad)';
    value.style.stroke = 'transparent';
    marker.style.stroke = 'transparent';
    const num = el('text', { x: 100, y: 92, class: 'g-num' });
    num.textContent = '--';
    const word = el('text', { x: 100, y: 118, class: 'g-word' });
    const tMin = el('text', { x: cx - r, y: cy + 22, class: 'g-tick' });
    const tMax = el('text', { x: cx + r, y: cy + 22, class: 'g-tick' });
    tMin.textContent = opt.min; tMax.textContent = opt.max;
    svg.append(zoneGroup, trackDark, track, value, gloss, marker, num, word, tMin, tMax);
    host.appendChild(svg);

    let shown = opt.min, animId = null;
    const frac = (v) => clamp((v - opt.min) / (opt.max - opt.min), 0, 1);

    function draw(v) {
      const f = frac(v);
      value.setAttribute('stroke-dashoffset', (LEN * (1 - f)).toFixed(2));
      gloss.setAttribute('stroke-dashoffset', (LEN2 * (1 - f)).toFixed(2));
      const a = Math.PI * (1 - f);
      marker.setAttribute('cx', (cx + r * Math.cos(a)).toFixed(2));
      marker.setAttribute('cy', (cy - r * Math.sin(a)).toFixed(2));
    }

    return {
      clear() {
        cancelAnimationFrame(animId);
        shown = opt.min;
        draw(opt.min);
        num.textContent = '--';
        word.textContent = '';
        value.style.stroke = 'transparent';
        marker.style.stroke = 'transparent';
      },
      setZones(zones) {
        zoneGroup.textContent = '';
        zones.forEach(([from, to, colour]) => {
          const p = el('path', { d: arc(frac(from), frac(to), r + 15), fill: 'none', 'stroke-width': 3.5, 'stroke-linecap': 'butt' });
          p.style.stroke = colour;
          p.style.opacity = '0.75';
          zoneGroup.appendChild(p);
        });
      },
      set(v, colour, label) {
        if (!Number.isFinite(v)) return;
        value.style.stroke = colour;
        value.style.color = colour;          // used for the coloured glow under the arc
        marker.style.stroke = colour;
        word.style.fill = colour;
        word.textContent = label;
        num.innerHTML = `${v.toFixed(opt.decimals)}<tspan class="g-unit" dx="3" dy="-12">${opt.unit}</tspan>`;
        const from = shown, to = v, t0 = performance.now(), dur = 700;
        cancelAnimationFrame(animId);
        const step = (now) => {
          const k = clamp((now - t0) / dur, 0, 1);
          const e = 1 - Math.pow(1 - k, 3);
          shown = from + (to - from) * e;
          draw(shown);
          if (k < 1) animId = requestAnimationFrame(step);
        };
        animId = requestAnimationFrame(step);
      }
    };
  }

  /* ---------------- Line chart (Canvas, built in code) ---------------- */
  function makeChart(canvas, tip) {
    const ctx = canvas.getContext('2d');
    let data = [], hoverX = null, lastOpts = null;
    const PAD = { l: 44, r: 44, t: 14, b: 28 };

    function size() {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    }

    function draw(points, opts) {
      if (points) data = points;
      if (opts) lastOpts = opts;
      const o = lastOpts;
      const { w, h } = size();
      ctx.clearRect(0, 0, w, h);
      const C = {
        grid: cssVar('--grid-line'), muted: cssVar('--muted'), text: cssVar('--text'),
        hum: cssVar('--hum'), danger: cssVar('--danger'), warn: cssVar('--warn'), card: cssVar('--card')
      };
      const temp = cssVar('--temp') || '#ff7a30';
      ctx.font = '600 11px Manrope, "Segoe UI", system-ui, sans-serif';

      const now = data.length ? data[data.length - 1].t : Date.now();
      const tStart = now - o.windowSec * 1000;
      const pts = data.filter((p) => p.t >= tStart);

      // temperature axis range
      let lo = 15, hi = 50;
      if (pts.length) {
        const temps = pts.map((p) => p.temp);
        lo = Math.min(lo, Math.floor((Math.min(...temps) - 2) / 5) * 5);
        hi = Math.max(hi, Math.ceil((Math.max(...temps, o.danger) + 3) / 5) * 5);
      }
      const X = (t) => PAD.l + ((t - tStart) / (o.windowSec * 1000)) * (w - PAD.l - PAD.r);
      const Yt = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * (h - PAD.t - PAD.b);
      const Yh = (v) => PAD.t + (1 - v / 100) * (h - PAD.t - PAD.b);

      // grid + axis labels
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.fillStyle = C.muted;
      const rows = 5;
      for (let i = 0; i <= rows; i++) {
        const y = PAD.t + (i / rows) * (h - PAD.t - PAD.b);
        ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(w - PAD.r, y); ctx.stroke();
        const tv = hi - (i / rows) * (hi - lo);
        const hv = 100 - (i / rows) * 100;
        ctx.textAlign = 'right'; ctx.fillText(`${Math.round(tv)}°`, PAD.l - 8, y + 4);
        ctx.textAlign = 'left'; ctx.fillText(`${Math.round(hv)}%`, w - PAD.r + 8, y + 4);
      }
      // time labels
      ctx.textAlign = 'center';
      const ticks = 4;
      for (let i = 0; i <= ticks; i++) {
        const t = tStart + (i / ticks) * o.windowSec * 1000;
        ctx.fillText(clockStr(new Date(t)), X(t), h - 8);
      }

      // limit lines
      const limitLine = (v, colour, dash) => {
        if (v < lo || v > hi) return;
        ctx.save(); ctx.setLineDash(dash); ctx.strokeStyle = colour; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(PAD.l, Yt(v)); ctx.lineTo(w - PAD.r, Yt(v)); ctx.stroke(); ctx.restore();
      };
      limitLine(o.warn, C.warn, [2, 5]);
      limitLine(o.danger, C.danger, [6, 5]);

      if (pts.length < 2) {
        ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.font = '600 13px Manrope, "Segoe UI", system-ui, sans-serif';
        ctx.fillText('Waiting for readings…', w / 2, h / 2);
        return;
      }

      // humidity line
      ctx.strokeStyle = C.hum; ctx.lineWidth = 2.4; ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Yh(p.hum)) : ctx.moveTo(X(p.t), Yh(p.hum))));
      ctx.stroke();

      // temperature area + line
      const grad = ctx.createLinearGradient(0, PAD.t, 0, h - PAD.b);
      grad.addColorStop(0, withAlpha(temp, 0.38));
      grad.addColorStop(1, withAlpha(temp, 0));
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Yt(p.temp)) : ctx.moveTo(X(p.t), Yt(p.temp))));
      ctx.lineTo(X(pts[pts.length - 1].t), h - PAD.b);
      ctx.lineTo(X(pts[0].t), h - PAD.b);
      ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
      ctx.strokeStyle = temp; ctx.lineWidth = 3;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Yt(p.temp)) : ctx.moveTo(X(p.t), Yt(p.temp))));
      ctx.stroke();

      // latest point
      const last = pts[pts.length - 1];
      ctx.fillStyle = temp;
      ctx.beginPath(); ctx.arc(X(last.t), Yt(last.temp), 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = withAlpha(temp, 0.35); ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(X(last.t), Yt(last.temp), 8, 0, Math.PI * 2); ctx.stroke();

      // hover
      if (hoverX !== null) {
        let best = pts[0];
        pts.forEach((p) => { if (Math.abs(X(p.t) - hoverX) < Math.abs(X(best.t) - hoverX)) best = p; });
        const bx = X(best.t);
        ctx.strokeStyle = C.muted; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(bx, PAD.t); ctx.lineTo(bx, h - PAD.b); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = temp; ctx.beginPath(); ctx.arc(bx, Yt(best.temp), 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = C.hum; ctx.beginPath(); ctx.arc(bx, Yh(best.hum), 4, 0, Math.PI * 2); ctx.fill();
        tip.hidden = false;
        tip.innerHTML = `<b>${clockStr(new Date(best.t))}</b> &nbsp; ${best.temp.toFixed(1)} °C &nbsp;·&nbsp; ${Math.round(best.hum)} %`;
        const tw = tip.offsetWidth;
        tip.style.left = `${clamp(bx - tw / 2, 0, w - tw)}px`;
        tip.style.top = `0px`;
      } else {
        tip.hidden = true;
      }
    }

    canvas.addEventListener('mousemove', (e) => {
      hoverX = e.clientX - canvas.getBoundingClientRect().left;
      if (lastOpts) draw();
    });
    canvas.addEventListener('mouseleave', () => { hoverX = null; if (lastOpts) draw(); });
    if ('ResizeObserver' in window) new ResizeObserver(() => { if (lastOpts) draw(); }).observe(canvas);
    return { draw };
  }

  /* ---------------- DOM references ---------------- */
  const D = {
    html: document.documentElement,
    grid: document.querySelector('.grid'),
    statusCard: $('statusCard'), statusLabel: $('statusLabel'), statusTitle: $('statusTitle'), statusDetail: $('statusDetail'),
    timeInside: $('timeInside'), feelsLike: $('feelsLike'), maxTemp: $('maxTemp'), alertCount: $('alertCount'), lastUpdate: $('lastUpdate'),
    car: $('carSvg'), cabin: $('cabin'), cabinHeat: $('cabinHeat'), lockUse: $('lockUse'),
    carTemp: $('carCaptionTemp'), scene: $('scene'), car3dCanvas: $('car3d'),
    hudLock: $('hudLock'), hudChild: $('hudChild'), hudFan: $('hudFan'), hudBuzzer: $('hudBuzzer'), hudNote: $('hudNote'), sceneHint: $('sceneHint'),
    tileLock: $('tileLock'), tileChild: $('tileChild'), tileFan: $('tileFan'), tileBuzzer: $('tileBuzzer'),
    warnLbl: $('warnLbl'), dangerLbl: $('dangerLbl'), refreshLbl: $('refreshLbl'),
    connPill: $('connPill'), connText: $('connText'), clock: $('clock'),
    banner: $('alertBanner'), bannerText: $('alertText'), ackBtn: $('ackBtn'),
    modeSwitch: $('modeSwitch'), modeHint: $('modeHint'), fanBtn: $('fanBtn'), buzzerBtn: $('buzzerBtn'),
    optSound: $('optSound'), optVoice: $('optVoice'), optNotify: $('optNotify'),
    logList: $('logList'), simCard: $('simCard'),
    simLock: $('simLock'), simChild: $('simChild'), simHeat: $('simHeat'), simReset: $('simReset'),
    ambient: $('ambient'), ambientLbl: $('ambientLbl'), storyBtn: $('storyBtn'), storyCaption: $('storyCaption'),
    alertsBtn: $('alertsBtn'), themeBtn: $('themeBtn'), settingsBtn: $('settingsBtn'), dlg: $('settingsDlg'),
    windowSel: $('windowSel'), toasts: $('toasts')
  };

  const tempGauge = makeGauge($('tempGauge'), { min: 10, max: 60, unit: '°C', decimals: 1 });
  const humGauge = makeGauge($('humGauge'), { min: 0, max: 100, unit: '%', decimals: 0 });
  humGauge.setZones([[0, 30, 'var(--warn)'], [30, 70, 'var(--ok)'], [70, 100, 'var(--hum)']]);
  const chart = makeChart($('chart'), $('chartTip'));

  function setTempZones() {
    tempGauge.setZones([[10, S.warn, 'var(--ok)'], [S.warn, S.danger, 'var(--warn)'], [S.danger, 60, 'var(--danger)']]);
    D.warnLbl.textContent = S.warn;
    D.dangerLbl.textContent = S.danger;
  }

  /* ---------------- State ---------------- */
  let car3d = null;           // 3D car view (null if WebGL is not available)
  let source = S.source;
  let current = null;          // latest reading
  let history = [];            // [{t, temp, hum}]
  const MAX_POINTS = 900;
  const logs = [];
  const session = {
    childSince: null, level: 0, maxTemp: -Infinity, dangerCount: 0,
    acked: false, lastVoice: 0, lastBeep: 0, lastUpdate: null
  };

  /* ---------------- Alerts: toast, sound, voice, pop-up ---------------- */
  let audioCtx = null, alertsArmed = false;

  function toast(title, text, kind = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.innerHTML = `<b></b><span></span>`;
    t.querySelector('b').textContent = title;
    t.querySelector('span').textContent = text;
    D.toasts.prepend(t);
    while (D.toasts.children.length > 4) D.toasts.lastChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 5200);
  }

  function beep(freq = 880, times = 2) {
    if (!S.sound || !alertsArmed || !audioCtx) return;
    const t0 = audioCtx.currentTime;
    for (let i = 0; i < times; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'square'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.25);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + i * 0.25 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.25 + 0.16);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + i * 0.25); o.stop(t0 + i * 0.25 + 0.18);
    }
  }

  function speak(text) {
    if (!S.voice || !alertsArmed || !('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = speechSynthesis.getVoices().find((x) => x.lang === 'en-IN') ||
                speechSynthesis.getVoices().find((x) => x.lang && x.lang.startsWith('en'));
      if (v) u.voice = v;
      u.lang = v ? v.lang : 'en-IN';
      u.rate = 1;
      speechSynthesis.speak(u);
    } catch (e) { /* voice not available */ }
  }

  function popup(title, body) {
    if (!S.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification(title, { body, tag: 'child-car-monitor', renotify: true }); } catch (e) { /* not allowed here */ }
  }

  function armAlerts() {
    alertsArmed = !alertsArmed;
    if (alertsArmed) {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        audioCtx.resume();
      } catch (e) { audioCtx = null; }
      if ('Notification' in window && Notification.permission === 'default') {
        try { Notification.requestPermission(); } catch (e) { /* ignore */ }
      }
      beep(660, 1);
      toast('Alerts are ON', 'This screen will beep and speak when there is a warning.', 'ok');
    } else {
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      toast('Alerts are OFF', 'The dashboard will stay silent.', 'info');
    }
    D.alertsBtn.classList.toggle('on', alertsArmed);
    D.alertsBtn.querySelector('use').setAttribute('href', alertsArmed ? '#i-bell' : '#i-bell-off');
  }

  /* ---------------- Event log ---------------- */
  function log(level, text) {
    const entry = { time: new Date(), level, text };
    logs.unshift(entry);
    if (logs.length > 300) logs.pop();
    const empty = D.logList.querySelector('.log-empty');
    if (empty) empty.remove();
    const li = document.createElement('li');
    li.className = level;
    li.innerHTML = `<span class="dot"></span><span class="t">${clockStr(entry.time)}</span><span class="x"></span>`;
    li.querySelector('.x').textContent = text;
    D.logList.prepend(li);
    while (D.logList.children.length > 300) D.logList.lastChild.remove();
  }
  function showEmptyLog() {
    D.logList.innerHTML = '<li class="log-empty">No events yet.</li>';
  }

  function downloadCsv(name, rows) {
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const d = new Date();
    a.download = `${name}_${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ---------------- Safety logic ---------------- */
  // Level 0 = SAFE, 1 = WARNING (child in locked car), 2 = DANGER (too hot or alone too long)
  function evaluate(r, now) {
    const inside = r.child && r.locked;
    if (inside) { if (session.childSince === null) session.childSince = now; }
    else session.childSince = null;
    const secs = inside ? (r.alone != null ? r.alone : (now - session.childSince) / 1000) : 0;
    let level = 0;
    if (inside) level = (r.temp >= S.danger || secs >= S.alone) ? 2 : 1;
    return { level, secs, inside };
  }

  function onLevelChange(prev, next, r, ev) {
    if (next > prev) session.acked = false;
    if (next === 2) {
      session.dangerCount++;
      const why = r.temp >= S.danger ? `cabin is ${r.temp.toFixed(1)} °C` : `child alone for ${fmtDur(ev.secs)}`;
      log('danger', `DANGER – child inside locked car, ${why}`);
      toast('DANGER', `Child inside locked car – ${why}.`, 'danger');
      popup('DANGER: child inside locked car', `Cabin ${r.temp.toFixed(1)} °C. Go to the car now.`);
      speak(`Danger. Child inside locked car. Cabin temperature ${Math.round(r.temp)} degrees.`);
      session.lastVoice = Date.now();
    } else if (next === 1) {
      log('warn', prev === 2 ? 'Back to warning – cabin cooled down, child still inside' : 'WARNING – child detected inside locked car');
      toast('Warning', 'A child is inside the locked car. Please check now.', 'warn');
      popup('Warning: child inside locked car', 'Please check the car now.');
      if (prev < 1) speak('Attention. A child is inside the locked car.');
    } else {
      log('ok', 'All clear – no child inside a locked car');
      toast('All clear', 'The child is out of the car or the car is unlocked.', 'ok');
      if ('speechSynthesis' in window) speechSynthesis.cancel();
    }
  }

  function acknowledge() {
    if (session.level === 0) return;
    session.acked = true;
    D.banner.hidden = true;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    log('info', 'Alert acknowledged on the dashboard');
  }

  /* ---------------- Rendering ---------------- */
  const LEVEL_TEXT = ['SAFE', 'WARNING', 'DANGER'];

  function setHud(el, text, state) {
    el.className = 'hud-chip' + (state ? ` ${state}` : '');
    el.querySelector('b').textContent = text;
  }

  function setTile(tile, valText, icon, state) {
    tile.classList.remove('on', 'alert', 'warn');
    if (state) tile.classList.add(state);
    tile.querySelector('.tile-val').textContent = valText;
    if (icon) tile.querySelector('use').setAttribute('href', icon);
  }

  function render(r, ev) {
    const lvl = ev.level;

    // gauges
    const tColour = r.temp >= S.danger ? 'var(--danger)' : r.temp >= S.warn ? 'var(--warn)' : 'var(--ok)';
    const tWord = r.temp >= S.danger ? 'HOT' : r.temp >= S.warn ? 'WARM' : 'NORMAL';
    tempGauge.set(r.temp, tColour, tWord);
    const hWord = r.hum < 30 ? 'DRY' : r.hum < 70 ? 'NORMAL' : 'HUMID';
    humGauge.set(r.hum, r.hum >= 70 ? 'var(--hum)' : r.hum < 30 ? 'var(--warn)' : 'var(--ok)', hWord);

    // car drawing
    D.car.classList.toggle('child-on', r.child);
    D.car.classList.toggle('fan-on', r.fan);
    D.car.classList.toggle('locked', r.locked);
    D.car.classList.toggle('warn', lvl === 1);
    D.car.classList.toggle('danger', lvl === 2);
    const c = heatColour(r.temp);
    D.cabin.style.fill = `rgba(${c[0]},${c[1]},${c[2]},0.55)`;
    D.cabinHeat.setAttribute('opacity', clamp((r.temp - 32) / 14, 0, 0.85).toFixed(2));
    D.lockUse.setAttribute('href', r.locked ? '#i-lock' : '#i-unlock');
    D.carTemp.textContent = r.temp.toFixed(1);
    setHud(D.hudLock, r.locked ? 'Locked' : 'Unlocked', r.locked ? (ev.inside ? 'warn' : 'on') : '');
    setHud(D.hudChild, r.child ? 'Child detected' : 'Seat empty', r.child ? (lvl === 2 ? 'alert' : ev.inside ? 'warn' : 'on') : '');
    setHud(D.hudFan, r.fan ? 'Fan on' : 'Fan off', r.fan ? 'on' : '');
    setHud(D.hudBuzzer, r.buzzer ? 'Buzzer on' : 'Buzzer off', r.buzzer ? 'alert' : '');
    D.scene.classList.toggle('warn', lvl === 1);
    D.scene.classList.toggle('danger', lvl === 2);
    D.scene.style.setProperty('--heat', `rgb(${c[0]},${c[1]},${c[2]})`);
    if (car3d) car3d.update({ level: lvl, child: r.child, fan: r.fan, locked: r.locked, buzzer: r.buzzer, temp: r.temp, heat: c });

    // device tiles
    setTile(D.tileLock, r.locked ? 'Locked' : 'Unlocked', r.locked ? '#i-lock' : '#i-unlock', r.locked ? (ev.inside ? 'warn' : 'on') : null);
    setTile(D.tileChild, r.child ? 'Detected' : 'Empty', null, r.child ? (lvl === 2 ? 'alert' : ev.inside ? 'warn' : 'on') : null);
    setTile(D.tileFan, r.fan ? 'ON' : 'OFF', null, r.fan ? 'on' : null);
    setTile(D.tileBuzzer, r.buzzer ? 'ON' : 'OFF', null, r.buzzer ? 'alert' : null);

    // status card
    D.statusCard.className = `card status-card level-${lvl}`;
    D.statusLabel.textContent = LEVEL_TEXT[lvl];
    if (lvl === 0) {
      D.statusTitle.textContent = 'No child inside a locked car';
      D.statusDetail.textContent = r.temp >= S.warn
        ? `Cabin is warm (${r.temp.toFixed(1)} °C), but no child is detected in a locked car.`
        : 'All clear. The system is watching the cabin.';
    } else if (lvl === 1) {
      D.statusTitle.textContent = 'Child inside a locked car';
      const left = Math.max(0, S.alone - ev.secs);
      D.statusDetail.textContent = `Parent alerted. Danger at ${S.danger} °C or in ${fmtDur(left)} if nobody comes.`;
    } else {
      D.statusTitle.textContent = 'DANGER – child at risk';
      const why = r.temp >= S.danger ? `Cabin is ${r.temp.toFixed(1)} °C (limit ${S.danger} °C).` : `Child alone for ${fmtDur(ev.secs)}.`;
      const act = r.mode === 'auto' ? ' Fan and buzzer switched ON automatically.' : ' Manual mode – switch on the fan and buzzer.';
      D.statusDetail.textContent = why + act;
    }
    const fl = feelsLikeC(r.temp, r.hum);
    D.feelsLike.textContent = fl > 54 ? '54+ °C' : `${fl.toFixed(1)} °C`;
    D.maxTemp.textContent = Number.isFinite(session.maxTemp) ? `${session.maxTemp.toFixed(1)} °C` : '—';
    D.alertCount.textContent = session.dangerCount;
    D.timeInside.textContent = ev.inside ? fmtDur(ev.secs) : '—';

    // banner
    if (lvl > 0 && !session.acked) {
      D.banner.hidden = false;
      D.banner.className = `alert-banner ${lvl === 2 ? 'danger' : 'warn'}`;
      D.bannerText.textContent = lvl === 2
        ? `DANGER: child inside locked car – cabin ${r.temp.toFixed(1)} °C`
        : 'Warning: child inside locked car – please check the car now';
    } else {
      D.banner.hidden = true;
    }

    renderControls(r);
    chart.draw(history, { windowSec: +D.windowSel.value, warn: S.warn, danger: S.danger });
  }

  // Blank screen while waiting for the first reading from a new source
  function renderEmpty(message) {
    tempGauge.clear();
    humGauge.clear();
    D.car.classList.remove('child-on', 'fan-on', 'locked', 'warn', 'danger');
    D.cabin.style.fill = '';
    D.cabinHeat.setAttribute('opacity', '0');
    D.lockUse.setAttribute('href', '#i-unlock');
    D.carTemp.textContent = '--';
    [D.hudLock, D.hudChild, D.hudFan, D.hudBuzzer].forEach((el) => setHud(el, 'No data', ''));
    D.scene.classList.remove('warn', 'danger');
    D.scene.style.removeProperty('--heat');
    if (car3d) car3d.clear();
    setTile(D.tileLock, '—', '#i-unlock', null);
    setTile(D.tileChild, '—', null, null);
    setTile(D.tileFan, '—', null, null);
    setTile(D.tileBuzzer, '—', null, null);
    D.statusCard.className = 'card status-card level-wait';
    D.statusLabel.textContent = 'WAITING';
    D.statusTitle.textContent = 'Waiting for readings';
    D.statusDetail.textContent = message;
    D.timeInside.textContent = '—';
    D.feelsLike.textContent = '—';
    D.maxTemp.textContent = '—';
    D.alertCount.textContent = '0';
    D.lastUpdate.textContent = '—';
    D.banner.hidden = true;
  }

  function renderControls(r) {
    const mode = r ? r.mode : 'auto';
    D.modeSwitch.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    const canControl = source !== 'thingspeak';
    const manual = mode === 'manual' && canControl;
    D.modeSwitch.querySelectorAll('button').forEach((b) => (b.disabled = !canControl));
    D.fanBtn.disabled = !manual;
    D.buzzerBtn.disabled = !manual;
    D.fanBtn.classList.toggle('on', !!(r && r.fan));
    D.buzzerBtn.classList.toggle('on', !!(r && r.buzzer));
    D.buzzerBtn.classList.toggle('buzz', !!(r && r.buzzer));
    D.fanBtn.querySelector('span').textContent = r && r.fan ? 'Fan ON' : 'Fan OFF';
    D.buzzerBtn.querySelector('span').textContent = r && r.buzzer ? 'Buzzer ON' : 'Buzzer OFF';
    D.modeHint.textContent = !canControl
      ? 'ThingSpeak view is read-only. Use Cloud, ESP32 Live or Demo to control the fan and buzzer.'
      : mode === 'auto'
        ? 'Auto: the ESP32 switches the fan and buzzer by itself when there is danger.'
        : 'Manual: use the buttons below to switch the fan and buzzer.';
  }

  /* ---------------- Taking in a new reading ---------------- */
  function logChanges(prev, r) {
    if (!prev) return;
    if (prev.locked !== r.locked) log('info', r.locked ? 'Car locked' : 'Car unlocked');
    if (prev.child !== r.child) log('info', r.child ? 'Child detected on seat (IR sensor)' : 'Child seat is empty');
    if (prev.fan !== r.fan) log(r.fan ? 'warn' : 'info', r.fan ? 'Fan switched ON' : 'Fan switched OFF');
    if (prev.buzzer !== r.buzzer) log(r.buzzer ? 'danger' : 'info', r.buzzer ? 'Buzzer ON' : 'Buzzer OFF');
    if (prev.mode !== r.mode) log('info', `Control mode: ${r.mode === 'auto' ? 'Auto' : 'Manual'}`);
  }

  function ingest(r) {
    if (!Number.isFinite(r.temp) || !Number.isFinite(r.hum)) return;
    const now = r.ts || Date.now();
    const ev = evaluate(r, now);

    // Demo only: copy the ESP32's auto rule (fan + buzzer ON when DANGER)
    if (source === 'demo' && sim.mode === 'auto') {
      sim.fan = ev.level === 2;
      sim.buzzer = ev.level === 2;
      r.fan = sim.fan; r.buzzer = sim.buzzer;
    }

    logChanges(current, r);
    current = r;
    session.lastUpdate = Date.now();
    session.maxTemp = Math.max(session.maxTemp, r.temp);
    history.push({ t: now, temp: r.temp, hum: r.hum });
    if (history.length > MAX_POINTS) history.splice(0, history.length - MAX_POINTS);

    if (ev.level !== session.level) {
      const prev = session.level;
      session.level = ev.level;
      onLevelChange(prev, ev.level, r, ev);
    }
    render(r, ev);
  }

  /* ---------------- Source 1: Demo simulator ---------------- */
  const sim = { locked: false, child: false, heat: false, ambient: 28, temp: 27.5, hum: 54, fan: false, buzzer: false, mode: 'auto' };

  function simSnapshot() {
    return { temp: sim.temp, hum: sim.hum, child: sim.child, locked: sim.locked, fan: sim.fan, buzzer: sim.buzzer, mode: sim.mode, alone: null, ts: Date.now() };
  }
  function simStep() {
    let target = sim.locked ? sim.ambient + (sim.heat ? 19 : 7) : sim.ambient - 1;
    if (sim.fan) target -= 4;
    const k = sim.locked && sim.heat ? 0.07 : 0.025;
    sim.temp += (target - sim.temp) * k + (Math.random() - 0.5) * 0.12;
    const hTarget = 52 + (sim.child && sim.locked ? 16 : 0) - (sim.fan ? 8 : 0) - (sim.heat ? 4 : 0);
    sim.hum = clamp(sim.hum + (hTarget - sim.hum) * 0.04 + (Math.random() - 0.5) * 0.5, 15, 98);
    return simSnapshot();
  }
  function resetSim(ambient, keepStory) {
    if (!keepStory) stopStory();
    Object.assign(sim, { locked: false, child: false, heat: false, fan: false, buzzer: false });
    if (ambient) { sim.ambient = ambient; D.ambient.value = ambient; D.ambientLbl.textContent = ambient; }
    sim.temp = sim.ambient - 0.5;
    sim.hum = 54;
    updateSimButtons();
  }
  function updateSimButtons() {
    const set = (btn, on, onText, offText, onIcon, offIcon) => {
      btn.classList.toggle('active-state', on);
      btn.querySelector('span').textContent = on ? onText : offText;
      if (onIcon) btn.querySelector('use').setAttribute('href', on ? onIcon : offIcon);
    };
    set(D.simLock, sim.locked, 'Unlock car', 'Lock car', '#i-unlock', '#i-lock');
    set(D.simChild, sim.child, 'Remove child', 'Put child on seat');
    set(D.simHeat, sim.heat, 'Sun heat OFF', 'Sun heat ON');
  }

  // Scripted 40-second demo for the classroom
  let storyTimers = [];
  const STORY = [
    [0, 'Car is parked in the sun. Doors open, no child inside.', () => { resetSim(34, true); history = []; resetSession(); }],
    [3, 'A child climbs into the back seat…', () => { sim.child = true; }],
    [6, 'The car gets locked. Nobody notices the child.', () => { sim.locked = true; }],
    [9, 'The sun heats the closed car quickly…', () => { sim.heat = true; }],
    [30, 'The parent sees the alert and acknowledges it.', () => acknowledge()],
    [33, 'The parent unlocks the car.', () => { sim.locked = false; }],
    [36, 'The child is taken out safely.', () => { sim.child = false; }],
    [38, 'Heat source off.', () => { sim.heat = false; }],
    [40, 'Demo finished. Every step is in the event log.', () => { stopStory(true); }]
  ];
  function playStory() {
    if (storyTimers.length) { stopStory(); return; }
    log('info', 'Demo story started');
    STORY.forEach(([sec, caption, fn]) => {
      storyTimers.push(setTimeout(() => {
        fn();
        D.storyCaption.textContent = caption;
        if (sec > 0 && sec < 40) log('info', `Demo: ${caption}`);
        updateSimButtons();
        if (current) ingest(simSnapshot());
      }, sec * 1000));
    });
    D.storyBtn.querySelector('span').textContent = 'Stop demo story';
  }
  function stopStory(finished) {
    storyTimers.forEach(clearTimeout);
    storyTimers = [];
    D.storyBtn.querySelector('span').textContent = 'Play demo story (40 s)';
    if (!finished) D.storyCaption.textContent = '';
  }

  /* ---------------- Source 2: ESP32 Live ---------------- */
  let failCount = 0, httpsWarned = false;

  function normalise(j) {
    const b = (v) => v === true || v === 1 || v === '1' || v === 'true';
    return {
      temp: parseFloat(j.temp), hum: parseFloat(j.hum),
      child: b(j.child), locked: b(j.locked), fan: b(j.fan), buzzer: b(j.buzzer),
      mode: j.mode === 'manual' ? 'manual' : 'auto',
      alone: j.alone != null && j.alone !== '' ? parseFloat(j.alone) : null,
      ts: Date.now()
    };
  }

  async function fetchJson(url, ms = 3000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function pollLive() {
    if (location.protocol === 'https:') {
      setConn('bad', 'Open locally for Live');
      if (!httpsWarned) {
        httpsWarned = true;
        toast('Use the Cloud tab here', 'On the online website, readings come through the Cloud tab. ESP32 Live works only when index.html is opened on a laptop on the same Wi-Fi as the ESP32.', 'warn');
        log('warn', 'ESP32 Live blocked: this page is opened from the internet. Use Cloud mode.');
      }
      return;
    }
    try {
      const j = await fetchJson(`http://${S.ip}/data`);
      ingest(normalise(j));
      if (failCount >= 3) log('ok', `ESP32 connected again (${S.ip})`);
      failCount = 0;
      setConn('ok', `ESP32 online · ${S.ip}`);
    } catch (e) {
      failCount++;
      if (failCount === 3) {
        log('warn', `ESP32 not reachable at ${S.ip}`);
        toast('ESP32 not found', `Check that the ESP32 is on and on the same Wi-Fi. If it is, open Settings and type the IP address shown on the Serial Monitor (instead of ${S.ip}).`, 'warn');
      }
      setConn(failCount >= 3 ? 'bad' : 'wait', failCount >= 3 ? 'ESP32 offline' : 'Connecting…');
    }
  }

  /* ---------------- Source 3: ThingSpeak ---------------- */
  let lastFeedTime = 0;
  // Field map: 1 temp, 2 humidity, 3 child, 4 locked, 5 fan, 6 buzzer
  async function pollThingSpeak(first) {
    if (!S.tsId) {
      setConn('bad', 'Set ThingSpeak channel');
      if (first) { toast('ThingSpeak', 'Enter your channel ID in Settings.', 'warn'); openSettings(); }
      return;
    }
    const url = `https://api.thingspeak.com/channels/${encodeURIComponent(S.tsId)}/feeds.json?results=${first ? 60 : 3}` +
      (S.tsKey ? `&api_key=${encodeURIComponent(S.tsKey)}` : '');
    try {
      const j = await fetchJson(url, 6000);
      (j.feeds || []).forEach((f) => {
        const ts = Date.parse(f.created_at);
        if (!(ts > lastFeedTime)) return;
        lastFeedTime = ts;
        const b = (v) => parseFloat(v) === 1;
        ingest({
          temp: parseFloat(f.field1), hum: parseFloat(f.field2),
          child: b(f.field3), locked: b(f.field4), fan: b(f.field5), buzzer: b(f.field6),
          mode: 'auto', alone: null, ts
        });
      });
      setConn('ok', `ThingSpeak · ch ${S.tsId}`);
    } catch (e) {
      setConn('bad', 'ThingSpeak not reachable');
    }
  }

  /* ---------------- Source 4: Vercel cloud ---------------- */
  // The ESP32 posts a reading to /api/data every 3 s. We read it back from there.
  const CLOUD_STALE_MS = 15000;      // no reading for 15 s = ESP32 offline
  let cloudLastTs = 0, cloudOffset = 0, cloudOffline = false, cloudErrShown = '';

  // '' = same website (page opened from Vercel); null = page opened as a file with no link set
  function cloudBase() {
    if (S.cloudUrl) return S.cloudUrl;
    return /^https?:$/.test(location.protocol) ? '' : null;
  }
  function cloudReading(o) {
    const r = normalise(o);
    r.ts = o.ts + cloudOffset;       // server clock -> this device's clock
    return r;
  }
  async function cloudFetch(path, opts = {}, ms = 6000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(cloudBase() + path, Object.assign({ cache: 'no-store', signal: ctrl.signal }, opts));
      let j = null;
      try { j = await res.json(); } catch (e) { /* not JSON */ }
      if (!res.ok || !j || j.ok === false) {
        const err = new Error(j && j.error ? j.error
          : res.status === 404 ? 'No backend found at this link. Check the cloud link in Settings.' : `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return j;
    } finally {
      clearTimeout(t);
    }
  }
  const drawChart = () => chart.draw(history, { windowSec: +D.windowSel.value, warn: S.warn, danger: S.danger });

  async function pollCloud(first) {
    if (cloudBase() === null) {
      setConn('bad', 'Set cloud link');
      if (first) {
        renderEmpty('This page is opened as a file. Enter your Vercel link (https://….vercel.app) in Settings.');
        openSettings();
      }
      return;
    }
    try {
      const j = await cloudFetch(first ? '/api/data?history=1' : '/api/data');
      if (source !== 'cloud') return;             // user switched tabs while waiting
      cloudOffset = Date.now() - j.serverTime;
      if (failCount >= 2) log('ok', 'Cloud reachable again');
      failCount = 0; cloudErrShown = '';

      // Old readings only go to the chart. No alarms for the past.
      if (first && Array.isArray(j.history)) {
        j.history.slice(0, -1).forEach((o) => {
          const r = cloudReading(o);
          if (Number.isFinite(r.temp)) history.push({ t: r.ts, temp: r.temp, hum: r.hum });
          cloudLastTs = Math.max(cloudLastTs, o.ts);
        });
      }

      const o = j.latest;
      if (!o) {
        setConn('wait', 'Waiting for ESP32');
        if (first) renderEmpty('The cloud backend is working, but no readings yet. Switch on the ESP32 and check its Serial Monitor.');
        return;
      }
      const age = j.serverTime - o.ts;
      if (age > CLOUD_STALE_MS) {
        setConn('bad', `ESP32 offline · ${fmtAgo(age)}`);
        if (!cloudOffline) {
          cloudOffline = true;
          if (current) {
            log('warn', 'ESP32 stopped sending readings to the cloud');
            toast('ESP32 offline', 'No new readings for 15 seconds. Check the ESP32 power and Wi-Fi.', 'warn');
          } else {
            renderEmpty(`The ESP32 last sent a reading ${fmtAgo(age)} ago. Switch it on and check its Wi-Fi.`);
            drawChart();
          }
        }
        return;
      }
      if (cloudOffline && current) log('ok', 'ESP32 is sending readings again');
      cloudOffline = false;
      if (o.ts > cloudLastTs) {
        cloudLastTs = o.ts;
        ingest(cloudReading(o));
      }
      setConn('ok', 'Cloud · ESP32 online');
    } catch (e) {
      if (source !== 'cloud') return;
      failCount++;
      const msg = e.name === 'AbortError' || e instanceof TypeError ? 'Cloud not reachable. Check the internet connection.' : e.message;
      setConn(failCount >= 2 ? 'bad' : 'wait', failCount >= 2 ? 'Cloud error' : 'Connecting…');
      if (failCount >= 2 && cloudErrShown !== msg) {
        cloudErrShown = msg;
        log('warn', `Cloud: ${msg}`);
        if (current) toast('Cloud problem', msg, 'warn');
        else renderEmpty(msg);
      }
    }
  }

  /* ---------------- Commands (buttons -> device) ---------------- */
  function describeCmd(p) {
    return Object.entries(p).map(([k, v]) =>
      k === 'mode' ? `mode ${v}` : (k === 'fan' || k === 'buzzer') ? `${k} ${+v ? 'ON' : 'OFF'}` : `${k} ${v}`).join(', ');
  }

  async function sendCmd(params, quiet) {
    if (source === 'cloud') {
      if (cloudBase() === null) { if (!quiet) toast('Cloud link missing', 'Enter your Vercel link in Settings.', 'warn'); return; }
      const headers = { 'Content-Type': 'application/json' };
      if (S.ctrlKey) headers['x-control-key'] = S.ctrlKey;
      try {
        await cloudFetch('/api/cmd', { method: 'POST', headers, body: JSON.stringify(params) });
        log('info', `Command sent: ${describeCmd(params)}`);
        // check more often for a few seconds, so the change shows up quickly
        [1500, 3000, 4500, 6000, 7500].forEach((ms) => setTimeout(() => { if (source === 'cloud') pollCloud(false); }, ms));
        if (!quiet) {
          toast('Command sent', 'The ESP32 picks it up with its next reading (about 3 s).', 'ok');
          D.modeHint.textContent = 'Sent. Waiting for the ESP32 to confirm…';
        }
      } catch (e) {
        const pin = e.status === 401;
        toast(pin ? 'Wrong control PIN' : 'Command failed', pin ? 'Enter the correct control PIN in Settings.' : e.message, 'danger');
        log('warn', `Command not delivered (${describeCmd(params)}): ${e.message}`);
      }
      return;
    }
    if (source === 'demo') {
      if ('mode' in params) sim.mode = params.mode;
      if ('fan' in params) sim.fan = !!+params.fan;
      if ('buzzer' in params) sim.buzzer = !!+params.buzzer;
      ingest(simSnapshot());
      return;
    }
    if (source === 'thingspeak') {
      if (!quiet) toast('Read-only', 'Controls work only in ESP32 Live or Demo mode.', 'warn');
      return;
    }
    try {
      const j = await fetchJson(`http://${S.ip}/cmd?${new URLSearchParams(params)}`);
      ingest(normalise(j));
    } catch (e) {
      if (!quiet) toast('Command failed', `Could not reach the ESP32 at ${S.ip}.`, 'danger');
      log('warn', `Command not delivered: ${new URLSearchParams(params)}`);
    }
  }

  /* ---------------- Source switching ---------------- */
  let timer = null;
  function setConn(kind, text) {
    D.connPill.className = `pill pill-${kind}`;
    D.connText.textContent = text;
  }
  function resetSession() {
    Object.assign(session, { childSince: null, level: 0, maxTemp: -Infinity, dangerCount: 0, acked: false, lastUpdate: null });
    D.banner.hidden = true;
  }
  function startSource(src) {
    clearInterval(timer);
    stopStory();
    source = src;
    S.source = src; saveSettings();
    history = []; current = null; failCount = 0; lastFeedTime = 0;
    cloudLastTs = 0; cloudOffline = false; cloudErrShown = '';
    resetSession();
    document.querySelectorAll('#sourceSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.source === src));
    const isDemo = src === 'demo';
    D.simCard.hidden = !isDemo;
    D.simCard.style.display = isDemo ? '' : 'none';
    D.grid.classList.toggle('no-sim', !isDemo);

    if (src === 'demo') {
      setConn('demo', 'Demo mode');
      D.refreshLbl.textContent = '1';
      log('info', 'Data source: Demo simulator');
      ingest(simStep());
      timer = setInterval(() => ingest(simStep()), 1000);
    } else if (src === 'cloud') {
      const every = Math.max(3, S.poll);       // the ESP32 sends every 3 s, so faster is wasted
      renderEmpty('Loading readings from the cloud…');
      setConn('wait', 'Connecting…');
      D.refreshLbl.textContent = every;
      log('info', `Data source: Cloud (${S.cloudUrl || location.host || 'link not set'})`);
      pollCloud(true);
      timer = setInterval(() => pollCloud(false), every * 1000);
    } else if (src === 'live') {
      renderEmpty(`Looking for the ESP32 at ${S.ip}. Laptop and ESP32 must be on the same Wi-Fi (phone hotspot). If it does not connect in 10 seconds, type the IP address from the Serial Monitor in Settings.`);
      setConn('wait', 'Connecting…');
      D.refreshLbl.textContent = S.poll;
      log('info', `Data source: ESP32 Live (${S.ip})`);
      pollLive();
      timer = setInterval(pollLive, S.poll * 1000);
    } else {
      renderEmpty(S.tsId ? `Loading the latest readings from ThingSpeak channel ${S.tsId}…` : 'Enter your ThingSpeak channel ID in Settings.');
      setConn('wait', 'Loading…');
      D.refreshLbl.textContent = '15';
      log('info', `Data source: ThingSpeak (channel ${S.tsId || 'not set'})`);
      pollThingSpeak(true);
      timer = setInterval(() => pollThingSpeak(false), 15000);
    }
    renderControls(current);
    chart.draw(history, { windowSec: +D.windowSel.value, warn: S.warn, danger: S.danger });
  }

  /* ---------------- Settings dialog ---------------- */
  function openSettings() {
    $('setIp').value = S.ip; $('setTsId').value = S.tsId; $('setTsKey').value = S.tsKey;
    $('setCloudUrl').value = S.cloudUrl; $('setCtrlKey').value = S.ctrlKey;
    $('setWarn').value = S.warn; $('setDanger').value = S.danger; $('setAlone').value = S.alone; $('setPoll').value = S.poll;
    if (typeof D.dlg.showModal === 'function') D.dlg.showModal();
  }
  D.dlg.addEventListener('close', () => {
    if (D.dlg.returnValue !== 'save') return;
    const num = (id, def) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : def; };
    S.ip = $('setIp').value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') || DEFAULTS.ip;
    S.tsId = $('setTsId').value.trim();
    S.tsKey = $('setTsKey').value.trim();
    let cu = $('setCloudUrl').value.trim().replace(/\/+$/, '').replace(/\/api(\/.*)?$/, '');
    if (cu && !/^https?:\/\//.test(cu)) cu = `https://${cu}`;
    S.cloudUrl = cu;
    S.ctrlKey = $('setCtrlKey').value.trim();
    S.warn = num('setWarn', DEFAULTS.warn);
    S.danger = Math.max(num('setDanger', DEFAULTS.danger), S.warn + 0.5);
    S.alone = Math.max(5, num('setAlone', DEFAULTS.alone));
    S.poll = clamp(num('setPoll', DEFAULTS.poll), 1, 30);
    saveSettings();
    setTempZones();
    toast('Settings saved', `Warning ${S.warn} °C · Danger ${S.danger} °C · Alone limit ${S.alone} s`, 'ok');
    log('info', `Settings saved (warning ${S.warn} °C, danger ${S.danger} °C, alone ${S.alone} s)`);
    if (source === 'live' || source === 'cloud') sendCmd({ warn: S.warn, danger: S.danger, alone: S.alone }, true);
    startSource(source);
  });

  /* ---------------- Theme ---------------- */
  function applyTheme() {
    D.html.setAttribute('data-theme', S.theme);
    D.themeBtn.querySelector('use').setAttribute('href', S.theme === 'dark' ? '#i-sun' : '#i-moon');
    if (car3d) {
      car3d.setTheme(S.theme);
      car3d.setColours({ ok: cssVar('--ok'), warn: cssVar('--warn'), danger: cssVar('--danger') });
    }
    chart.draw(history, { windowSec: +D.windowSel.value, warn: S.warn, danger: S.danger });
  }

  /* ---------------- Button wiring ---------------- */
  document.querySelectorAll('#sourceSwitch button').forEach((b) =>
    b.addEventListener('click', () => { if (b.dataset.source !== source) startSource(b.dataset.source); }));
  D.modeSwitch.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => sendCmd({ mode: b.dataset.mode })));
  D.fanBtn.addEventListener('click', () => sendCmd({ fan: current && current.fan ? 0 : 1 }));
  D.buzzerBtn.addEventListener('click', () => sendCmd({ buzzer: current && current.buzzer ? 0 : 1 }));
  D.ackBtn.addEventListener('click', acknowledge);
  D.alertsBtn.addEventListener('click', armAlerts);
  D.themeBtn.addEventListener('click', () => { S.theme = S.theme === 'dark' ? 'light' : 'dark'; saveSettings(); applyTheme(); });
  D.settingsBtn.addEventListener('click', openSettings);
  D.windowSel.addEventListener('change', () => chart.draw(history, { windowSec: +D.windowSel.value, warn: S.warn, danger: S.danger }));

  [['optSound', 'sound'], ['optVoice', 'voice'], ['optNotify', 'notify']].forEach(([id, key]) => {
    const box = $(id);
    box.checked = !!S[key];
    box.addEventListener('change', () => {
      S[key] = box.checked; saveSettings();
      if (key === 'notify' && box.checked && 'Notification' in window && Notification.permission === 'default') {
        try { Notification.requestPermission(); } catch (e) { /* ignore */ }
      }
    });
  });

  $('exportBtn').addEventListener('click', () => {
    if (!logs.length) { toast('Nothing to export', 'The event log is empty.', 'info'); return; }
    downloadCsv('event_log', [['Time', 'Level', 'Event']].concat(
      logs.slice().reverse().map((l) => [l.time.toLocaleString('en-IN'), l.level.toUpperCase(), l.text])));
  });
  $('exportReadings').addEventListener('click', () => {
    if (!history.length) { toast('Nothing to export', 'No readings yet.', 'info'); return; }
    downloadCsv('readings', [['Time', 'Temperature (C)', 'Humidity (%)']].concat(
      history.map((p) => [new Date(p.t).toLocaleString('en-IN'), p.temp.toFixed(1), Math.round(p.hum)])));
  });
  $('clearBtn').addEventListener('click', () => { logs.length = 0; showEmptyLog(); });

  // simulator buttons
  D.simLock.addEventListener('click', () => { sim.locked = !sim.locked; updateSimButtons(); ingest(simSnapshot()); });
  D.simChild.addEventListener('click', () => { sim.child = !sim.child; updateSimButtons(); ingest(simSnapshot()); });
  D.simHeat.addEventListener('click', () => { sim.heat = !sim.heat; updateSimButtons(); log('info', sim.heat ? 'Demo: heat source ON' : 'Demo: heat source OFF'); });
  D.simReset.addEventListener('click', () => { resetSim(); history = []; resetSession(); D.storyCaption.textContent = ''; log('info', 'Demo reset'); ingest(simSnapshot()); });
  D.ambient.addEventListener('input', () => { sim.ambient = +D.ambient.value; D.ambientLbl.textContent = D.ambient.value; });
  D.storyBtn.addEventListener('click', playStory);

  /* ---------------- 1-second clock (timers, repeat alarms) ---------------- */
  setInterval(() => {
    const now = new Date();
    D.clock.textContent = clockStr(now);
    if (session.lastUpdate) {
      const ago = Math.round((Date.now() - session.lastUpdate) / 1000);
      D.lastUpdate.textContent = ago <= 1 ? 'just now' : `${ago} s ago`;
    }
    if (session.childSince !== null && current && current.alone == null) {
      D.timeInside.textContent = fmtDur((Date.now() - session.childSince) / 1000);
    }
    // keep alarming in DANGER until someone acknowledges
    if (session.level === 2 && !session.acked) {
      beep(988, 2);
      if (Date.now() - session.lastVoice > 25000 && current) {
        speak(`Danger. Child still inside the locked car. Cabin ${Math.round(current.temp)} degrees.`);
        session.lastVoice = Date.now();
      }
    } else if (session.level === 1 && !session.acked && now.getSeconds() % 10 === 0) {
      beep(740, 1);
    }
  }, 1000);

  /* ---------------- 3D car + tilt effect ---------------- */
  function initCar3D() {
    try {
      car3d = window.Car3D.create(D.car3dCanvas);
    } catch (e) {
      car3d = null;                       // no WebGL: show the flat drawing instead
      D.car3dCanvas.style.display = 'none';
      D.car.removeAttribute('hidden');
      D.hudNote.textContent = '2D view (3D not supported on this browser)';
      D.sceneHint.textContent = '';
    }
  }

  function enableTilt() {
    const mq = (q) => window.matchMedia && window.matchMedia(q).matches;
    if (mq('(prefers-reduced-motion: reduce)') || mq('(hover: none)')) return;
    document.querySelectorAll('.tilt').forEach((el) => {
      el.addEventListener('pointermove', (e) => {
        const b = el.getBoundingClientRect();
        const x = (e.clientX - b.left) / b.width - 0.5;
        const y = (e.clientY - b.top) / b.height - 0.5;
        el.style.transform = `perspective(900px) rotateX(${(-y * 4).toFixed(2)}deg) rotateY(${(x * 5).toFixed(2)}deg) translateY(-3px)`;
      });
      el.addEventListener('pointerleave', () => { el.style.transform = ''; });
    });
  }

  /* ---------------- Start ---------------- */
  initCar3D();
  enableTilt();
  showEmptyLog();
  setTempZones();
  applyTheme();
  D.ambient.value = sim.ambient; D.ambientLbl.textContent = sim.ambient;
  updateSimButtons();
  log('info', 'Dashboard started');
  startSource(['demo', 'cloud', 'live', 'thingspeak'].includes(S.source) ? S.source : 'demo');
  if (firstVisitOnVercel) {
    fetch('/api/health', { cache: 'no-store' })
      .then((res) => res.json())
      .then((j) => { if (j && j.ok && source === 'demo') startSource('cloud'); })
      .catch(() => { /* cloud not set up: stay in Demo */ });
  }
})();
