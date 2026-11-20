#!/usr/bin/env node
// Inkhouse proxy: serves the e-ink panel and talks to Home Assistant for it.
// The panel never sees the HA token; it can only read the entities in config.json
// and only perform the actions config.json allows. No dependencies (Node 22+).
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ROOT = __dirname;
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const HA_URL = env('HA_URL', 'http://homeassistant.local:8123').replace(/\/$/, '');
const HA_TOKEN = env('HA_TOKEN', '');
const PORT = +env('PORT', 8190);
const DRY_RUN = env('DRY_RUN', '0') === '1';
const CONFIG_PATH = env('CONFIG', path.join(ROOT, 'config.json'));
const PANEL_KEY = env('PANEL_KEY', '');
const ALLOWED_HOSTS = env('ALLOWED_HOSTS', '').split(',').map((s) => s.trim()).filter(Boolean);

if (!HA_TOKEN) { console.error('HA_TOKEN is missing. Set it in the environment (never in config.json).'); process.exit(1); }

if (!fs.existsSync(CONFIG_PATH)) { console.error(`No config at ${CONFIG_PATH}. Copy config.example.json to config.json and edit it.`); process.exit(1); }
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const control = config.control || {};
// WHY: the read set is everything the UI shows plus everything it may control, so state for a button is always present
const readSet = new Set([...(config.read || []), ...Object.keys(control)]);
// Optional: HA helpers the Kindle's launcher script obeys (settings and buttons set from HA), name -> entity
const kindleCmd = config.kindle || {};
for (const e of Object.values(kindleCmd)) readSet.add(e);

// Only these attributes are sent to the panel, per domain; the rest of HA's state stays on the server
const ATTRS = {
  climate: ['temperature', 'current_temperature', 'fan_mode', 'hvac_action', 'min_temp', 'max_temp', 'target_temp_step', 'hvac_modes', 'fan_modes'],
  select: ['options'],
  vacuum: ['battery_level'],
  sensor: ['unit_of_measurement'],
  weather: ['temperature', 'humidity'],
  number: ['min', 'max', 'step'],
};

// ---------- State cache ----------
const cache = {};          // entity_id -> { s, a, c }
let version = 0;
let haOnline = false;
let lastSync = 0;
let waiters = [];          // long-poll requests waiting for a change

function slim(st) {
  const domain = st.entity_id.split('.')[0];
  const a = {};
  for (const k of ATTRS[domain] || []) if (st.attributes && st.attributes[k] !== undefined) a[k] = st.attributes[k];
  return { s: st.state, a, c: Date.parse(st.last_changed) / 1000 | 0 };
}

function bump() {
  version++;
  lastSync = Date.now();
  const w = waiters; waiters = [];
  for (const fn of w) fn();
}

let haTimeZone = 'UTC';
// Minutes ahead of UTC for HA's time zone right now (handles DST where it exists)
function tzOffset() {
  const d = new Date();
  const local = new Date(d.toLocaleString('en-US', { timeZone: haTimeZone }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((local - utc) / 60000);
}

let kindle = null;   // { b: battery %, c: charging 0/1, at: epoch s } reported by the Kindle's launcher script

function snapshot() {
  return { v: version, ok: haOnline, at: lastSync / 1000 | 0, tz: tzOffset(), dry: DRY_RUN, kindle, e: cache };
}

// ---------- Home Assistant websocket ----------
let ws = null, msgId = 0, pending = new Map(), retry = 1000;

function haSend(payload) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1 || !haOnline) return reject(new Error('Home Assistant is not connected'));
    const id = ++msgId;
    const t = setTimeout(() => { pending.delete(id); reject(new Error('Home Assistant did not answer')); }, 10000);
    pending.set(id, { resolve, reject, t });
    ws.send(JSON.stringify({ id, ...payload }));
  });
}

