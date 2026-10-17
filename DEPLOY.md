# ✦ Putting the Constellation online — so actual strangers can add stars

The live Muse version is already shareable from its card. This guide is for
self-hosting the standalone project (`~/workspace/dream-constellation`) at a
public URL of your own.

## The one thing that will bite you

Every dream lives in **one JSON file** (`data/dreams.json`). Most hosts give
your app an *ephemeral* filesystem: the file is wiped on every redeploy or
restart, and the galaxy quietly resets to the 8 seeded dreams.

Fix, already wired into `server.js` (verified 2026-10-17):

- `PORT` — already supported; hosts set this automatically.
- **`DATA_DIR`** (new) — point it at the host's persistent-volume mount,
  e.g. `DATA_DIR=/data`. Local behaviour is unchanged if you don't set it.
  `DATA_FILE` (full path) also works.

So on any host: **attach a small persistent volume (1 GB is plenty to start),
mount it, set `DATA_DIR` to that mount path.** Then deploy normally:
build = none, start = `npm start`, Node 18+.

## Three checked options (prices checked 2026-10-17, confirm at signup)

| Host | Shape of the deploy | Rough starting cost | Watch out |
|---|---|---|---|
| **Fly.io** | `fly launch`, 1 small Machine + a Fly Volume mounted at `/data`, `DATA_DIR=/data` | Shared-cpu-1x 256 MB Machine listed at $2.19/mo; volumes $0.15/GB/mo on Fly's official pricing page | No free tier — pay-as-you-go. Asia-Pacific/India egress is the priciest band ($0.12/GB), still trivial at dream-journal traffic |
| **Railway** | Connect the project, add a Volume mounted at `/data`, set `DATA_DIR=/data`, generate a public domain | Hobby is a $5/mo minimum-usage plan in current comparisons; volumes $0.15/GB/mo | Volumes are single-region and **not backed up automatically** — download `dreams.json` now and then if the galaxy matters to you |
| **Render** | Web Service + Persistent Disk mounted at e.g. `/var/data`, `DATA_DIR=/var/data` | Free web service exists but spins down when idle and disks are a paid add-on ($0.25/GB/mo in current pricing listings); smallest always-on service listed at $7/mo | A sleeping galaxy is a bad first impression — if you pick Render, pick the always-on tier |

**Recommendation if you just want it public this weekend:** Railway for the
fewest steps, Fly.io if you want the cheapest always-on bill and don't mind
a CLI. Either way the volume + `DATA_DIR` step is the whole trick.

## Before you share the link publicly — safeguards now built in (added 2026-10-17)

All three are in `server.js`, zero-dependency, and verified end-to-end
against a throwaway data dir (the real galaxy still holds its 8 seeds):

1. **Rate limiting — always on.** 5 dream posts and 60 resonates per IP
   per 10 minutes; over the limit the API returns `429` with a
   `Retry-After` header. Submissions containing a link are also rejected
   as spam. (Behind a host proxy, set `TRUST_PROXY=1` so limits key on
   the real visitor IP from `X-Forwarded-For`.)
2. **Moderation / hold-for-review — opt-in, one env pair.** Set
   `MODERATION=hold` and `ADMIN_TOKEN=<a long random secret>` on the host.
   New dreams then return `202`, stay invisible, and wait for review:
   ```bash
   curl https://YOUR-URL/api/moderation/queue -H "x-admin-token: $ADMIN_TOKEN"
   curl -X POST https://YOUR-URL/api/moderation/<dream-id>/approve -H "x-admin-token: $ADMIN_TOKEN"
   curl -X POST https://YOUR-URL/api/moderation/<dream-id>/reject  -H "x-admin-token: $ADMIN_TOKEN"
   ```
   Leave `MODERATION` unset for the original instant-star flow (fine for
   sharing with friends). Note the backups folder sits next to your data
   file, so put it on the same persistent volume.
3. **Backups — automatic.** On startup and every 60 minutes
   (`BACKUP_INTERVAL_MIN` to change it) the server copies the data file
   to `<data dir>/backups/dreams-<timestamp>.json`, keeping the newest 24.
   That's roughly a day of hourly restore points; for longer history,
   occasionally download the folder — hosts do not back up volumes for you.

## Smoke test after deploying

```bash
curl https://YOUR-URL/api/health   # {"ok":true,"dreams":8} on a fresh deploy
curl https://YOUR-URL/api/stats
```

Post one dream in the browser, redeploy/restart once, and confirm it's still
there. That restart test is the proof the volume is actually doing its job.

## Ready-made configs (added 2026-10-17, later)

So the deploy is copy-paste, not config-writing, the project now ships with:

- **`Dockerfile`** — `node:20-alpine`, no install step (zero dependencies);
  used by both hosts below. Verified by simulation: booting with an empty
  `DATA_DIR` (like a fresh volume) seeds the 8 dreams and `/api/health`
  returns `{"ok":true,"dreams":8}`.
- **`fly.toml`** — Fly.io: volume `dream_data` mounted at `/data`,
  `DATA_DIR=/data`, `TRUST_PROXY=1`, Mumbai (`bom`) region, and
  `auto_stop_machines = false` + `min_machines_running = 1` so the galaxy
  never sleeps. Before deploying, create the volume once:
  `fly volumes create dream_data --size 1 --region bom`, and rename `app`
  if `dream-constellation` is taken. For hold-for-review, uncomment
  `MODERATION` in the file and set `ADMIN_TOKEN` via `fly secrets set`.
  Railway note: `railway.json` covers build/start; the volume itself is
  added in the Railway dashboard (mount path `/data`, set `DATA_DIR=/data`)
  — Railway does not let a config file create volumes.
- **`railway.json`** — Railway: Dockerfile build, `npm start`, restart on
  failure.
