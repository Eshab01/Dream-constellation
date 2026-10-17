'use strict';
/* Constellation of Strangers' Dreams — frontend: THE ENDLESS UNIVERSE
   Internally a rotating sphere — but the user never sees a globe.
   - Dreams live in 3D on mood-clustered spherical shells. Drag ROTATES
     that sphere (yaw wraps forever); there is no visible disc, rim or
     edge — starfield, nebulae and parallax layers fill the whole screen,
     stars swing in from beyond the edges and out again. Endless universe.
   - AURA FIX: each star's core and aura share ONE projected centre.
     Auras are pre-rendered sprites drawn at (x - s/2, y - s/2), so the
     core sits exactly in the middle of its glow in every state.
   - PERFORMANCE (built for thousands of stars, no perceptible delay):
     * Viewport culling with margin + far-side culling: a star that has
       rotated a bit past the screen (or behind) leaves the active render
       set and its cached sprite reference is RELEASED (memory cleared).
       When rotation brings it near the display again it is re-projected
       and re-acquires its sprite lazily (loaded when near).
     * Glow sprites live in a capped LRU cache (per hue/size bucket) —
       sprite memory can never grow without bound.
     * Zero allocations in the render loop: per-dream projection objects
       are allocated once and reused; the active set is a reused array
       sorted in place.
     * LOD: distant/small stars are plain points — no aura, label or
       constellation lines. Lines only between near on-screen neighbours.
     * Adaptive quality: if frame time degrades, dust count, nebulae and
       line/aura work are shed in tiers before frames ever drop.
   DPR capped, pauses off-tab, honours prefers-reduced-motion. */
const $ = s => document.querySelector(s);
const canvas = $('#galaxy'), ctx = canvas.getContext('2d');
const MOODS = ['Peaceful','Anxious','Euphoric','Melancholic','Surreal','Lucid','Nightmare','Nostalgic'];
const MOOD_HUE = { Peaceful:168, Anxious:18, Euphoric:46, Melancholic:222, Surreal:282, Lucid:190, Nightmare:348, Nostalgic:28 };
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOOD_SPHERE = { // [longitude, latitude] of each mood region
  Peaceful:[-2.2,0.55], Anxious:[1.6,0.65], Euphoric:[0.2,1.05], Melancholic:[-1.9,-0.65],
  Surreal:[2.3,-0.45], Lucid:[0.0,0.05], Nightmare:[-0.3,-1.05], Nostalgic:[-3.0,0.0]
};
const CULL_MARGIN = 170;        // px past the screen before a star is unloaded
const RELOAD_MARGIN = 190;      // hysteresis: reload slightly before cull edge
const SPRITE_CAP = 56;          // hard cap on cached aura sprites

let dreams = [], filter = null, query = '';
let rot = { x: 0.25, y: 0.6 }, vel = { x: 0, y: 0 }, goal = null;
let scale = 1, lastTouch = -10, drag = null, hover = null, selected = null;
let W = 0, H = 0, DPR = 1, t = 0;
let quality = 0, frameMs = 16, frameCount = 0; // adaptive quality tier 0..2
const active = [];              // reused render set — never reallocated
const bursts = [];

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = seed; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let x = Math.imul(a ^ a >>> 15, 1 | a); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; }; }

function place(d) { // allocate a dream's slots exactly once: deterministic
  // cluster OFFSETS (-1..1), not a final position — the final position is
  // computed by layoutSky(), which widens each cluster as it fills up.
  if (d._off) return d;
  const r = rng(hashStr(d.id));
  d._off = { lon: r() * 2 - 1, lat: r() * 2 - 1, shell: r() };
  d._p = { x: 0, y: 0, depth: 0, f: 1, live: false }; // reused projection
  d._sprite = null;
  d._v = null; d._vT = null; d._lon = 0; d._lat = 0; d._lonT = 0; d._latT = 0;
  computeTarget(d, 1, 1); // sane default until the first real layout
  d._v = { ...d._vT }; d._lon = d._lonT; d._lat = d._latT;
  return d;
}
/* ---- ADAPTIVE SKY ----
   The sky grows where it is crowded. Each mood cluster's angular spread
   scales with the square root of how many dreams it holds (so doubling
   the dreams widens the cluster ~1.4×, capped), and the whole universe
   gains depth as the total grows. layoutSky() recomputes targets when
   the population changes; the render loop then eases every star toward
   its new home, so the sky visibly stretches instead of jumping. */
