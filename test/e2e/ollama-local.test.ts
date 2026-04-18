import { describe, it } from 'vitest';

// E2E — requires a live local Ollama endpoint. Run with:
//   pnpm vitest run test/e2e
// Not part of the default CI pipeline.

describe.skip('e2e: ollama-local', () => {
  it.todo('end-to-end escalation against a local ollama model (issue #5)');
});
