import { describe, it } from 'vitest';

describe('critic: llm-critic', () => {
  it.todo('returns a verdict of "pass" | "fail" with reason and confidence (issue #4)');
  it.todo('refuses to be prompted into rewriting the answer (issue #4)');
  it.todo('falls back to hard-signal-only when critic_budget_usd is exceeded (issue #4)');
  it.todo('works with a swappable OpenAI-compatible model endpoint (issue #4)');
});