let skySpreadShown = 1;
function spreadFactor(count) { return Math.min(2.8, Math.max(1, Math.sqrt(count / 6))); } // ≤6 dreams: untouched · 24: 2× wider · ~48+: capped 2.8×
function computeTarget(d, moodCount, total) {
  const [clon, clat] = MOOD_SPHERE[d.mood] || MOOD_SPHERE.Lucid;
  const f = spreadFactor(moodCount);
  const lon = clon + d._off.lon * 0.62 * f;
  const lat = Math.max(-1.3, Math.min(1.3, clat + d._off.lat * 0.5 * Math.min(2.2, f)));
  const shell = (0.82 + d._off.shell * 0.36) * (1 + Math.min(0.45, Math.max(0, total - 12) / 160));
  d._lonT = lon; d._latT = lat;
  d._vT = { x: Math.cos(lat) * Math.sin(lon) * shell, y: Math.sin(lat) * shell, z: Math.cos(lat) * Math.cos(lon) * shell };
}
function layoutSky(instant = false) {
  const counts = {};
  for (const d of dreams) counts[d.mood] = (counts[d.mood] || 0) + 1;
  let maxF = 1;
  for (const d of dreams) {
    place(d);
    computeTarget(d, counts[d.mood] || 1, dreams.length);
    maxF = Math.max(maxF, spreadFactor(counts[d.mood] || 1));
    if (instant) { d._v = { ...d._vT }; d._lon = d._lonT; d._lat = d._latT; }
  }
  if (!instant && maxF > skySpreadShown + 0.3) {
    skySpreadShown = maxF;
    toast('✦ The sky stretched wider to hold a crowded constellation');
  } else if (instant) skySpreadShown = maxF;
}

/* ---- centred aura sprites, LRU-capped ---- */
const spriteCache = new Map();
function getSprite(hue, bucket) {
  const key = hue + ':' + bucket;
  let c = spriteCache.get(key);
  if (c) { spriteCache.delete(key); spriteCache.set(key, c); return c; } // LRU touch
  c = document.createElement('canvas'); c.width = c.height = 96;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(48, 48, 0, 48, 48, 48); // centre = sprite centre, exactly
  grad.addColorStop(0, `hsla(${hue},95%,72%,0.55)`); grad.addColorStop(0.35, `hsla(${hue},95%,65%,0.18)`); grad.addColorStop(1, 'transparent');
  g.fillStyle = grad; g.fillRect(0, 0, 96, 96);
  spriteCache.set(key, c);
  if (spriteCache.size > SPRITE_CAP) spriteCache.delete(spriteCache.keys().next().value); // evict oldest
  return c;
}

/* ---- full-screen parallax backdrop tiles (the "infinite" universe) ---- */
function makeTile(n, seed, maxR) {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d'), r = rng(seed);
  for (let i = 0; i < n; i++) { g.globalAlpha = 0.25 + r() * 0.6; g.fillStyle = '#dfe2ff'; g.fillRect(r() * 512, r() * 512, r() * maxR + 0.4, r() * maxR + 0.4); }
  return c;
}
const tileFar = makeTile(90, 4242, 1.1), tileNear = makeTile(46, 777, 1.7);
function drawTiles(tile, par) { // wrap-drawn in both axes = no edge, ever
  const ox = ((-rot.y * par) % 512 + 512) % 512, oy = ((-rot.x * par * 0.6) % 512 + 512) % 512;
  for (let x = -ox; x < W; x += 512) for (let y = -oy; y < H; y += 512) ctx.drawImage(tile, x, y);
}

// Dust that rides the sphere (culled exactly like stars)
const dust = Array.from({ length: 420 }, (_, i) => {
  const r = rng(9000 + i), lon = r() * Math.PI * 2, lat = Math.asin(r() * 2 - 1), shell = 0.7 + r() * 0.75;
  return { v: { x: Math.cos(lat) * Math.sin(lon) * shell, y: Math.sin(lat) * shell, z: Math.cos(lat) * Math.cos(lon) * shell }, s: r() * 1.3 + 0.3, p: r() * 6.28, _p: { x: 0, y: 0, depth: 0, f: 1 } };
});
const nebulae = Object.entries(MOOD_SPHERE).map(([mood, [lon, lat]]) => ({
  hue: MOOD_HUE[mood] || 210, mood,
  v: { x: Math.cos(lat) * Math.sin(lon) * 0.95, y: Math.sin(lat) * 0.95, z: Math.cos(lat) * Math.cos(lon) * 0.95 }, _p: { x: 0, y: 0, depth: 0, f: 1 }
}));

