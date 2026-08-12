# Deploying Vobo

Railway + Cloudflare only. One project, one environment per stage, three services
per environment: `postgres`, `vobo-web`, `vobo-worker`.

## Current state (2026-08-12)

| | Staging | Production |
|---|---|---|
| Railway project | `vobo` — `77040176-2d64-412b-b906-20c37518d188` (team Beton) | same project |
| Environment | `staging` — `296c84f7-…` | `production` — `fe163ce5-…` |
| URL | https://vobo-web-staging.up.railway.app | not created yet |
| Postgres | `postgres` + volume, seeded | **not created yet** |
| Services | `vobo-web`, `vobo-worker` — deployed, green | start commands pre-set, never deployed |

Staging runs the `feature/VOBO-1-mvp` branch, uploaded with `railway up`.

## Two things must happen before production exists

1. **Grant Railway's GitHub App access to `getbeton/vobo`.** It currently sees only
   `getbeton/inspector-ml-backend`, `nadyyym/data-atlas`, `aderiushev/duet-couples-app`, so
   git-fed deploys are impossible for this repo. Until then every deploy is a manual
   `railway up` upload, which is fine for staging and wrong for production.
   → GitHub → org `getbeton` → Settings → GitHub Apps → Railway → Configure → add `vobo`.
2. **Decide to pay for it.** A production environment is a second Postgres plus two
   always-on services. There is no user traffic yet; staging is enough to dogfood the PICO
   loop. Spin it up when the loop is worth protecting, not before.

## Bringing up an environment from scratch

```bash
ENV=production   # or staging
railway link -p 77040176-2d64-412b-b906-20c37518d188 -e $ENV
```

1. **Postgres.** Service from image `ghcr.io/railwayapp-templates/postgres-ssl:16`, variables
   `POSTGRES_USER=postgres`, `POSTGRES_PASSWORD=<random>`, `POSTGRES_DB=railway`,
   `PGDATA=/var/lib/postgresql/data/pgdata`, and a volume mounted at
   `/var/lib/postgresql/data`.
2. **Variables on `vobo-web` and `vobo-worker`** (both need the DB — the worker runs sweeps):

   | Var | Value |
   |---|---|
   | `POSTGRES_URL` | `postgres://postgres:<pw>@<service>.railway.internal:5432/railway` |
   | `AUTH_SECRET` / `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
   | `BETTER_AUTH_URL` | the public web URL |

   ⚠️ Use the **actual** `RAILWAY_PRIVATE_DOMAIN` of the Postgres service, which is
   `postgres-<suffix>.railway.internal` — not `postgres.railway.internal`. Guessing it cost a
   crashed boot with `28P01 password authentication failed` against a different service.
3. **Start commands**: web `npm run boot`, worker `npm run worker`. `boot` replays migrations
   (`scripts/migrate.mjs`, drizzle journal, production deps only) before `next start`, so a
   deploy is always schema-correct.
4. **Domain**: `serviceDomainCreate` on `vobo-web`, then set `BETTER_AUTH_URL` to match.
5. **Deploy**: `railway up --service vobo-web` and `--service vobo-worker` (or push, once the
   GitHub grant exists).
6. **Seed** (first time only). The DB is private; open a TCP proxy on the Postgres service and:
   ```bash
   POSTGRES_URL="postgres://postgres:<pw>@<proxy-host>:<port>/railway" npx tsx lib/db/seed.ts
   ```
   It prints the admin password and API key **once**. Store them in `~/.claude/secrets/vobo.env`.

## Smoke check

```bash
curl -s -o /dev/null -w "%{http_code}\n" $URL/sign-in                      # 200
curl -s $URL/api/v1/reviews?queue=x -H "Authorization: Bearer bogus"       # 401 invalid_token
python3 scripts/pico/vobo.py submit --payload seq.json                     # 201, created: true
python3 scripts/pico/vobo.py submit --payload seq.json                     # 200, created: false
python3 scripts/pico/vobo.py pull --all                                    # the request, max_event_id
```

A 401 on a bogus key proves migrations ran and the API-key table is live — a 500 there means the
boot migration failed.

## Known cleanup

Two stray Postgres services (`Postgres`, `Postgres-r13X`) exist in the project from an
interactive `railway add` that could not be completed non-interactively. They hold no data and
should be deleted in the Railway UI.

## Not on Railway

Nothing else. No Vercel, no Coolify, no GCP. Artifact storage is BYO (S3 or the local `.storage/`
fs driver) — for the PICO loop it points at `s3://pico-abm-research-699619102971/vobo/`.
