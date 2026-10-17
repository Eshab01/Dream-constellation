'use strict';
/**
 * Constellation of Strangers' Dreams — zero-dependency backend
 * Node >=18, built-in http/fs only. Run: npm start  (PORT env, default 4173)
 * API:
 *   GET    /api/dreams            ?mood=&q=&limit=
 *   POST   /api/dreams            {title, body, mood, lucidity} -> 201 dream
 *   POST   /api/dreams/:id/resonate -> {id, resonances, brightness}
 *   GET    /api/stats             -> {total, resonances, moods, brightest}
 *   GET    /api/health
 *   GET    /api/moderation/queue        (admin token) -> pending dreams
 *   POST   /api/moderation/:id/approve  (admin token)
 *   POST   /api/moderation/:id/reject   (admin token)
 * Storage: data/dreams.json (atomic writes). Positions are clustered by mood
 * so each mood forms its own constellation in the galaxy.
 * Public-safety (all zero-dependency, see DEPLOY.md):
 *   - Per-IP rate limits on posting / resonating (429 + Retry-After).
 *   - Submissions containing links are rejected as spam.
 *   - MODERATION=hold  -> new dreams stay invisible until approved with
 *     ADMIN_TOKEN. Default (unset) keeps the original instant-star flow.
 *   - Rotating backups of the data file in <data dir>/backups, on startup
 *     and then every BACKUP_INTERVAL_MIN minutes (default 60, keep 24).
 * WebSocket (also zero-dependency, hand-rolled RFC 6455 — see DEPLOY.md):
 *   WS /ws -> {type:'hello'|'presence'|'dream:new'|'dream:resonate', ...}
 *   New (and newly approved) dreams and resonances are broadcast the
 *   moment they happen, so open skies watch stars being born live.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 4173;
const ROOT = path.join(__dirname, 'public');
// Local default stays data/dreams.json. On a hosted deploy, point DATA_DIR
// (or DATA_FILE) at a persistent volume mount so dreams survive redeploys —
// most hosts give you an ephemeral filesystem everywhere else.
const DATA_FILE = process.env.DATA_FILE
  || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'dreams.json');
const HOLD_FOR_REVIEW = String(process.env.MODERATION || '').toLowerCase() === 'hold';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const BACKUP_DIR = path.join(path.dirname(DATA_FILE), 'backups');
const BACKUP_KEEP = 24;
const BACKUP_INTERVAL_MS = Math.max(1, Number(process.env.BACKUP_INTERVAL_MIN) || 60) * 60_000;
// Per-IP sliding-window limits. Generous for real dreamers, useless for floods.
const RATE_LIMITS = {
  post: { max: 5, windowMs: 10 * 60_000 },
  resonate: { max: 60, windowMs: 10 * 60_000 }
};

const MOODS = {
  Peaceful:    { hue: 168, cx: -620, cy: -320 },
  Anxious:     { hue: 18,  cx: 540,  cy: -420 },
  Euphoric:    { hue: 46,  cx: 80,   cy: -680 },
  Melancholic: { hue: 222, cx: -560, cy: 380 },
  Surreal:     { hue: 282, cx: 620,  cy: 300 },
  Lucid:       { hue: 190, cx: 0,    cy: 0 },
  Nightmare:   { hue: 348, cx: -60,  cy: 640 },
  Nostalgic:   { hue: 28,  cx: -880, cy: -40 }
};
const ALIAS_A = ['Sleeping','Wandering','Moonlit','Velvet','Silent','Drifting','Amber','Hollow','Gentle','Restless'];
const ALIAS_B = ['Fox','Comet','Moth','Whale','Lantern','Voyager','Sparrow','Tide','Echo','Pilgrim'];
const alias = () => ALIAS_A[crypto.randomInt(ALIAS_A.length)] + ' ' + ALIAS_B[crypto.randomInt(ALIAS_B.length)];

const SEED = [
  ['The Ocean Was in My Kitchen','I opened my fridge and the sea poured out, gentle as milk. A small whale was asleep in the vegetable drawer, snoring bubbles. I made tea and sat with my feet in the tide until the kettle sang like a gull.','Peaceful',3],
  ['Teeth Like Piano Keys','Every tooth in my mouth was a piano key. When I tried to speak, I played a sad little song and everyone in the room started crying, then applauding. The dentist was a conductor with a toothbrush baton.','Anxious',2],
  ['I Flew But Only Backwards','I could fly, but only backwards, so I spent the whole dream watching where I had already been getting smaller and more beautiful. I waved at yesterday. Yesterday waved back with someone else\u2019s hand.','Surreal',4],
  ['Grandma\u2019s House, Before','The house smelled of rain and cardamom. Grandma was young and laughing at a radio that played only our family\u2019s voices, years from now. I tried to warn her about nothing in particular. She just fed me oranges.','Nostalgic',3],
  ['The Exam Is in a Language of Birds','The paper was blank except for one question written in sparrow. Everyone else was writing furiously. My pencil kept turning into bread. I ate my answer and hoped for partial credit.','Anxious',1],
  ['Dancing on the Ceiling of the World','Gravity took the night off. We danced on the ceiling while the chandelier grew roots into the floor above us, which was also the sky. Nobody fell. Falling was a rumour for other planets.','Euphoric',4],
  ['The Staircase That Counts You','Each step whispered a number. If it reached my age before I reached the top, I would have to start again as someone else. I ran. The stairs were kind, and counted very, very slowly.','Nightmare',2],
  ['I Knew I Was Dreaming and Asked for Rain','The moment I realised, the streetlamps bowed. I asked the dream for rain made of tiny bells, and it obliged, politely, for exactly one minute. I woke up still listening.','Lucid',5]
];

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(raw) && raw.length) return raw;
  } catch (_) { /* first run */ }
  const now = Date.now();
  const dreams = SEED.map(([title, body, mood, lucidity], i) => makeDream({ title, body, mood, lucidity }, now - (SEED.length - i) * 36e5));
  save(dreams);
  return dreams;
}
function save(dreams) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(dreams, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
// Rotating backup: one timestamped copy per call, oldest pruned past
// BACKUP_KEEP. Best-effort by design — a failed backup never breaks posting.
function makeBackup() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, `dreams-${stamp}.json`));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('dreams-') && f.endsWith('.json')).sort();
    while (files.length > BACKUP_KEEP) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (e) { console.warn('Backup skipped:', e.message); }
}
const isPublic = d => !d.status || d.status === 'approved';
function makeDream({ title, body, mood, lucidity }, ts) {
  const m = MOODS[mood] || MOODS.Lucid;
  const spread = 190;
  return {
    id: crypto.randomUUID(),
    title, body, mood,
    lucidity: Math.min(5, Math.max(1, Number(lucidity) || 3)),
    alias: alias(),
    x: Math.round(m.cx + (Math.random() * 2 - 1) * spread),
    y: Math.round(m.cy + (Math.random() * 2 - 1) * spread),
    hue: m.hue + Math.round((Math.random() * 2 - 1) * 14),
    size: 1.6 + Math.random() * 1.8,
    resonances: 0,
    brightness: 0.55 + Math.random() * 0.3,
    status: 'approved',
    createdAt: new Date(ts || Date.now()).toISOString()
  };
}

