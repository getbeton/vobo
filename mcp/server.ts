#!/usr/bin/env npx tsx
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * Vobo MCP server — full-loop parity with the pull contract (ARD §9): an
 * agent must be able to run submit → poll → consume corrections → resubmit
 * entirely through MCP. Tools call the HTTP API; auth via env:
 *   VOBO_API_URL (e.g. https://vobo.example)   VOBO_API_KEY (vobo_sk_…)
 */

const API_URL = (process.env.VOBO_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const API_KEY = process.env.VOBO_API_KEY ?? '';

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function asResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: 'vobo', version: '0.1.0' });

server.tool(
  'request_review',
  'Submit an artifact for human review (first generation). Idempotent on request_id — a repeat call never duplicates. Fire-and-forget: poll with list_reviews/get_review for the verdict.',
  {
    queue: z.string().describe('Queue slug, e.g. pico-cold-email'),
    request_id: z
      .string()
      .describe('Customer-owned deterministic id, e.g. pico/<campaign>/<domain>/<contact>/<seq>'),
    title: z.string(),
    content_md: z.string().describe('The artifact as markdown'),
    prompt: z.string().optional().describe('Generation instructions the reviewer judges against'),
    source: z.string().optional().describe('Source/context dossier shown beside the artifact'),
    environment: z.enum(['production', 'test']).optional(),
    priority: z.number().int().min(1).max(5).optional(),
    pipeline_run_id: z.string().optional().describe('Groups multi-agent outputs of one run'),
    tags: z.array(z.string()).optional(),
  },
  async (args) => asResult(await api('POST', '/reviews', args))
);

server.tool(
  'submit_version',
  'Submit a regenerated version against the SAME request id (non-first generation). Only valid after a rejection; identical resubmissions are no-ops.',
  {
    request_id: z.string(),
    content_md: z.string(),
    responses: z
      .array(z.object({ annotation_id: z.string(), note: z.string() }))
      .optional()
      .describe('Optional per-finding responses, e.g. "needs clarification"'),
  },
  async (args) => asResult(await api('POST', '/versions', args))
);

server.tool(
  'list_reviews',
  'Pull work state. awaiting_version=true returns exactly the regeneration work list. changed_since takes an event-id cursor (see get_cursor); response includes max_event_id to advance it. Status is the only state of record: accepted is terminal — never regenerate an accepted request.',
  {
    queue: z.string().optional(),
    environment: z.enum(['production', 'test']).optional(),
    status: z.string().optional().describe('Comma-separated: open,claimed,rejected,accepted,escalated'),
    awaiting_version: z.boolean().optional(),
    changed_since: z.number().int().optional(),
  },
  async (args) => {
    const params = new URLSearchParams();
    if (args.queue) params.set('queue', args.queue);
    if (args.environment) params.set('environment', args.environment);
    if (args.status) params.set('status', args.status);
    if (args.awaiting_version) params.set('awaiting_version', 'true');
    if (args.changed_since !== undefined) params.set('changed_since', String(args.changed_since));
    return asResult(await api('GET', `/reviews?${params}`));
  }
);

server.tool(
  'get_review',
  'Full state of one request: status, round, versions, hash-chain verification, event timeline.',
  { request_id: z.string() },
  async (args) =>
    asResult(await api('GET', `/review?request_id=${encodeURIComponent(args.request_id)}`))
);

server.tool(
  'get_corrections',
  'Everything a regeneration needs for a rejected request: anchored corrections with Expected outcomes, criteria verdicts, round.',
  { request_id: z.string() },
  async (args) =>
    asResult(await api('GET', `/corrections?request_id=${encodeURIComponent(args.request_id)}`))
);

server.tool(
  'get_cursor',
  'Server-side pull cursor for this API key (consumers keep zero local state).',
  {},
  async () => asResult(await api('GET', '/cursor'))
);

server.tool(
  'set_cursor',
  'Advance the server-side cursor after processing a pull batch (use max_event_id from list_reviews).',
  { cursor_event_id: z.number().int().nonnegative() },
  async (args) => asResult(await api('PUT', '/cursor', args))
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[vobo-mcp] connected over stdio →', API_URL);
}

main().catch((err) => {
  console.error('[vobo-mcp] fatal:', err);
  process.exit(1);
});
