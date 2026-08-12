// Runtime migration step, run at container boot before the web/worker process
// starts. Uses drizzle-orm's journal replay (a production dependency) rather
// than drizzle-kit, so it works in an image without dev dependencies.
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] POSTGRES_URL is not set');
  process.exit(1);
}

const client = postgres(url, { max: 1 });
try {
  await migrate(drizzle(client), { migrationsFolder: 'lib/db/migrations' });
  console.log('[migrate] up to date');
} catch (err) {
  console.error('[migrate] failed:', err);
  process.exit(1);
} finally {
  await client.end();
}
