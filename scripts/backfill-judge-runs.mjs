// Enqueue a pending judge run for every version that has none. Safe to re-run.
import postgres from 'postgres';

const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('POSTGRES_URL is not set');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
try {
  const inserted = await sql`
    insert into judge_runs (request_id, version_id, policy_version_id, state)
    select r.id, v.id, r.policy_version_id, 'pending'
    from artifact_versions v
    join review_requests r on r.id = v.request_id
    join queues q on q.id = r.queue_id
    join policy_versions pv on pv.id = r.policy_version_id
    where r.archived_at is null
      and r.status in ('open', 'claimed', 'rejected')
      and coalesce((pv.config->>'judgeEnabled')::boolean, false) = true
      and not exists (select 1 from judge_runs jr where jr.version_id = v.id)
    returning id
  `;
  console.log(`enqueued ${inserted.length} judge run(s)`);
} finally {
  await sql.end();
}
