import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ensureMigrated, truncateAll, createFixtures, db, Fixtures } from './harness';
import { claim } from '@/lib/core/queue';
import { addComment, setCriterionVerdict } from '@/lib/core/annotations';
import { ship } from '@/lib/core/verdict';
import { getVerifiedChain } from '@/lib/core/eventlog';

import * as reviewsRoute from '@/app/api/v1/reviews/route';
import * as versionsRoute from '@/app/api/v1/versions/route';
import * as correctionsRoute from '@/app/api/v1/corrections/route';
import * as reviewRoute from '@/app/api/v1/review/route';
import * as cursorRoute from '@/app/api/v1/cursor/route';

/**
 * VOBO-7 — the release gate. Drives the whole PICO dogfood loop over MCP:
 * request_review → (human rejects with anchored corrections) → get_corrections
 * → submit_version → get_review, against the real route handlers and a real
 * database. The MCP server is a stdio child process talking HTTP to a Node
 * server that dispatches into the Next route modules, so this exercises the
 * same path the terminal session uses in production — no mocks in the loop.
 */

const V1 = `## Email 1 — quick question about your review stack

Hi Dana, saw your team ships weekly.

We sincerely apologize for the interruption, but our 60-day goodwill window makes this the best tool you'll ever use.

Worth a look?`;

const V2 = V1.replace(
  "We sincerely apologize for the interruption, but our 60-day goodwill window makes this the best tool you'll ever use.",
  'We cut the interruption short: our 60-day goodwill window makes this the rare tool you evaluate in one afternoon.'
);

const REQUEST_ID = 'pico/ppp-launch/acme.com/dana-liu/seq-a';

const ROUTES: Record<string, { GET?: Function; POST?: Function; PUT?: Function }> = {
  '/api/v1/reviews': reviewsRoute,
  '/api/v1/versions': versionsRoute,
  '/api/v1/corrections': correctionsRoute,
  '/api/v1/review': reviewRoute,
  '/api/v1/cursor': cursorRoute,
};

let server: Server;
let baseUrl: string;
let mcp: Client;
let fx: Fixtures;

/** Minimal Node ↔ fetch bridge so the route handlers run unmodified. */
function startRouteServer(): Promise<string> {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const mod = ROUTES[url.pathname];
    const handler = mod?.[req.method as 'GET' | 'POST' | 'PUT'];
    if (!handler) {
      res.writeHead(404).end('{"error":"no_route"}');
      return;
    }
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const out: Response = await handler(request);
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(await out.text());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function callTool(name: string, args: Record<string, unknown>) {
  const res = await mcp.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0].text;
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

beforeAll(async () => {
  await ensureMigrated();
  await truncateAll();
  fx = await createFixtures({ roundBudget: 3, slaMinutes: null });
  baseUrl = await startRouteServer();

  mcp = new Client({ name: 'dogfood-test', version: '1.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'mcp/server.ts'],
      env: { ...process.env, VOBO_API_URL: baseUrl, VOBO_API_KEY: fx.apiToken },
    })
  );
}, 120_000);

afterAll(async () => {
  await mcp?.close();
  server?.close();
});

// The loop is one continuous story: no per-test truncation.
beforeEach(() => {});