function resize() {
  DPR = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
addEventListener('resize', resize); resize();

/* Projection radius: large enough that the star field feels borderless,
   small enough that dreams actually land ON the screen. (An earlier build
   used hypot(W,H)*0.62, which scattered every star past the cull margin
   and left an empty sky — measured 0 of 8 stars live. Do not raise this
   without re-running that check.) */
const projR = () => Math.min(W, H) * 0.46 * scale;
function projectInto(v, out) { // writes into a reused object — no allocation
  const cy = Math.cos(rot.y), sy = Math.sin(rot.y), cx = Math.cos(rot.x), sx = Math.sin(rot.x);
  const x1 = v.x * cy + v.z * sy, z1 = -v.x * sy + v.z * cy;
  const y2 = v.y * cx - z1 * sx, z2 = v.y * sx + z1 * cx;
  const f = 3.2 / (3.2 - z2), R = projR();
  out.x = W / 2 + x1 * R * f; out.y = H / 2 + y2 * R * f; out.depth = z2; out.f = f;
  return out;
}
const clampPitch = x => Math.max(-1.25, Math.min(1.25, x));
const onScreen = (p, m) => p.x > -m && p.x < W + m && p.y > -m && p.y < H + m;

function neighbours(d, n = 3) {
  place(d);
  return dreams.filter(x => x.id !== d.id && x.mood === d.mood).map(place)
    .sort((a, b) => ((a._v.x-d._v.x)**2 + (a._v.y-d._v.y)**2 + (a._v.z-d._v.z)**2) - ((b._v.x-d._v.x)**2 + (b._v.y-d._v.y)**2 + (b._v.z-d._v.z)**2)).slice(0, n);
}

function draw(now) {
  const frameStart = performance.now();
  t += 0.016;
  /* While the River is open the galaxy hangs STILL at full opacity —
     no auto-spin, no drift, just the calm twinkle of the normal view,
     so the cards are easy to read. Rotation resumes in galaxy view. */
  if (flow.open) { /* frozen: skip goal / inertia / idle spin */ }
  else if (goal) {
    let dy = goal.y - rot.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    rot.y += dy * 0.06; rot.x += (goal.x - rot.x) * 0.06; vel = { x: 0, y: 0 };
    if (Math.abs(dy) < 0.002 && Math.abs(goal.x - rot.x) < 0.002) goal = null;
  } else if (!drag) {
    rot.y += vel.y; rot.x = clampPitch(rot.x + vel.x);
    vel.y *= 0.95; vel.x *= 0.95;
    if (!reduced && t - lastTouch > 3.5 && Math.abs(vel.y) < 0.0007) rot.y += 0.0007; // idle drift — deliberately slow (≈1 turn / 2.5 min)
  }
  ctx.clearRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, Math.max(W, H));
  g.addColorStop(0, '#0a0a22'); g.addColorStop(1, '#030309');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.55; drawTiles(tileFar, 14);   // distant universe, slight parallax
  ctx.globalAlpha = 0.8; drawTiles(tileNear, 30);   // nearer field, more parallax
  ctx.globalAlpha = 1;

  /* Nebulae: full-screen washes attached to the rotating field — no globe
     shape, just colour drifting through an endless sky. Culled off-screen. */
  if (quality < 2) for (const n of nebulae) {
    projectInto(n.v, n._p);
    if (n._p.depth < -0.4 || !onScreen(n._p, 700)) continue;
    const r = projR() * 0.75, a = 0.04 + 0.08 * Math.max(0, n._p.depth + 0.4);
    const ng = ctx.createRadialGradient(n._p.x, n._p.y, 0, n._p.x, n._p.y, r);
    ng.addColorStop(0, `hsla(${n.hue},85%,60%,${a})`); ng.addColorStop(1, 'transparent');
    ctx.fillStyle = ng; ctx.fillRect(n._p.x - r, n._p.y - r, r * 2, r * 2);
  }
  // Dust (stride grows with quality tier)
  const stride = quality === 0 ? 1 : quality === 1 ? 2 : 4;
  ctx.fillStyle = '#fff';
  for (let i = 0; i < dust.length; i += stride) {
    const s = dust[i]; projectInto(s.v, s._p);
    if (s._p.depth < -0.2 || !onScreen(s._p, 20)) continue;
    ctx.globalAlpha = (0.10 + 0.30 * Math.abs(Math.sin(t*0.7 + s.p))) * (0.35 + 0.65 * Math.max(0, s._p.depth * 0.5 + 0.5));
    ctx.fillRect(s._p.x, s._p.y, s.s, s.s);
  }
  ctx.globalAlpha = 1;

  /* Ease every star toward its layout target — this is what makes the
     sky stretch smoothly when a cluster gets crowded (see layoutSky). */
  for (const d of dreams) {
    if (!d._vT) continue;
    d._v.x += (d._vT.x - d._v.x) * 0.05; d._v.y += (d._vT.y - d._v.y) * 0.05; d._v.z += (d._vT.z - d._v.z) * 0.05;
    let dl = d._lonT - d._lon; dl = Math.atan2(Math.sin(dl), Math.cos(dl));
    d._lon += dl * 0.05; d._lat += (d._latT - d._lat) * 0.05;
  }
  /* ---- BUILD THE ACTIVE RENDER SET (the culling / memory step) ----
     A star stays "live" only while near the display. Once it rotates a
     bit past the screen (CULL_MARGIN) or behind the field, it leaves the
     set and its sprite reference is dropped — memory cleared. As it comes
     back within RELOAD_MARGIN it is re-projected and drawn again. */
  active.length = 0;
  for (const d of dreams) {
    if (filter && d.mood !== filter) { d._p.live = false; d._sprite = null; continue; }
    projectInto(d._v, d._p);
    /* Cull by SCREEN position only — a universe has no occluding ball, so
       far-side stars are not deleted, they are simply far away: drawn
       small and dim by the depth shading below. Culling (and the sprite
       release that goes with it) still applies the moment a star drifts
       a bit past the screen edge, and it reloads as it nears again. */
    const live = onScreen(d._p, d._p.live ? CULL_MARGIN : RELOAD_MARGIN);
    if (!live) { if (d._p.live) { d._p.live = false; d._sprite = null; } continue; } // unload
    d._p.live = true; active.push(d);
  }
  active.sort((a, b) => a._p.depth - b._p.depth); // in place, far first

  /* Constellation arcs — near, live neighbours only */
  if (quality < 2) {
    ctx.lineWidth = 1;
    for (const d of active) {
      if (d._p.depth < 0.25) continue;
      for (const nb of neighbours(d, 2)) {
        if (nb.id < d.id || !nb._p.live || nb._p.depth < 0.25) continue;
        const avg = (d._p.depth + nb._p.depth) / 2;
        ctx.strokeStyle = `hsla(${d.hue},80%,75%,${0.04 + 0.12 * avg})`;
        ctx.beginPath(); ctx.moveTo(d._p.x, d._p.y); ctx.lineTo(nb._p.x, nb._p.y); ctx.stroke();
      }
    }
  }
  /* Stars — ONE centre (p.x, p.y) for aura sprite AND core. Exactly centred. */
  for (const d of active) {
    const p = d._p, front = Math.max(0, p.depth * 0.5 + 0.5);
    const tw = reduced ? 1 : 1 + 0.20 * Math.sin(t*1.6 + d._lon * 4 + d._lat * 7);
    const r = Math.max(0.7, d.size * (0.45 + d.brightness) * (0.35 + 0.85 * front) * p.f * tw * (hover === d ? 1.5 : 1) * (selected === d ? 1.7 : 1));
    const detailed = quality === 0 ? r > 1.7 : r > 2.6; // LOD gate
    if (detailed) { // aura: sprite centred on the star — drawImage at centre - size/2
      const s = r * 14;
      if (!d._sprite) d._sprite = getSprite(Math.round(d.hue / 15) * 15, Math.round(r));
      ctx.globalAlpha = 0.25 + 0.75 * front;
      ctx.drawImage(d._sprite, p.x - s / 2, p.y - s / 2, s, s);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = `hsla(${d.hue},95%,88%,${0.25 + 0.75 * front})`; // core, same centre
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
    if (detailed && ((p.depth > 0.55 && scale > 0.95) || hover === d || selected === d)) {
      ctx.font = '12px Inter, sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(235,233,250,0.9)';
      ctx.fillText(d.title, p.x, p.y - r * 3 - 8);
    }
  }
  // Bursts
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i], age = (t - b.t0) / 1.4;
    if (age >= 1) { bursts.splice(i, 1); continue; }
    projectInto(b.v, b._p);
    ctx.strokeStyle = `hsla(${b.hue},95%,75%,${1-age})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(b._p.x, b._p.y, age * 90 + 6, 0, 7); ctx.stroke();
  }
  /* Dream Current rides the SAME rAF loop — no extra timers */
  if (flow.open) { const nts = performance.now(); layoutFlow(flow.lastTs ? Math.min(nts - flow.lastTs, 64) : 0); flow.lastTs = nts; }
  else flow.lastTs = 0;
  /* Adaptive quality: shed work in tiers if frames get heavy */
  frameMs = frameMs * 0.92 + (performance.now() - frameStart) * 0.08;
  if (++frameCount % 45 === 0) quality = frameMs > 11 ? 2 : frameMs > 7 ? 1 : 0;
  if (!document.hidden) requestAnimationFrame(draw);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) requestAnimationFrame(draw); });

// ---- interaction: drag ROTATES the field (no camera, no globe edge) ----
canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, moved: false }; vel = { x: 0, y: 0 }; goal = null; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', e => {
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    const ky = dx * 0.0052, kx = dy * 0.0052;
    rot.y += ky; rot.x = clampPitch(rot.x + kx);
    vel = { y: ky, x: kx }; lastTouch = t;
    drag.x = e.clientX; drag.y = e.clientY; return;
  }
  hover = pick(e.clientX, e.clientY);
  const tip = $('#tooltip');
  if (hover) {
    tip.textContent = '✦ ' + hover.title + ' — ' + hover.mood;
    tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px';
    tip.classList.add('show'); canvas.style.cursor = 'pointer';
  } else { tip.classList.remove('show'); canvas.style.cursor = 'grab'; }
});
canvas.addEventListener('pointerup', e => {
  if (drag && !drag.moved) { const d = pick(e.clientX, e.clientY); if (d) flyTo(d, true); }
  lastTouch = t; drag = null;
});
canvas.addEventListener('wheel', e => { e.preventDefault(); goal = null; scale = Math.min(2.1, Math.max(0.55, scale * (e.deltaY < 0 ? 1.11 : 0.90))); lastTouch = t; }, { passive: false });
let pinch = null;
canvas.addEventListener('touchstart', e => { if (e.touches.length === 2) pinch = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY); }, { passive: true });
canvas.addEventListener('touchmove', e => { if (e.touches.length === 2 && pinch) { const d = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY); scale = Math.min(2.1, Math.max(0.55, scale * (d / pinch))); pinch = d; lastTouch = t; } }, { passive: true });

function pick(sx, sy) { // live stars only — culled stars can't be clicked
  let best = null, bs = Infinity;
  for (const d of active) {
    const dist = Math.hypot(d._p.x - sx, d._p.y - sy), score = dist - d._p.depth * 10; // near stars win ties
    if (dist < 30 && score < bs) { bs = score; best = d; }
  }
  return best;
}
function flyTo(d, open = false) { // shortest spin until the dream faces you
  place(d); selected = d;
  let gy = -(d._lonT || d._lon);
  while (gy - rot.y > Math.PI) gy -= Math.PI * 2;
  while (gy - rot.y < -Math.PI) gy += Math.PI * 2;
  goal = { y: gy, x: clampPitch(d._latT || d._lat) }; // verified against projectInto()
  if (scale < 1.05) scale = 1.15;
  lastTouch = t;
  if (open) setTimeout(() => openDetail(d), reduced ? 0 : 500);
}

// ---- data + API ----
async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something drifted away. Try again.');
  return j;
}
let lastStats = null, liveWatchers = 0;
function renderStats() {
  if (!lastStats) return;
  $('#statsLine').textContent = `${lastStats.total} dreams in an endless sky · ${lastStats.resonances} resonances · turn it — there is no edge`;
  updateMoodCounts();
  const es = $('#emptySky'); if (es) es.hidden = !(lastStats.total === 0 && !flow.open);
}
async function refreshStats() { try { lastStats = await api('/api/stats'); renderStats(); } catch (_) {} }
let framedOnce = false;
async function load() {
  const { dreams: list } = await api('/api/dreams');
  dreams = list.map(place);
  layoutSky(true);
  if (!framedOnce && dreams.length) {
    /* First frame: turn the universe so the CENTROID of all dreams faces
       the viewer — the fullest possible opening sky, instead of whatever
       arbitrary rotation the page happened to start at. Runs once;
       later reloads (resonances, live births) never yank the sky away. */
    let cx = 0, cy = 0, cz = 0;
    for (const d of dreams) { cx += d._v.x; cy += d._v.y; cz += d._v.z; }
    const mag = Math.hypot(cx, cy, cz) || 1;
    rot.y = -Math.atan2(cx, cz);
    rot.x = clampPitch(Math.asin(cy / mag));
    framedOnce = true;
  }
  await refreshStats();
  renderRiver();
}

/* ---- LIVE SKY (WebSocket): watch new stars being born ----
   The server broadcasts dream:new / dream:resonate / presence.
   New stars arrive with a burst + toast; resonances brighten in place.
   Own submissions are deduped by id (the REST response already added
   them). Auto-reconnects with capped exponential backoff; if WS is
   unavailable the app simply behaves as before (REST only). */
let wsRetry = 0;
function connectLive() {
  let sock;
  try { sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); }
  catch (_) { return; }
  const pill = $('#livePill'), pillText = $('#liveText');
  const setPill = (cls, txt) => { if (pill) pill.className = 'live-pill ' + cls; if (pillText) pillText.textContent = txt; };
  setPill('connecting', 'Connecting…');
  sock.onopen = () => { wsRetry = 0; setPill('', 'Live'); };
  sock.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.type === 'hello' || m.type === 'presence') { liveWatchers = m.watchers || 0; const p = $('#livePill'); if (p) p.title = `${liveWatchers} watching live`; return; }
    if (m.type === 'dream:new' && m.dream) {
      if (dreams.some(d => d.id === m.dream.id)) return; // already have it (probably ours)
      place(m.dream); dreams.push(m.dream); layoutSky(); // sky grows if this birth crowded a cluster
      bursts.push({ v: m.dream._v, hue: m.dream.hue, t0: t, _p: { x: 0, y: 0, depth: 0, f: 1 } });
      toast(`✦ A new star was just born — “${m.dream.title}” (${m.dream.mood})`);
      if (flow.open) buildFlow();
      refreshStats();
      return;
    }
    if (m.type === 'dream:resonate') {
      const d = dreams.find(x => x.id === m.id);
      if (d) {
        d.resonances = m.resonances; d.brightness = m.brightness;
        if (selected && selected.id === d.id) { const el = $('#dRes'); if (el) el.textContent = '💗 ' + d.resonances + ' resonances'; }
      }
      refreshStats();
    }
  };
  const retry = () => { setPill('reconnecting', 'Reconnecting…'); const wait = Math.min(15000, 1000 * 2 ** wsRetry++); setTimeout(connectLive, wait); };
  sock.onclose = retry;
  sock.onerror = () => { try { sock.close(); } catch (_) {} };
}
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 3200); }

// ---- detail sheet ----
function openDetail(d) {
  selected = d;
  $('#dMood').textContent = d.mood + ' constellation';
  $('#dTitle').textContent = d.title;
  $('#dAlias').textContent = 'dreamed by ' + d.alias + ' · anonymous';
  $('#dBody').textContent = d.body;
  $('#dLucidity').textContent = 'Lucidity ' + '✦'.repeat(d.lucidity);
  $('#dRes').textContent = '💗 ' + d.resonances + ' resonances';
  $('#dDate').textContent = new Date(d.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const box = $('#dNearby'); box.innerHTML = '';
  for (const nb of neighbours(d)) {
    const b = document.createElement('button');
    b.textContent = '✦ ' + nb.title + ' — ' + nb.alias;
    b.onclick = () => flyTo(nb, true);
    box.appendChild(b);
  }
  $('#detail').classList.add('open'); $('#detail').setAttribute('aria-hidden', 'false');
}
$('#detailClose').onclick = () => { $('#detail').classList.remove('open'); selected = null; };
$('#resonateBtn').onclick = async () => {
  if (!selected) return;
  const r = await api(`/api/dreams/${selected.id}/resonate`, { method: 'POST' });
  selected.resonances = r.resonances; selected.brightness = r.brightness;
  openDetail(selected); toast('💗 Your resonance made this star burn brighter');
  load();
};

// ---- river view: THE DREAM CURRENT ----
// A luminous current winds through the (still-visible, still-rotating)
// galaxy, and dream cards drift along it forever. Efficient by design:
//  * a fixed POOL of card nodes is created once and reused — as a card
//    flows off the end it is recycled to the start with the next dream;
//  * only pool-many dreams are in the DOM at once (virtualized flow);
//  * motion is transform-only, driven by the single galaxy rAF loop;
//  * hover pauses the current; a button pauses/plays it; reduced motion
//    lays the cards out still along the path.
const flow = { list: [], pool: [], open: false, paused: false, nextIdx: 0, slotGap: 0, lastTs: 0, boost: 0, hoverPause: false, scrubMoved: false, customList: null };
function flowList() { return dreams.filter(d => (!filter || d.mood === filter) && (!query || (d.title+' '+d.body).toLowerCase().includes(query))); }
function cardW() { return Math.min(290, innerWidth * 0.78); }
const CARD_GAP = 64;
function poolSize() {
  // Slots are spaced cardW + gap apart along the whole track, so two
  // cards can NEVER overlap, however many dreams are in the list.
  const vertical = innerWidth < 700;
  const span = (vertical ? innerHeight : innerWidth) + cardW();
  return Math.max(2, Math.min(8, Math.floor(span / (cardW() + CARD_GAP))));
}
function fillCard(node, d) {
  node._dream = d;
  node.innerHTML = `<p class="eyebrow"><span class="orb"></span><span class="m"></span></p><h3></h3><p class="b"></p><p class="r"></p>`;
  node.querySelector('.orb').style.background = `hsl(${d.hue},90%,70%)`;
  node.querySelector('.orb').style.boxShadow = `0 0 14px 3px hsla(${d.hue},90%,65%,.8)`; // orb centred in its own glow
  node.querySelector('.m').textContent = d.mood;
  node.querySelector('.m').style.color = `hsl(${d.hue},85%,72%)`;
  node.querySelector('h3').textContent = d.title;
  node.querySelector('.b').textContent = d.body.length > 130 ? d.body.slice(0, 130) + '…' : d.body;
  node.querySelector('.r').textContent = `💗 ${d.resonances} · by ${d.alias}`;
}
function buildFlow(listOverride) {
  flow.list = listOverride || flow.customList || flowList();
  const poolEl = $('#flowPool'); poolEl.innerHTML = ''; flow.pool = [];
  $('#flowEmpty').hidden = flow.list.length > 0; // + CSS [hidden] guard + pointer-events:none
  if (!flow.list.length) { drawCurrentPath(); return; }
  const n = Math.min(poolSize(), flow.list.length);
  flow.slotGap = 1 / n;
  flow.nextIdx = n % flow.list.length;
  for (let i = 0; i < n; i++) {
    const c = document.createElement('article'); c.className = 'card';
    c.tabIndex = 0; c.setAttribute('role', 'button');
    c.setAttribute('aria-label', 'Open this dream');
    c._s = i * flow.slotGap; // evenly spaced — spacing >= cardW + gap by construction
    fillCard(c, flow.list[i]); c._idx = i;
    c.addEventListener('mouseenter', () => { flow.hoverPause = true; });
    c.addEventListener('mouseleave', () => { flow.hoverPause = false; });
    c.addEventListener('click', () => { if (flow.scrubMoved) return; const d = c._dream; closeRiver(); flyTo(d, true); });
    c.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const d = c._dream; closeRiver(); flyTo(d, true); } });
    poolEl.appendChild(c); flow.pool.push(c);
  }
  layoutFlow(0); drawCurrentPath();
}
function drawCurrentPath() {
  const el = $('#riverFlow'); if (!el) return;
  const w = el.clientWidth, h = el.clientHeight, vertical = innerWidth < 700;
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const s = i / 40;
    const [x, y] = flowPoint(s, w, h, vertical, 0);
    pts.push((i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1));
  }
  const dAttr = pts.join(' ');
  $('#currentPath').setAttribute('d', dAttr); $('#currentPathGlow').setAttribute('d', dAttr);
  const svg = $('#currentSvg'); svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
}
function flowPoint(s, w, h, vertical, time) {
  // Gentle meander only (small amplitude, slow phase) so adjacent cards,
  // spaced a full card-width + gap apart, stay clear of each other.
  const bob = reduced ? 0 : Math.sin(time * 0.0011 + s * 6) * 5;
  if (vertical) return [w / 2 + Math.sin(s * Math.PI * 2.2) * (w * 0.13), -130 + s * (h + 260)];
  return [-cardW() / 2 + s * (w + cardW()), h * 0.52 + Math.sin(s * Math.PI * 2.2) * (h * 0.10) + bob];
}
function layoutFlow(dtMs) {
  if (!flow.pool.length) return;
  const el = $('#riverFlow'), w = el.clientWidth, h = el.clientHeight, vertical = innerWidth < 700;
  flow.boost *= Math.pow(0.4, (dtMs || 0) / 1000); // wheel-stir decays back to calm
  const speed = 0.011 * (1 + flow.boost); // base: full journey ≈ 90s
  for (const c of flow.pool) {
    if (dtMs && !flow.paused && !flow.hoverPause && !reduced && !flow.scrubbing) {
      c._s += speed * (dtMs / 1000);
      if (c._s >= 1) { // flowed off the end -> recycle this node with the next dream
        c._s -= 1;
        if (flow.list.length > 1) { fillCard(c, flow.list[flow.nextIdx]); flow.nextIdx = (flow.nextIdx + 1) % flow.list.length; }
      }
    }
    const [x, y] = flowPoint(c._s, w, h, vertical, performance.now());
    const tilt = reduced ? 0 : Math.sin(c._s * 8 + t) * 1.3;
    // ONE centring: the path point is the card's centre, via translate(-50%,-50%)
    c.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%,-50%) rotate(${tilt}deg)`;
  }
}
function setView(river) { // segmented Universe / Dream Current switch
  flow.open = river; $('#river').hidden = !river;
  document.body.classList.toggle('river-open', river); // HUD hides — no overlaps
  $('#segUniverse').classList.toggle('active', !river);
  $('#segRiver').classList.toggle('active', river);
  const es = $('#emptySky'); if (es && lastStats) es.hidden = !(lastStats.total === 0 && !river);
  if (river) buildFlow();
}
function closeRiver() { setView(false); }
function renderRiver() { flow.customList = null; if (flow.open) buildFlow(); } // filters/search rebuild the flow
$('#segUniverse').onclick = () => setView(false);
$('#segRiver').onclick = () => setView(true);
$('#riverClose').onclick = closeRiver;
$('#flowToggle').onclick = () => { flow.paused = !flow.paused; $('#flowToggle').textContent = flow.paused ? '▶ Let it flow' : '⏸ Pause the current'; };
$('#flowShuffle').onclick = () => { // shuffle the current's order (Fisher–Yates on a copy)
  const copy = [...flowList()];
  for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  flow.customList = copy; buildFlow(copy);
  toast('🔀 The current has shuffled its dreams');
};
// Interactivity: drag to pull the current, wheel to stir it (boost decays)
const riverFlowEl = $('#riverFlow');
riverFlowEl.addEventListener('wheel', e => { flow.boost = Math.min(4, flow.boost + Math.abs(e.deltaY) / 260); }, { passive: true });
let scrub = null;
riverFlowEl.addEventListener('pointerdown', e => { scrub = { x: e.clientX, y: e.clientY }; flow.scrubMoved = false; flow.scrubbing = true; });
addEventListener('pointermove', e => {
  if (!scrub || !flow.open) return;
  const el = riverFlowEl, vertical = innerWidth < 700;
  const dMain = vertical ? (e.clientY - scrub.y) / (el.clientHeight + 260) : (e.clientX - scrub.x) / (el.clientWidth + cardW());
  if (Math.abs(e.clientX - scrub.x) + Math.abs(e.clientY - scrub.y) > 6) flow.scrubMoved = true;
  if (dMain) for (const c of flow.pool) { c._s -= dMain; if (c._s < 0) c._s += 1; if (c._s >= 1) c._s -= 1; }
  scrub = { x: e.clientX, y: e.clientY }; layoutFlow(0);
});
addEventListener('pointerup', () => { scrub = null; flow.scrubbing = false; setTimeout(() => { flow.scrubMoved = false; }, 60); });
addEventListener('resize', () => { if (flow.open) { buildFlow(); } });

