import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['lib/**/__tests__/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/integration/env-setup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