describe('PICO dogfood loop over MCP', () => {
  it('exposes the full pull contract as tools', async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'get_corrections',
        'get_cursor',
        'get_review',
        'list_reviews',
        'request_review',
        'set_cursor',
        'submit_version',
      ].sort()
    );
  });

  it('request_review creates the request, and a retry is a no-op upsert', async () => {
    const first = await callTool('request_review', {
      queue: 'q',
      request_id: REQUEST_ID,
      title: 'Dana Liu — Acme — sequence A',
      content_md: V1,
      prompt: 'Voice: direct, no marketing tone. Subject <= 6 words. No signature.',
      source: 'Acme Corp — 40-person CRO. Dana Liu, Head of Evidence.',
      priority: 2,
      pipeline_run_id: 'pico/ppp-launch/acme.com',
      tags: ['campaign:ppp-launch', 'account:acme.com'],
    });
    expect(first.created).toBe(true);
    expect(first.status).toBe('open');

    // A crashed-and-retried session must not double-submit.
    const retry = await callTool('request_review', {
      queue: 'q',
      request_id: REQUEST_ID,
      title: 'Dana Liu — Acme — sequence A',
      content_md: V1,
    });
    expect(retry.created).toBe(false);
    expect(retry.id).toBe(first.id);
  });

  it('a human rejection with corrections turns up in get_corrections', async () => {
    const { reviews } = await callTool('list_reviews', { queue: 'q' });
    const dbId = reviews[0].id;

    await claim(db, dbId, fx.userId);
    await addComment(db, {
      requestId: dbId,
      userId: fx.userId,
      body: 'Apology opener plus a superlative — both banned by the voice rules.',
      expected: 'Open on the reader’s situation; no superlatives.',
      startPos: V1.indexOf('We sincerely'),
      endPos: V1.indexOf('ever use.') + 'ever use.'.length,
    });
    for (const id of fx.criterionIds) {
      await setCriterionVerdict(db, {
        requestId: dbId,
        criterionId: id,
        userId: fx.userId,
        verdict: 'fail',
      });
    }
    await ship(db, { requestId: dbId, userId: fx.userId, kind: 'reject_corrections' });

    const corrections = await callTool('get_corrections', { request_id: REQUEST_ID });
    expect(corrections.status).toBe('rejected');
    expect(corrections.corrections).toHaveLength(1);
    expect(corrections.corrections[0].expected).toContain('no superlatives');
    expect(corrections.criteria.every((c: { verdict: string }) => c.verdict === 'fail')).toBe(true);
  });

  it('list_reviews surfaces the request as awaiting_version — the sync partition key', async () => {
    const { reviews } = await callTool('list_reviews', { queue: 'q', awaiting_version: true });
    expect(reviews).toHaveLength(1);
    expect(reviews[0].request_id).toBe(REQUEST_ID);
    expect(reviews[0].awaiting_version).toBe(true);
  });

  it('submit_version advances the round and re-anchors the correction as resolved', async () => {
    const res = await callTool('submit_version', {
      request_id: REQUEST_ID,
      content_md: V2,
      author_label: 'claude-code',
    });
    expect(res.version).toBe(2);
    expect(res.created).toBe(true);
    expect(res.status).toBe('open');

    // The rewritten span must not come back as persisting — that is the whole
    // point of the re-anchoring engine, and it is what the consumer reads.
    expect(res.classifications).toMatchObject({ resolved: 1, persisting: 0, orphaned: 0 });

    const state = await callTool('get_review', { request_id: REQUEST_ID });
    expect(state.round).toBe(2);
    expect(state.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
    expect(state.chain.ok).toBe(true);

    // Nothing left to answer: the next sync pass regenerates nothing.
    const after = await callTool('get_corrections', { request_id: REQUEST_ID });
    expect(after.corrections).toHaveLength(0);
  });

  it('an identical resubmission is a no-op, not a third round', async () => {
    const again = await callTool('submit_version', {
      request_id: REQUEST_ID,
      content_md: V2,
      author_label: 'claude-code',
    });
    expect(again.version).toBe(2);
    expect(again.created).toBe(false);
    const state = await callTool('get_review', { request_id: REQUEST_ID });
    expect(state.round).toBe(2);
  });

  it('the cursor round-trips server-side, so the consumer keeps no local state', async () => {
    const { reviews, max_event_id } = await callTool('list_reviews', { queue: 'q' });
    expect(reviews).toHaveLength(1);
    await callTool('set_cursor', { cursor_event_id: max_event_id });
    expect((await callTool('get_cursor', {})).cursor_event_id).toBe(max_event_id);

    // Nothing has changed since, so the next sync sees an empty batch.
    const next = await callTool('list_reviews', { queue: 'q', changed_since: max_event_id });
    expect(next.reviews).toHaveLength(0);
  });

  it('the whole story is one verifiable hash chain', async () => {
    const { reviews } = await callTool('list_reviews', { queue: 'q' });
    const { rows, verification } = await getVerifiedChain(db, reviews[0].id);
    expect(verification.ok).toBe(true);
    expect(rows.map((r) => r.type)).toEqual([
      'request.created',
      'version.submitted',
      'request.claimed',
      'annotation.created',
      'decision.rejected',
      'version.submitted',
      'anchors.classified',
    ]);
  });
});
