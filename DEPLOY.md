# Deploying Vobo

Railway + Cloudflare only. One Railway project, two environments, three services each:
`postgres`, `vobo-web`, `vobo-worker`.

## Topology

| | Staging | Production |
|---|---|---|
| Railway project | `vobo` — `77040176-2d64-412b-b906-20c37518d188` (team Beton) | same project |
| Environment id | `296c84f7-f3bf-43e9-8a0c-1d25a5b18a59` | `1a1e1d85-07c7-4a0b-b170-4e6932c890d4` |
| Git branch | `staging` | `main` |
| App URL | https://vobo-staging-app.getbeton.org | https://app.vobo.dev |
| Railway URL | vobo-web-staging.up.railway.app | vobo-web-production-41cf.up.railway.app |
| DB | own Postgres + volume, own password | own Postgres + volume, own password |
| Auth secret | per-environment | per-environment (never shared) |

`vobo.dev` itself is reserved for the marketing site — do not point it at the app.

**Promotion path:** feature branch → PR to `staging` → merge deploys staging → fast-forward
`main` to `staging` → deploys production. Both are git-fed; a push is the only deploy trigger you
need. The branch lives on the **DeploymentTrigger** and is editable in place.

**DNS convention** (matches data-atlas): `<product>-<env>-<surface>.getbeton.org`, CNAME to
`<hash>.up.railway.app`, **proxied off**. `-app` is a Railway app; `-www` is a Cloudflare
Worker/R2 static site — Vobo is an app, so `-app`.

## Bringing up a new environment

**Clone an existing one — do not build it service by service.** A service created with
`serviceCreate(environmentId: X)` materializes its instance *only* in X. Every attempt to deploy,
domain, or connect it in another environment returns `ServiceInstance not found`, and there is no
`serviceInstanceCreate` mutation. `environmentCreate(sourceEnvironmentId)` is the only path that
propagates services.

```graphql
environmentCreate(input: {
  projectId: "…", name: "production",
  sourceEnvironmentId: "<staging env id>", skipInitialDeploys: true
})
```

Then, in order:

1. **Repoint the cloned deployment triggers.** The clone copies the *source* environment's branch —
   a fresh production env will be sitting on `staging` until you `deploymentTriggerUpdate` it.
2. **Re-attach a volume to Postgres.** ⚠️ The clone carries the volume *record* but mounts it at
   `/tmp`, so Postgres refuses to start ("Railway volume not mounted to the correct path"). Create a
   new volume for the postgres service at `/var/lib/postgresql/data`.
3. **Rotate the cloned secrets.** `POSTGRES_PASSWORD`, `AUTH_SECRET` and `BETTER_AUTH_SECRET` come
   over verbatim from the source environment. Change the DB password *before* the first Postgres
   boot — the image initialises the cluster with whatever it sees then.
4. **Set `POSTGRES_URL`** on web and worker to the Postgres service's actual
   `RAILWAY_PRIVATE_DOMAIN` (`postgres-<suffix>.railway.internal`, **not** `postgres.railway.internal`
   — the suffix is stable per service and guessing it cost a boot crash with `28P01`).
5. **Deploy Postgres first, then web and worker.** Deploying all three at once makes the app race the
   database and fail with `CONNECT_TIMEOUT`; a redeploy fixes it, but the ordering avoids the noise.
6. **Domains**: `serviceDomainCreate` for the Railway URL, `customDomainCreate` for the real one,
   then the CNAME in Cloudflare with **proxy off**. Set `BETTER_AUTH_URL` to the custom domain and
   redeploy, or sign-in redirects land on the wrong host.
7. **Seed** (first time only). The DB is private, so use its TCP proxy:
   ```bash
   POSTGRES_URL="postgres://postgres:<pw>@<proxy-host>:<port>/railway" npx tsx lib/db/seed.ts
   ```
   It prints the admin password and API key **once** → `~/.claude/secrets/vobo.env`.

Migrations need no step of their own: `npm run boot` replays the drizzle journal
(`scripts/migrate.mjs`, production deps only) before `next start`, so every deploy is
schema-correct.

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

## Other traps met in the field

- **Railway blocks builds on dependency CVEs.** `next@15.6.0-canary.59` (GHSA-5j59-xgg2-r9c4) failed
  the build outright. Bump, don't argue.
- **`railway add -d postgres` still prompts** and cannot be driven headlessly; it leaves half-created
  services behind. Use the GraphQL API (`serviceCreate` with the
  `ghcr.io/railwayapp-templates/postgres-ssl:16` image) instead.
- **A second service whose name collides** (`Postgres` vs `postgres`) takes the clean private domain
  and silently steals connections from the one you meant.

## Not on Railway

Nothing else. No Vercel, no Coolify, no GCP. Artifact storage is BYO (S3 or the local `.storage/`
fs driver) — for the PICO loop it points at `s3://pico-abm-research-699619102971/vobo/`.