function connect() {
  ws = new WebSocket(HA_URL.replace(/^http/, 'ws') + '/api/websocket');
  ws.addEventListener('message', async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN }));
    else if (m.type === 'auth_invalid') { console.error('HA rejected the token:', m.message); process.exit(1); }
    else if (m.type === 'auth_ok') {
      haOnline = true; retry = 1000;
      try {
        const haConfig = await haSend({ type: 'get_config' });
        if (haConfig && haConfig.time_zone) haTimeZone = haConfig.time_zone;
        const states = await haSend({ type: 'get_states' });
        for (const st of states) if (readSet.has(st.entity_id)) cache[st.entity_id] = slim(st);
        const missing = [...readSet].filter((id) => !cache[id]);
        if (missing.length) console.warn('Not found in HA (check config.json):', missing.join(', '));
        await haSend({ type: 'subscribe_events', event_type: 'state_changed' });
        console.log(`HA connected, ${Object.keys(cache).length} entities cached`);
        bump();
      } catch (e) { console.error('HA setup failed:', e.message); ws.close(); }
    } else if (m.type === 'result') {
      const p = pending.get(m.id); if (!p) return;
      pending.delete(m.id); clearTimeout(p.t);
      m.success ? p.resolve(m.result) : p.reject(new Error(m.error && m.error.message || 'HA error'));
    } else if (m.type === 'event' && m.event && m.event.event_type === 'state_changed') {
      const d = m.event.data;
      if (!readSet.has(d.entity_id)) return;
      // WHY: HA sends no new state when an entity is removed (the vacuum app's shortcut does this while the robot's cloud link is down), so mark it unavailable
      const next = d.new_state ? slim(d.new_state) : { s: 'unavailable', a: {}, c: Date.now() / 1000 | 0 };
      const prev = cache[d.entity_id];
      // WHY: HA fires state_changed for attribute noise too; only wake the panel when what it shows changed
      if (prev && prev.s === next.s && JSON.stringify(prev.a) === JSON.stringify(next.a)) return;
      cache[d.entity_id] = next;
      bump();
    }
  });
  ws.addEventListener('close', () => {
    if (haOnline) console.warn('HA connection lost, retrying');
    haOnline = false;
    for (const p of pending.values()) { clearTimeout(p.t); p.reject(new Error('Home Assistant disconnected')); }
    pending.clear();
    bump();
    setTimeout(connect, retry); retry = Math.min(retry * 2, 30000);
  });
  ws.addEventListener('error', () => {});
}

// ---------- Actions ----------
// Each verb maps to one HA service call. The panel sends { e, do, v }.
const VERBS = {
  power:       (e, v) => [e.split('.')[0], v ? 'turn_on' : 'turn_off', {}],
  temperature: (e, v) => ['climate', 'set_temperature', { temperature: clampTemp(e, v) }],
  hvac_mode:   (e, v) => ['climate', 'set_hvac_mode', { hvac_mode: String(v) }],
  fan_mode:    (e, v) => ['climate', 'set_fan_mode', { fan_mode: String(v) }],
  lock:        () => ['lock', 'lock', {}],
  unlock:      () => ['lock', 'unlock', {}],
  start:       () => ['vacuum', 'start', {}],
  dock:        () => ['vacuum', 'return_to_base', {}],
  select:      (e, v) => ['select', 'select_option', { option: checkOption(e, v) }],
  switch:      (e, v) => ['switch', v ? 'turn_on' : 'turn_off', {}],
  number:      (e, v) => ['number', 'set_value', { value: Number(v) }],
  press:       () => ['button', 'press', {}],
  run:         () => ['script', 'turn_on', {}],
};

// Verbs that make several calls in order. Every step is checked like a single action.
const SEQUENCES = {
  // Vacuum wizard: { select entity: option, ... } and then start, so the robot cleans with exactly those settings.
  // WHY: the robot reads its settings when it starts, so each select is set (1 s apart, like HA's own script) before vacuum.start
  start_with: (e, v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('bad settings');
    const calls = [];
    for (const sel of Object.keys(v)) {
      if (!(control[sel] || []).includes('select')) throw new Error('not allowed');
      const option = checkOption(sel, v[sel]);
      if (cache[sel].s !== option) calls.push([sel, 'select', 'select_option', { option }]);
    }
    calls.push([e, 'vacuum', 'start', {}]);
    return calls;
  },
};

function clampTemp(e, v) {
  const n = Number(v), a = (cache[e] && cache[e].a) || {};
  if (!Number.isFinite(n)) throw new Error('bad temperature');
  return Math.max(a.min_temp ?? 16, Math.min(a.max_temp ?? 30, n));
}

