import { describe, it } from 'vitest';

describe('critic: hard-signals', () => {
  it.todo('flags English refusal patterns (issue #3)');
  it.todo('flags locale-variant refusal patterns (issue #3)');
  it.todo('flags finish_reason: "length" without natural close (issue #3)');
  it.todo('flags repetition loops above threshold (issue #3)');
  it.todo('flags empty / suspiciously short outputs on non-trivial queries (issue #3)');
  it.todo('flags syntax errors only when the request was code-related (issue #3)');
  it.todo('does NOT flag otherwise-adequate answers (issue #3)');
});
