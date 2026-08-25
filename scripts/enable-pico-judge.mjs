// Turn the built-in judge on for pico-cold-email. The BYO key is read from
// VOBO_JUDGE_OPENAI_API_KEY at run time and is never stored in policy.
import postgres from 'postgres';

const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('POSTGRES_URL is not set');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });
const keyEnv = process.env.VOBO_JUDGE_KEY_ENV ?? 'VOBO_JUDGE_OPENAI_API_KEY';
const model = process.env.VOBO_JUDGE_MODEL ?? 'gpt-4o-mini';

try {
  const queues = await sql`
    select q.id, q.slug, q.environment, q.policy_overrides, q.active_policy_version_id
    from queues q
    join projects p on p.id = q.project_id
    where p.slug = 'pico' and q.slug = 'pico-cold-email'
  `;
  if (queues.length === 0) {
    console.error('pico-cold-email queue not found');
    process.exit(1);
  }
  for (const q of queues) {
    const overrides = {
      ...(q.policy_overrides ?? {}),
      judgeEnabled: true,
      judgeSamplingPct: 100,
      judgeBlindSamplingPct: 0,
      judgeModelId: model,
      judgeKeyEnv: keyEnv,
      piiDetection: true,
    };
    await sql`update queues set policy_overrides = ${sql.json(overrides)} where id = ${q.id}`;
    const [latest] = await sql`
      select version, config from policy_versions
      where queue_id = ${q.id}
      order by version desc limit 1
    `;
    const next = (latest?.version ?? 0) + 1;
    const config = { ...(latest?.config ?? {}), ...overrides };
    const [row] = await sql`
      insert into policy_versions (queue_id, version, config)
      values (${q.id}, ${next}, ${sql.json(config)})
      returning id, version
    `;
    await sql`update queues set active_policy_version_id = ${row.id} where id = ${q.id}`;
    console.log(`pico-cold-email/${q.environment} → policy v${row.version} judge on, model ${model}`);
  }
} finally {
  await sql.end();
}