function checkOption(e, v) {
  const opts = (cache[e] && cache[e].a.options) || [];
  if (!opts.includes(v)) throw new Error('option not offered by HA');
  return v;
}

// The vacuum app's shortcut drops out of HA while the robot's cloud link is down. Its button then starts the
// usual clean (the vacuum settings' usual values, like Start usual), so a tap never silently does nothing.
function shortcutFallback(e, verb) {
  const vac = (config.ui || {}).vacuum || {};
  if (verb !== 'press' || !vac.shortcut || vac.shortcut.entity !== e || (cache[e] && cache[e].s !== 'unavailable')) return null;
  const usual = {};
  for (const st of vac.settings || []) if (st.usual !== undefined) usual[st.entity] = st.usual;
  console.log('Shortcut not in HA right now, starting the usual clean instead');
  return SEQUENCES.start_with(vac.entity, usual);
}

let recent = [];
async function runAction(body) {
  const { e, v } = body, verb = body.do;
  const allowed = control[e];
  if (!allowed || !allowed.includes(verb) || !(VERBS[verb] || SEQUENCES[verb])) return { code: 403, out: { ok: false, error: 'not allowed' } };
  const now = Date.now();
  recent = recent.filter((t) => now - t < 2000);
  if (recent.length >= 6) return { code: 429, out: { ok: false, error: 'too many taps' } };
  recent.push(now);
  let calls;   // [[entity, domain, service, data], ...]
  try { calls = shortcutFallback(e, verb) || (SEQUENCES[verb] ? SEQUENCES[verb](e, v) : [[e, ...VERBS[verb](e, v)]]); }
  catch (err) { return { code: err.message === 'not allowed' ? 403 : 400, out: { ok: false, error: err.message } }; }
  for (let i = 0; i < calls.length; i++) {
    const [target, domain, service, data] = calls[i];
    if (DRY_RUN) { console.log('[dry run]', domain + '.' + service, target, JSON.stringify(data)); continue; }
    if (i) await new Promise((r) => setTimeout(r, 1000));
    try { await haSend({ type: 'call_service', domain, service, service_data: data, target: { entity_id: target } }); }
    catch (err) { return { code: 502, out: { ok: false, error: err.message } }; }
  }
  return { code: 200, out: DRY_RUN ? { ok: true, dry: true } : { ok: true } };
}

// ---------- Camera stills ----------
// Some cameras (eufy over RTSP) often miss HA's 10 s snapshot window, so try twice and
// fall back to the last good still from the past hour rather than showing an error.
const stills = new Map();
async function fetchStill(e) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(`${HA_URL}/api/camera_proxy/${encodeURIComponent(e)}?width=480`, { headers: { Authorization: `Bearer ${HA_TOKEN}` }, signal: ctl.signal });
    if (!r.ok) return null;
    return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/jpeg', at: Date.now() };
  } catch (_) { return null; } finally { clearTimeout(t); }
}
async function getStill(e) {
  const still = (await fetchStill(e)) || (await fetchStill(e));
  if (still) { stills.set(e, still); return still; }
  const old = stills.get(e);
  return old && Date.now() - old.at < 3600000 ? old : null;
}

// ---------- HTTP ----------
function loadPage() {
  const file = path.join(ROOT, 'public', 'index.html');
  const raw = fs.readFileSync(file);
  return { gz: zlib.gzipSync(raw, { level: 9 }), raw, etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16) + '"' };
}
let page = loadPage();
fs.watch(path.join(ROOT, 'public'), () => { try { page = loadPage(); } catch (_) {} });

