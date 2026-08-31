/**
 * PostHog instrumentation (VOBO-25). Deliberately thin:
 *
 * - Product analytics ride on the SAME domain events that already flow through
 *   appendEvent, so there is one choke point and no second, drifting taxonomy.
 * - It is a strict no-op unless POSTHOG_KEY is set. Vobo is self-hostable and
 *   AGPL; an open-source install must not phone home by default.
 * - Payloads are never forwarded verbatim. Reviewed content, comment bodies,
 *   prompts and quotes stay in the deployment — only counts, ids, and enum-ish
 *   fields leave.
 */

const ALLOWED_KEYS = new Set([
  'round',
  'kind',
  'mode',
  'count',
  'state',
  'confidence',
  'versionNumber',
  'humanAuthored',
  'reasonCode',
  'blocked',
  'environment',
  'created',
]);

let client: { capture: (args: Record<string, unknown>) => void; shutdown: () => Promise<void> } | null =
  null;
let loaded = false;

async function getClient() {
  if (loaded) return client;
  loaded = true;
  const key = process.env.POSTHOG_KEY ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  try {
    const { PostHog } = await import('posthog-node');
    client = new PostHog(key, {
      host:
        process.env.POSTHOG_HOST ??
        process.env.NEXT_PUBLIC_POSTHOG_HOST ??
        'https://us.i.posthog.com',
      flushAt: 20,
      flushInterval: 5_000,
    }) as unknown as typeof client;
  } catch (err) {
    console.warn('posthog disabled (client init failed):', err);
    client = null;
  }
  return client;
}

function scrub(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (typeof v === 'string' && v.length > 64) continue;
    out[k] = v;
  }
  return out;
}

/** Mirror one domain event. Never throws — analytics must not break a review. */
export async function captureDomainEvent(input: {
  type: string;
  requestId: string;
  distinctId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<void> {
  try {
    const ph = await getClient();
    if (!ph) return;
    ph.capture({
      distinctId: input.distinctId || `request:${input.requestId}`,
      event: input.type,
      properties: {
        request_id: input.requestId,
        ...scrub(input.payload ?? {}),
        $process_person_profile: Boolean(input.distinctId),
      },
    });
  } catch (err) {
    console.warn('posthog capture failed (non-fatal):', err);
  }
}

export async function shutdownAnalytics(): Promise<void> {
  if (client) await client.shutdown();
}
