# ✦ Constellation of Strangers' Dreams

An anonymous dream journal where every submitted dream becomes a **star**.
Navigate a galaxy of other people's subconscious — drift, zoom, and fly to
the dreams that pull you.

## Run it

```bash
npm start          # zero dependencies — just Node 18+
# open http://localhost:4173
```

`PORT=8080 npm start` to change the port. `npm run dev` for watch mode.

**Hosting it publicly?** Read `DEPLOY.md` first — dreams are stored in one
JSON file, so you need a persistent volume and the `DATA_DIR` env var set to
its mount path, or a redeploy will reset the galaxy to the seeded dreams.

## What's inside

| Part | File | Notes |
|---|---|---|
| Backend | `server.js` | Zero-dependency Node `http` server. REST API + static hosting. Atomic JSON storage in `data/dreams.json` (created + seeded on first run). |
| Frontend | `public/index.html`, `styles.css`, `app.js` | **The Globe:** dreams sit on mood-clustered spherical shells in 3D. Drag rotates the globe itself (yaw wraps forever = an endless galaxy, pitch is clamped), with spin inertia and a slow idle auto-spin. Far-side stars dim/shrink, near-side stars burn bright, constellation arcs bow off the sphere, scroll/pinch scales the globe, and clicking a star rotates it to face you. Twinkling stars, nebulae riding the globe, burst animation when your dream becomes a star. DPR-aware, capped rendering, pauses off-tab, `prefers-reduced-motion` support. |

## API

| Method | Route | Body / Query | Returns |
|---|---|---|---|
| GET | `/api/dreams` | `?mood=&q=&limit=` | `{ dreams: [...] }` |
| POST | `/api/dreams` | `{ title, body, mood, lucidity }` | `201 { dream }` — positioned inside its mood constellation, with a random anonymous alias, hue, size and brightness |
| POST | `/api/dreams/:id/resonate` | — | `{ id, resonances, brightness }` — brightness grows with every resonance |
| GET | `/api/stats` | — | totals, per-mood counts, brightest dream |
| GET | `/api/health` | — | `{ ok, dreams, moderation, watchers }` |
| WS | `/ws` | — | **Live sky.** `{type:'hello'\|'presence', watchers}` on join/leave · `{type:'dream:new', dream}` the moment a dream is released (or approved in hold-for-review mode) · `{type:'dream:resonate', id, resonances, brightness}` on every resonance. Hand-rolled RFC 6455 inside `server.js` — still zero dependencies, 30s heartbeat, watch-only (client messages are ignored). Open pages show new stars being born with a burst, and a 👁 watcher count in the header. |
| GET | `/api/moderation/queue` | header `x-admin-token: $ADMIN_TOKEN` | pending dreams (hold mode) |
| POST | `/api/moderation/:id/approve` · `/reject` | header `x-admin-token: $ADMIN_TOKEN` | publish / delete a held dream |

## Public-safety built in

- **Rate limits** — 5 dream posts and 60 resonates per IP per 10 minutes;
  over the limit returns `429` with `Retry-After`. Failed/spammy attempts
  count toward the post limit.
- **Spam guard** — submissions containing a link (`http(s)://` or `www.`)
  are rejected with a friendly message.
- **Hold-for-review (opt-in)** — start with `MODERATION=hold ADMIN_TOKEN=<a long secret> npm start`
  and new dreams return `202`, stay invisible, and wait in the moderation
  queue until approved. Without `MODERATION=hold`, posting is instant as
  before. The frontend already handles both modes.
- **Backups** — a timestamped copy of the data file is written to
  `<data dir>/backups` on startup and every `BACKUP_INTERVAL_MIN` minutes
  (default 60), keeping the newest 24.

**Moods / constellations:** Peaceful, Anxious, Euphoric, Melancholic,
Surreal, Lucid, Nightmare, Nostalgic — each has its own region and hue in
the galaxy, so similar dreams cluster and link into constellations.

## Features

- Release a dream anonymously (title, story, mood, lucidity 1–5)
- Click a star → the globe rotates it to face you → read the full dream, resonate, jump to neighbours
- Mood filter pills, live search that pulls the camera toward matches
- **Surprise me** (random dream) and the **Dream Current**: the River view is a luminous stream winding through the still-rotating galaxy — dream cards drift along it endlessly on a pooled, virtualized set of DOM nodes (transform-only, driven by the same rAF loop as the galaxy), hover pauses the current to read, and clicking a card rotates its star to face you
- Fully responsive; touch + pinch supported

## Going further

Swap `data/dreams.json` for SQLite/Postgres behind the same API shape,
or add a WebSocket layer to watch new stars appear live.