function send(req, res, code, body, type, extra) {
  const headers = Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }, extra || {});
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (buf.length > 512 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { buf = zlib.gzipSync(buf); headers['Content-Encoding'] = 'gzip'; }
  headers['Content-Length'] = buf.length;
  res.writeHead(code, headers); res.end(buf);
}
const json = (req, res, code, obj) => send(req, res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

function hostOk(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (ALLOWED_HOSTS.length) return ALLOWED_HOSTS.includes(host);
  // WHY: allowing only IP literals by default blocks DNS-rebinding pages from reaching the panel API
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host === 'localhost' || host.includes(':');
}

function keyOk(req, url) {
  if (!PANEL_KEY) return true;
  const cookie = /(?:^|;\s*)ik=([^;]+)/.exec(req.headers.cookie || '');
  return url.searchParams.get('k') === PANEL_KEY || (cookie && cookie[1] === PANEL_KEY);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!hostOk(req)) return send(req, res, 421, 'Unknown host', 'text/plain');
  if (url.pathname === '/health') return json(req, res, 200, { ok: true, ha: haOnline, v: version });
  if (!keyOk(req, url)) return send(req, res, 401, 'Missing or wrong panel key', 'text/plain');

  // WHY: the Kindle browser sends HEAD before GET to decide whether it can show the page
  if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/index.html')) {
    const extra = PANEL_KEY && url.searchParams.get('k') ? { 'Set-Cookie': `ik=${PANEL_KEY}; Path=/; Max-Age=31536000; SameSite=Strict; HttpOnly` } : {};
    if (req.headers['if-none-match'] === page.etag) { res.writeHead(304, Object.assign({ ETag: page.etag }, extra)); return res.end(); }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const body = gz ? page.gz : page.raw;
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: page.etag, 'Content-Length': body.length,
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" }, gz ? { 'Content-Encoding': 'gzip' } : {}, extra));
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  if (req.method === 'GET' && url.pathname === '/api/kindle') {
    // The Kindle reports its own battery here (plain GET from busybox wget); only two small numbers are accepted
    const b = parseInt(url.searchParams.get('b'), 10), c = url.searchParams.get('c') === '1' ? 1 : 0;
    if (!(b >= 0 && b <= 100)) return json(req, res, 400, { ok: false });
    kindle = { b, c, at: Date.now() / 1000 | 0 };
    bump();
    return json(req, res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/kindle/cmd') {
    // The Kindle script polls this for what HA wants: plain "name=value" lines that busybox can parse.
    // Settings are numbers; buttons are their last-pressed time, so a new value means "pressed".
    const lines = Object.entries(kindleCmd).map(([k, e]) => {
      let s = cache[e] ? cache[e].s : '';
      if (/^-?\d+\.0$/.test(s)) s = s.slice(0, -2);
      return k + '=' + s.replace(/[^\w:.+-]/g, '');
    });
    return send(req, res, 200, lines.join('\n') + '\n', 'text/plain; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/api/cam') {
    // Camera still, resized by HA itself (?width), only for cameras listed in config.ui.cameras
    const e = url.searchParams.get('e') || '';
    const cams = ((config.ui || {}).cameras || []).map((c) => c.entity);
    if (!cams.includes(e)) return send(req, res, 403, 'not allowed', 'text/plain');
    getStill(e).then((still) => {
      if (!still) return send(req, res, 502, 'camera did not answer', 'text/plain');
      res.writeHead(200, { 'Content-Type': still.type, 'Content-Length': still.buf.length, 'Cache-Control': 'private, max-age=600', 'X-Still-At': String(still.at / 1000 | 0) });
      res.end(still.buf);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') return json(req, res, 200, { title: config.title || 'Home', ui: config.ui || {} });

  if (req.method === 'GET' && url.pathname === '/api/state') {
    // Long poll: ?v=<last version seen> waits up to 25 s for a change, so taps elsewhere show up fast
    const seen = +url.searchParams.get('v');
    if (!url.searchParams.has('v') || seen !== version) return json(req, res, 200, snapshot());
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); json(req, res, 200, snapshot()); };
    const t = setTimeout(() => { waiters = waiters.filter((f) => f !== finish); finish(); }, 25000);
    waiters.push(finish);
    req.on('close', () => { done = true; clearTimeout(t); waiters = waiters.filter((f) => f !== finish); });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/action') {
    // WHY: a custom header can't be sent by a plain cross-site form, so this blocks CSRF from other pages on the LAN
    if (req.headers['x-inkhouse'] !== '1') return json(req, res, 403, { ok: false, error: 'missing header' });
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2048) req.destroy(); });
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(raw); } catch (_) { return json(req, res, 400, { ok: false, error: 'bad json' }); }
      const r = await runAction(body);
      json(req, res, r.code, r.out);
    });
    return;
  }

  send(req, res, 404, 'Not found', 'text/plain');
});

server.listen(PORT, () => console.log(`Inkhouse on :${PORT}${DRY_RUN ? ' (dry run: actions are logged, not sent)' : ''}`));
connect();
