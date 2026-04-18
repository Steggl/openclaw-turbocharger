import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    // E2E tests (test/e2e/**) are opt-in; excluded from the default run so CI
    // doesn't accidentally require a live Ollama/Claude/OpenAI endpoint.
    exclude: ['node_modules/**', 'dist/**', 'test/e2e/**'],
  },
});
