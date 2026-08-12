import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Runs before any test module import touches lib/db/drizzle.ts.
process.env.POSTGRES_URL =
  process.env.TEST_POSTGRES_URL ?? 'postgres://localhost:5432/vobo_test';
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? 'test-secret';
process.env.STORAGE_FS_DIR = mkdtempSync(path.join(tmpdir(), 'vobo-storage-'));
