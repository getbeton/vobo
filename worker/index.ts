import { db, client } from '@/lib/db/drizzle';
import { dispatchDue } from '@/lib/core/webhooks';
import { expireLeases, applySlaTimeouts } from '@/lib/core/queue';

/**
 * The Vobo worker: webhook delivery (10s/60s/180s ladder, DLQ), lease-expiry
 * sweep, SLA-timeout sweep. All state in Postgres — restart-safe by
 * construction (topology decision 1A; runs as its own Railway service).
 */

const DELIVERY_INTERVAL_MS = 5_000;
const SWEEP_INTERVAL_MS = 60_000;

let stopping = false;

async function deliveryLoop() {
  while (!stopping) {
    try {
      const sent = await dispatchDue(db);
      if (sent > 0) console.log(`[worker] delivered ${sent} webhook(s)`);
    } catch (err) {
      console.error('[worker] delivery loop error:', err);
    }
    await sleep(DELIVERY_INTERVAL_MS);
  }
}

async function sweepLoop() {
  while (!stopping) {
    try {
      const expired = await expireLeases(db);
      if (expired > 0) console.log(`[worker] expired ${expired} lease(s)`);
      const timedOut = await applySlaTimeouts(db);
      if (timedOut > 0) console.log(`[worker] applied ${timedOut} SLA timeout(s)`);
    } catch (err) {
      console.error('[worker] sweep loop error:', err);
    }
    await sleep(SWEEP_INTERVAL_MS);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('[worker] vobo worker starting');
  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });
  await Promise.all([deliveryLoop(), sweepLoop()]);
  await client.end();
  console.log('[worker] stopped');
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
