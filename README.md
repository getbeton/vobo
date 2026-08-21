# Vobo

Human review station for AI pipeline output.

The name comes from *visto bueno* (V°B°) — the Latin-American sign-off “seen-good”. A pipeline submits an artifact. A person reviews it against a rubric and anchors corrections on exact spans. The station emits a signed decision event. Regenerations land on the same open review as new versions. Vobo never owns the pipeline and never regenerates the artifact.

[vobo.dev](https://vobo.dev/?utm_source=github&utm_medium=readme&utm_campaign=repo) · [Docs](https://vobo.dev/docs) · [X](https://x.com/voboreview) · [LinkedIn](https://linkedin.com/company/voboreview)

## What it does

- **Hold point.** Output does not ship until a human accepts it.
- **Anchored corrections.** Comments stick to a span, a cell, or a region. They survive rewrites.
- **The loop is the object.** Versions stack on one review. Prior findings re-classify as resolved, persisting, or orphaned.
- **Signed events.** Every state change appends to a hash chain. Acceptance seals the content hash, so what shipped is what was approved.
- **Policy on the queue.** Ranking, round budget, and advancement live on the queue. Reviewers only judge.
- **Three ways in, one contract.** HTTP API, MCP, and webhooks. A terminal agent pulls; it keeps no local state.

Markdown is the modality that ships today. Code, table, and image are designed, not built.

## The loop

```
create review ──▶ [open] ──claim──▶ [claimed] ──verdict──▶ accepted
                                                        ├─▶ rejected  (awaiting version)
                                                        └─▶ escalated
       ▲                                                     │
       └───────────────── submit version ────────────────────┘
```

`create review` is an idempotent upsert on the caller’s request id. `submit version` never creates a request. `accepted` is terminal: do not regenerate it.

## Get started

### Hosted

Use the hosted station and read the product on [vobo.dev](https://vobo.dev/?utm_source=github&utm_medium=readme&utm_campaign=repo&utm_content=get-started). The app is at [app.vobo.dev](https://app.vobo.dev). Setup is in the [docs](https://vobo.dev/docs).

### Run it locally

You need Node.js 22+, [pnpm](https://pnpm.io), and Postgres.

```bash
git clone https://github.com/getbeton/vobo.git
cd vobo
pnpm install
cp .env.example .env
```

Set `AUTH_SECRET` (`openssl rand -base64 32`) and `POSTGRES_URL`. Then:

```bash
pnpm db:migrate
pnpm db:seed          # prints the admin password and API key once
pnpm dev              # http://localhost:3000
pnpm worker           # webhooks, lease expiry, SLA sweep — second process
```

`pnpm db:seed` writes one workspace, the default queue, and one project-scoped API key. Store the key. It is not shown again.

Without `RESEND_API_KEY`, magic links print to the server log. That is enough for local work.

Production topology, Railway, and DNS live in [`DEPLOY.md`](./DEPLOY.md).

## Connect a pipeline

Same contract on every path. Ids belong to the caller and must be deterministic.

| Path | Use when |
|---|---|
| **HTTP** `Bearer` on `/api/v1/reviews`, `/versions`, `/corrections`, `/review`, `/cursor` | Any pipeline |
| **MCP** `request_review`, `submit_version`, `list_reviews`, `get_review`, `get_corrections`, `get_cursor`, `set_cursor` | An agent in a terminal. Full-loop parity with HTTP |
| **Webhooks** Standard Webhooks signing, retry 10s / 60s / 180s, then DLQ | You have a server that can receive events |

A consumer with no server **pulls**. `changed_since` takes an event-id cursor that Vobo stores per API key. `awaiting_version` is the regeneration work list. Two copies of the same agent cannot drift: there is no local cursor.

Point the MCP server at an instance:

```bash
export VOBO_API_URL=http://localhost:3000
export VOBO_API_KEY=vobo_sk_…
pnpm mcp
```

`mcp/run.sh` sources credentials from `~/.claude/secrets/vobo.env` so keys never land in `.mcp.json`.

## Documentation

- Product and API: [vobo.dev/docs](https://vobo.dev/docs)
- What this repo actually ships: [`docs/vobo-mvp.md`](./docs/vobo-mvp.md)
- UI is a verbatim port of [`design/vobo-review-station.dc.html`](./design/vobo-review-station.dc.html). Read [`design/README.md`](./design/README.md) before you change a screen.

## Community

| Channel | Best for |
|---|---|
| [vobo.dev/docs](https://vobo.dev/docs) | How to use the station |
| [GitHub Issues](https://github.com/getbeton/vobo/issues) | Bugs and errors in this repo |
| [X](https://x.com/voboreview) | Product notes |
| [LinkedIn](https://linkedin.com/company/voboreview) | Company notes |

## Contributing

Open a pull request against `staging`. Run `pnpm test` first. The dogfood gate is `tests/integration/dogfood-e2e.test.ts` (the PICO loop over MCP against real routes and Postgres).

Do not invent UI. The prototype in `design/` is the spec.

## License

This repository is under the license in [`LICENSE`](./LICENSE).

VOBO Oversees Bullshit Output