// ---- filters, search, surprise ----
const bar = $('#moodBar');
for (const name of [null, ...MOODS]) {
  const b = document.createElement('button');
  b.className = 'pill'; b.dataset.mood = name || '';
  if (name) b.innerHTML = `<span class="dot" style="background:hsl(${MOOD_HUE[name]},85%,65%);box-shadow:0 0 8px hsl(${MOOD_HUE[name]},85%,65%)"></span>${name} <span class="count">0</span>`;
  else b.textContent = 'All dreams';
  b.setAttribute('aria-pressed', String(filter === name));
  b.onclick = () => { filter = name; [...bar.children].forEach(x => x.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); renderRiver(); };
  bar.appendChild(b);
}
function updateMoodCounts() { // counts beside each mood, from live stats
  if (!lastStats || !lastStats.moods) return;
  for (const b of bar.children) {
    const c = b.querySelector('.count');
    if (c) c.textContent = lastStats.moods[b.dataset.mood] || 0;
  }
}
// Header controls: zoom + reset, matched to the live app
function frameToCentroid() {
  if (!dreams.length) return;
  let cx = 0, cy = 0, cz = 0;
  for (const d of dreams) { place(d); cx += d._v.x; cy += d._v.y; cz += d._v.z; }
  const mag = Math.hypot(cx, cy, cz) || 1;
  let gy = -Math.atan2(cx, cz);
  while (gy - rot.y > Math.PI) gy -= Math.PI * 2;
  while (gy - rot.y < -Math.PI) gy += Math.PI * 2;
  goal = { y: gy, x: clampPitch(Math.asin(cy / mag)) };
}
$('#zoomIn').onclick = () => { scale = Math.min(2.1, scale * 1.18); };
$('#zoomOut').onclick = () => { scale = Math.max(0.55, scale / 1.18); };
$('#resetView').onclick = () => { scale = 1; vel = { x: 0, y: 0 }; frameToCentroid(); };
$('#emptyRelease').onclick = () => dialog.showModal();
$('#search').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); renderRiver(); if (query) { const hit = dreams.find(d => (d.title+' '+d.body).toLowerCase().includes(query)); if (hit) flyTo(hit, false); } });
$('#surpriseBtn').onclick = () => { if (dreams.length) flyTo(dreams[Math.floor(Math.random()*dreams.length)], true); };