let dreams = load();
makeBackup();
setInterval(makeBackup, BACKUP_INTERVAL_MS).unref();

// --- rate limiting (in-memory sliding window, per IP) ---
const hits = new Map(); // `${bucket}:${ip}` -> [timestamps]
function rateLimited(req, bucket) {
  const { max, windowMs } = RATE_LIMITS[bucket];
  const ip = (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for'])
    ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
    : (req.socket.remoteAddress || 'unknown');
  const key = bucket + ':' + ip, now = Date.now();
  const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return Math.ceil((windowMs - (now - recent[0])) / 1000);
  }
  recent.push(now); hits.set(key, recent);
  return 0; // 0 = allowed; otherwise seconds until the oldest hit expires
}
// --- moderation auth (constant-time compare against ADMIN_TOKEN) ---
function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const given = req.headers['x-admin-token'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(String(given)), b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const hasLink = s => /(https?:\/\/|www\.)/i.test(s);

const send = (res, code, obj, type = 'application/json') => {
  const body = type === 'application/json' ? JSON.stringify(obj) : obj;
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(body);
};
const readBody = req => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', c => { data += c; if (data.length > 64_000) reject(new Error('too large')); });
  req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } });
});
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

/* ================= WebSocket layer (RFC 6455, zero-dependency) ================= */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wsClients = new Set();
function wsEncode(payload, opcode = 1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const len = data.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, data]);
}
function wsBroadcast(obj) {
  if (!wsClients.size) return;
  const frame = wsEncode(JSON.stringify(obj));
  for (const sock of wsClients) {
    if (sock.destroyed || !sock.writable) { wsClients.delete(sock); continue; }
    try { sock.write(frame); } catch (_) { wsClients.delete(sock); try { sock.destroy(); } catch (_) {} }
  }
}
const wsPresence = () => wsBroadcast({ type: 'presence', watchers: wsClients.size });
function wsHandleData(sock, state, chunk) {
  state.buf = Buffer.concat([state.buf, chunk]);
  for (;;) { // consume every complete frame in the buffer
    const buf = state.buf;
    if (buf.length < 2) return;
    const fin = (buf[0] & 0x80) !== 0, opcode = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) return; // incomplete — wait for more
    let payload = buf.subarray(off + maskLen, off + maskLen + len);
    if (masked) { const mask = buf.subarray(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; }
    state.buf = buf.subarray(off + maskLen + len);
    if (opcode === 8) { try { sock.write(wsEncode(Buffer.alloc(0), 8)); } catch (_) {} sock.end(); return; } // close
    if (opcode === 9) { try { sock.write(wsEncode(payload, 10)); } catch (_) {} continue; } // ping -> pong
    if (opcode === 10) { state.alive = true; continue; } // pong
    if (!fin) continue; // fragmented client messages are not used by this app; drop safely
    // Text/binary from clients is intentionally ignored — this is a watch-only sky.
  }
}
setInterval(() => { // heartbeat: ping everyone, drop sockets that stopped ponging
  for (const sock of wsClients) {
    const st = sock._wsState;
    if (st && st.alive === false) { wsClients.delete(sock); try { sock.destroy(); } catch (_) {} continue; }
    if (st) st.alive = false;
    try { sock.write(wsEncode(Buffer.alloc(0), 9)); } catch (_) { wsClients.delete(sock); }
  }
  if (wsClients.size) wsPresence();
}, 30_000).unref();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/api/health') return send(res, 200, { ok: true, dreams: dreams.filter(isPublic).length, moderation: HOLD_FOR_REVIEW ? 'hold' : 'open', watchers: wsClients.size });
    if (p === '/api/stats' && req.method === 'GET') {
      const pub = dreams.filter(isPublic);
      const moods = {};
      for (const d of pub) moods[d.mood] = (moods[d.mood] || 0) + 1;
      const brightest = [...pub].sort((a, b) => b.brightness - a.brightness)[0] || null;
      return send(res, 200, { total: pub.length, resonances: pub.reduce((s, d) => s + d.resonances, 0), moods, brightest: brightest && { id: brightest.id, title: brightest.title } });
    }
    if (p === '/api/moderation/queue' && req.method === 'GET') {
      if (!ADMIN_TOKEN) return send(res, 503, { error: 'Moderation is not configured (set ADMIN_TOKEN).' });
      if (!isAdmin(req)) return send(res, 401, { error: 'Admin token required.' });
      return send(res, 200, { pending: dreams.filter(d => d.status === 'pending') });
    }
    const mm = p.match(/^\/api\/moderation\/([\w-]+)\/(approve|reject)$/);
    if (mm && req.method === 'POST') {
      if (!ADMIN_TOKEN) return send(res, 503, { error: 'Moderation is not configured (set ADMIN_TOKEN).' });
      if (!isAdmin(req)) return send(res, 401, { error: 'Admin token required.' });
      const idx = dreams.findIndex(x => x.id === mm[1]);
      if (idx < 0) return send(res, 404, { error: 'Dream not found.' });
      if (mm[2] === 'approve') { dreams[idx].status = 'approved'; save(dreams); wsBroadcast({ type: 'dream:new', dream: dreams[idx] }); return send(res, 200, { id: dreams[idx].id, status: 'approved' }); }
      const [removed] = dreams.splice(idx, 1); save(dreams);
      return send(res, 200, { id: removed.id, status: 'rejected' });
    }
    if (p === '/api/dreams' && req.method === 'GET') {
      let out = dreams.filter(isPublic).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const mood = url.searchParams.get('mood'); if (mood) out = out.filter(d => d.mood === mood);
      const q = (url.searchParams.get('q') || '').toLowerCase(); if (q) out = out.filter(d => (d.title + ' ' + d.body).toLowerCase().includes(q));
      const limit = Number(url.searchParams.get('limit')); if (limit > 0) out = out.slice(0, limit);
      return send(res, 200, { dreams: out });
    }
    if (p === '/api/dreams' && req.method === 'POST') {
      const wait = rateLimited(req, 'post');
      if (wait) { res.setHeader('Retry-After', String(wait)); return send(res, 429, { error: `Slow down a little — try releasing another dream in about ${Math.ceil(wait / 60)} minute(s).`, retryAfterSec: wait }); }
      const b = await readBody(req);
      const title = clean(b.title, 90), body = clean(b.body, 2400), mood = clean(b.mood, 30);
      if (title.length < 2) return send(res, 400, { error: 'Give your dream a title (at least 2 characters).' });
      if (body.length < 10) return send(res, 400, { error: 'Tell the dream itself (at least 10 characters).' });
      if (!MOODS[mood]) return send(res, 400, { error: 'Pick a mood constellation.' });
      if (hasLink(title + ' ' + body)) return send(res, 400, { error: 'Dreams travel without links — please remove any web address and try again.' });
      const dream = makeDream({ title, body, mood, lucidity: b.lucidity });
      if (HOLD_FOR_REVIEW) dream.status = 'pending';
      dreams.push(dream); save(dreams);
      if (HOLD_FOR_REVIEW) return send(res, 202, { dream, pending: true, message: 'Your dream is held for a quick review before it becomes a star.' });
      wsBroadcast({ type: 'dream:new', dream }); // a star is born — every open sky sees it now
      return send(res, 201, { dream });
    }
    const m = p.match(/^\/api\/dreams\/([\w-]+)\/resonate$/);
    if (m && req.method === 'POST') {
      const wait = rateLimited(req, 'resonate');
      if (wait) { res.setHeader('Retry-After', String(wait)); return send(res, 429, { error: 'Too many resonances from here just now — give the sky a moment.', retryAfterSec: wait }); }
      const d = dreams.find(x => x.id === m[1] && isPublic(x));
      if (!d) return send(res, 404, { error: 'Dream not found.' });
      d.resonances += 1; d.brightness = Math.min(1.6, d.brightness + 0.06); save(dreams);
      wsBroadcast({ type: 'dream:resonate', id: d.id, resonances: d.resonances, brightness: d.brightness });
      return send(res, 200, { id: d.id, resonances: d.resonances, brightness: d.brightness });
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
    // static
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!file.startsWith(ROOT)) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, buf) => {
      if (err) return fs.readFile(path.join(ROOT, 'index.html'), (e2, b2) => e2 ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, b2, 'text/html'));
      send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
    });
  } catch (e) { send(res, 400, { error: e.message || 'Bad request.' }); }
});
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://localhost');
  const key = req.headers['sec-websocket-key'];
  if (u.pathname !== '/ws' || !key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const state = { buf: head && head.length ? head : Buffer.alloc(0), alive: true };
  socket._wsState = state;
  wsClients.add(socket);
  const cleanup = () => { if (wsClients.delete(socket)) wsPresence(); };
  socket.on('data', chunk => { try { wsHandleData(socket, state, chunk); } catch (_) { cleanup(); socket.destroy(); } });
  socket.on('close', cleanup);
  socket.on('error', cleanup);
  try { socket.write(wsEncode(JSON.stringify({ type: 'hello', watchers: wsClients.size, total: dreams.filter(isPublic).length }))); } catch (_) {}
  wsPresence();
});
server.listen(PORT, () => {
  console.log(`✦ Dream Constellation running at http://localhost:${PORT} · live sky at ws://localhost:${PORT}/ws`);
  if (HOLD_FOR_REVIEW && !ADMIN_TOKEN) console.warn('⚠ MODERATION=hold is on but ADMIN_TOKEN is not set — the review queue will be unreachable until you set one.');
});
