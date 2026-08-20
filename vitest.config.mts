import { defineConfig } from 'vitest/config';
import path from 'path';

const alias = { '@': path.resolve(__dirname, '.') };

/**
 * Two projects, because the two suites need different environments and must not
 * fight over the default.
 *
 * - `integration` runs in node against a real Postgres. It is the whole
 *   existing suite and its environment must not change.
 * - `component` runs in jsdom for React components. It loads no database
 *   setup file, so it starts fast and needs no server.
 */
export default defineConfig({
  test: {
    // Root-level, because the integration suite truncates the whole database
    // between files. Two files in flight at once would race each other, and
    // the per-project flag does not stop files in a DIFFERENT project running
    // alongside them.
    fileParallelism: false,
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['lib/**/__tests__/**/*.test.ts', 'tests/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['tests/integration/env-setup.ts'],
          fileParallelism: false,
          testTimeout: 20000,
        },
      },
      {
        resolve: { alias },
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'component',
          include: ['components/**/__tests__/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['tests/component/setup.ts'],
        },
      },
    ],
  },
});
