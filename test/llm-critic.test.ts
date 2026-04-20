import { describe, expect, it, vi } from 'vitest';

import { runLlmCritic } from '../src/critic/index.js';
import { __internal } from '../src/critic/llm-critic.js';
import type { LlmCriticConfig, LlmCriticInput, ModelPricing } from '../src/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const { extractVerdict, estimateCostUsd, selectTemplate } = __internal;

function makeInput(overrides: Partial<LlmCriticInput> = {}): LlmCriticInput {
  return {
    response: 'Here is a reasonable answer to your question.',
    userPrompt: 'Please answer briefly.',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<LlmCriticConfig> = {}): LlmCriticConfig {
  return {
    baseUrl: 'http://critic.test/v1',
    model: 'test-critic-model',
    ...overrides,
  };
}

/**
 * Build a mocked fetch implementation that returns a chat/completions-
 * shaped JSON body with the given assistant content.
 */
function mockFetchReturning(content: string, status = 200): typeof fetch {
  return vi.fn(async () => {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
      }),
      {
        status,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as unknown as typeof fetch;
}

function mockFetchRejecting(error: Error): typeof fetch {
  return vi.fn(async () => {
    throw error;
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Verdict extraction — direct unit tests on __internal
// ---------------------------------------------------------------------------

describe('extractVerdict', () => {
  it('parses a plain JSON object response', () => {
    const verdict = extractVerdict('{"verdict":"pass","confidence":0.8,"reason":"looks fine"}');
    expect(verdict).toEqual({ verdict: 'pass', confidence: 0.8, reason: 'looks fine' });
  });

  it('parses a JSON object inside a ```json fence', () => {
    const content =
      'Here is my verdict:\n```json\n{"verdict":"fail","confidence":0.9,"reason":"refusal"}\n```';
    const verdict = extractVerdict(content);
    expect(verdict).toEqual({ verdict: 'fail', confidence: 0.9, reason: 'refusal' });
  });

  it('parses a JSON object surrounded by prose (bracket extraction)', () => {
    const content =
      'I have reviewed the response. My verdict: {"verdict":"pass","confidence":0.75,"reason":"adequate"}. Let me know if you need more.';
    const verdict = extractVerdict(content);
    expect(verdict).toEqual({ verdict: 'pass', confidence: 0.75, reason: 'adequate' });
  });

  it('prefers the fence contents over a bracketed substring when the fence is valid', () => {
    const content =
      '```json\n{"verdict":"fail","confidence":0.6,"reason":"short"}\n```\nNote: {invalid json}';
    const verdict = extractVerdict(content);
    expect(verdict?.verdict).toBe('fail');
  });

  it('falls back to bracket extraction when the fence content is malformed', () => {
    const content =
      '```json\n{broken json here}\n```\n{"verdict":"pass","confidence":0.5,"reason":"ok"}';
    const verdict = extractVerdict(content);
    expect(verdict?.verdict).toBe('pass');
  });

  it('returns null when no valid JSON is present', () => {
    expect(extractVerdict('This is just prose with no JSON object.')).toBeNull();
  });

  it('returns null when the JSON is valid but shape is wrong', () => {
    expect(extractVerdict('{"not_a_verdict":true}')).toBeNull();
    expect(extractVerdict('{"verdict":"maybe","confidence":0.5,"reason":"x"}')).toBeNull();
    expect(extractVerdict('{"verdict":"pass","confidence":"high","reason":"x"}')).toBeNull();
  });

  it('clamps confidence values outside [0, 1]', () => {
    expect(extractVerdict('{"verdict":"pass","confidence":1.5,"reason":"ok"}')?.confidence).toBe(1);
    expect(extractVerdict('{"verdict":"pass","confidence":-0.3,"reason":"ok"}')?.confidence).toBe(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// Template selection
// ---------------------------------------------------------------------------

describe('selectTemplate', () => {
  it('returns the English template by default', () => {
    expect(selectTemplate(undefined).system).toContain('adequacy critic');
  });

  it('returns the German template for locale=de', () => {
    expect(selectTemplate('de').system).toContain('Adäquanz-Kritiker');
  });

  it('falls back to English for unknown locales', () => {
    expect(selectTemplate('fr').system).toContain('adequacy critic');
  });
});

// ---------------------------------------------------------------------------
// Budget estimation
// ---------------------------------------------------------------------------

describe('estimateCostUsd', () => {
  const pricing: ModelPricing = {
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 4,
  };

  it('scales linearly with prompt length', () => {
    const cheap = estimateCostUsd(400, pricing);
    const pricy = estimateCostUsd(4000, pricing);
    expect(pricy).toBeGreaterThan(cheap);
  });

  it('produces a realistic order of magnitude for a typical critic prompt', () => {
    // A ~1200-char prompt with $1/$4 per MTok should cost well under a cent.
    const cost = estimateCostUsd(1200, pricing);
    expect(cost).toBeLessThan(0.01);
    expect(cost).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// runLlmCritic — end-to-end with injected fetch
// ---------------------------------------------------------------------------

describe('runLlmCritic', () => {
  it('returns a verdict when the critic responds with a valid JSON body', async () => {
    const fetchImpl = mockFetchReturning(
      '{"verdict":"pass","confidence":0.85,"reason":"adequate"}',
    );
    const result = await runLlmCritic(makeInput(), makeConfig({ fetchImpl }));
    expect(result.kind).toBe('verdict');
    if (result.kind === 'verdict') {
      expect(result.verdict.verdict).toBe('pass');
      expect(result.verdict.confidence).toBeCloseTo(0.85, 2);
    }
  });

  it('returns a verdict when the critic wraps JSON in a code fence', async () => {
    const fetchImpl = mockFetchReturning(
      '```json\n{"verdict":"fail","confidence":0.7,"reason":"refusal"}\n```',
    );
    const result = await runLlmCritic(makeInput(), makeConfig({ fetchImpl }));
    expect(result.kind).toBe('verdict');
    if (result.kind === 'verdict') {
      expect(result.verdict.verdict).toBe('fail');
    }
  });

  it('returns parse_failure when the critic emits malformed JSON', async () => {
    const fetchImpl = mockFetchReturning('I could not produce a JSON verdict.');
    const result = await runLlmCritic(makeInput(), makeConfig({ fetchImpl }));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('parse_failure');
    }
  });

  it('returns http error on non-2xx response', async () => {
    const fetchImpl = mockFetchReturning('server error detail', 500);
    const result = await runLlmCritic(makeInput(), makeConfig({ fetchImpl }));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('http');
    }
  });

  it('returns empty error when the response has no message content', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: {} }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const result = await runLlmCritic(makeInput(), makeConfig({ fetchImpl }));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('empty');
    }
  });

  it('returns network error when fetch itself throws', async () => {
    const fetchImpl = mockFetchRejecting(new Error('ECONNREFUSED'));
    const result = await runLlmCritic(makeInput(), makeConfig({ fetchImpl }));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('network');
    }
  });

  it('returns timeout when fetch is aborted', async () => {
    const abortErr = new Error('The user aborted a request.');
    abortErr.name = 'AbortError';
    const fetchImpl = mockFetchRejecting(abortErr);
    const result = await runLlmCritic(makeInput(), makeConfig({ fetchImpl }));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('timeout');
    }
  });

  it('skips when the pre-call budget check would exceed budgetUsd', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await runLlmCritic(
      makeInput({
        // Long prompt → higher estimated cost.
        userPrompt: 'x'.repeat(10_000),
        response: 'y'.repeat(10_000),
      }),
      makeConfig({
        fetchImpl,
        budgetUsd: 0.000001,
        pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 40 },
      }),
    );
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') {
      expect(result.reason).toBe('over_budget');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runs when budget is configured but the estimated cost is under budgetUsd', async () => {
    const fetchImpl = mockFetchReturning('{"verdict":"pass","confidence":0.9,"reason":"ok"}');
    const result = await runLlmCritic(
      makeInput(),
      makeConfig({
        fetchImpl,
        budgetUsd: 1.0,
        pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 4 },
      }),
    );
    expect(result.kind).toBe('verdict');
  });

  it('sends the German prompt template when locale=de', async () => {
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      // Shape: { messages: [{role:'system',content:...}, {role:'user',content:...}] }
      const systemContent = body.messages[0].content as string;
      expect(systemContent).toContain('Adäquanz-Kritiker');
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"verdict":"pass","confidence":0.8,"reason":"ok"}' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await runLlmCritic(makeInput({ locale: 'de' }), makeConfig({ fetchImpl }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends an Authorization header when apiKey is configured', async () => {
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer secret-token');
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"verdict":"pass","confidence":0.8,"reason":"ok"}' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await runLlmCritic(makeInput(), makeConfig({ fetchImpl, apiKey: 'secret-token' }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