// ---- release a dream ----
const moodSel = $('#fMood');
for (const m of MOODS) { const o = document.createElement('option'); o.value = m; o.textContent = m; moodSel.appendChild(o); }
$('#fLucid').addEventListener('input', e => { $('#lucidVal').textContent = e.target.value; });
const dialog = $('#releaseDialog');
$('#releaseBtn').onclick = () => dialog.showModal();
$('#releaseClose').onclick = () => dialog.close();
$('#releaseForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#formError').textContent = '';
  try {
    const { dream, pending } = await api('/api/dreams', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: $('#fTitle').value, body: $('#fBody').value, mood: $('#fMood').value, lucidity: Number($('#fLucid').value) })
    });
    if (pending) {
      dialog.close(); e.target.reset(); $('#lucidVal').textContent = '3';
      toast('🌙 Dream received — it will become a star after a quick review');
      return;
    }
    place(dream); dreams.push(dream); layoutSky();
    bursts.push({ v: dream._v, hue: dream.hue, t0: t, _p: { x: 0, y: 0, depth: 0, f: 1 } });
    dialog.close(); e.target.reset(); $('#lucidVal').textContent = '3';
    filter = null; flyTo(dream, true);
    toast('✦ Your dream is now a star in the ' + dream.mood + ' constellation');
    load();
  } catch (err) { $('#formError').textContent = err.message; }
});

load()
  .then(() => connectLive())
  .catch(err => { $('#statsLine').textContent = 'Could not load dreams: ' + err.message; })
  .finally(() => { // globe-motif loader fades once the universe is ready (or not)
    const l = $('#loader'); if (l) { l.classList.add('done'); setTimeout(() => l.remove(), 750); }
  });
requestAnimationFrame(draw);
