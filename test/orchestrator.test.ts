import { describe, expect, it, vi } from 'vitest';

import { aggregateSignals, runOrchestrator } from '../src/critic/index.js';
import { __internal } from '../src/critic/orchestrator.js';
import type {
  LlmCritic,
  LlmCriticConfig,
  OrchestratorConfig,
  Signal,
  SignalCategory,
  SignalWeights,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const { aggregateInGreyBand, clamp01 } = __internal;

const DEFAULT_WEIGHTS: SignalWeights = {
  refusal: 1,
  truncation: 1,
  repetition: 1,
  empty: 1,
  tool_error: 1,
  syntax_error: 1,
};

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    threshold: 0.6,
    weights: DEFAULT_WEIGHTS,
    greyBand: [0.3, 0.6] as const,
    ...overrides,
  };
}

function signal(category: SignalCategory, confidence: number, reason = 'test'): Signal {
  return { category, confidence, reason };
}

/** Build a minimal LLM-critic stub returning a fixed result. Returns a
 * concrete (non-undefined) object so it can always be spread into an
 * OrchestratorConfig under exactOptionalPropertyTypes. */
function stubCritic(result: Awaited<ReturnType<LlmCritic>>): {
  readonly run: LlmCritic;
  readonly config: LlmCriticConfig;
} {
  const run: LlmCritic = vi.fn(async () => result) as unknown as LlmCritic;
  const config: LlmCriticConfig = {
    baseUrl: 'http://critic.test/v1',
    model: 'test',
  };
  return { run, config };
}

// ---------------------------------------------------------------------------
// clamp01
// ---------------------------------------------------------------------------

describe('clamp01', () => {
  it('clamps values below 0', () => {
    expect(clamp01(-0.5)).toBe(0);
  });
  it('clamps values above 1', () => {
    expect(clamp01(1.5)).toBe(1);
  });
  it('passes through in-range values', () => {
    expect(clamp01(0.42)).toBeCloseTo(0.42, 5);
  });
  it('maps NaN to 0', () => {
    expect(clamp01(Number.NaN)).toBe(0);
  });
  it('maps Infinity to 0', () => {
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// aggregateSignals — noisy-OR combiner
// ---------------------------------------------------------------------------

describe('aggregateSignals', () => {
  it('returns 0 when there are no signals', () => {
    expect(aggregateSignals([], DEFAULT_WEIGHTS)).toBe(0);
  });

  it('matches confidence when a single signal fires at weight 1', () => {
    expect(aggregateSignals([signal('refusal', 0.8)], DEFAULT_WEIGHTS)).toBeCloseTo(0.8, 5);
  });

  it('scales confidence by weight', () => {
    const weights: SignalWeights = { ...DEFAULT_WEIGHTS, refusal: 0.5 };
    // noisy-OR with a single signal at w*c = 0.4 → aggregate = 0.4.
    expect(aggregateSignals([signal('refusal', 0.8)], weights)).toBeCloseTo(0.4, 5);
  });

  it('produces an aggregate strictly greater than each individual signal', () => {
    const signals = [signal('refusal', 0.4), signal('truncation', 0.4), signal('repetition', 0.4)];
    const agg = aggregateSignals(signals, DEFAULT_WEIGHTS);
    // 1 - (1-0.4)^3 = 1 - 0.216 = 0.784
    expect(agg).toBeCloseTo(0.784, 3);
    expect(agg).toBeGreaterThan(0.4);
  });

  it('disables a category when its weight is 0', () => {
    const weights: SignalWeights = { ...DEFAULT_WEIGHTS, refusal: 0 };
    const signals = [signal('refusal', 0.95), signal('empty', 0.4)];
    // Only the empty signal contributes at weight 1.
    expect(aggregateSignals(signals, weights)).toBeCloseTo(0.4, 5);
  });

  it('clamps out-of-range confidences and weights', () => {
    // Confidence 1.5 clamps to 1, weight 1 clamps to 1 → product factor 0.
    // Aggregate = 1 - 0 = 1.
    expect(aggregateSignals([signal('refusal', 1.5)], DEFAULT_WEIGHTS)).toBe(1);
  });

  it('stays within [0, 1] for many concurrent signals at high confidence', () => {
    const signals: Signal[] = [
      signal('refusal', 0.95),
      signal('truncation', 0.9),
      signal('repetition', 0.8),
      signal('empty', 0.9),
      signal('tool_error', 0.95),
      signal('syntax_error', 0.85),
    ];
    const agg = aggregateSignals(signals, DEFAULT_WEIGHTS);
    expect(agg).toBeGreaterThanOrEqual(0);
    expect(agg).toBeLessThanOrEqual(1);
    // Six high-confidence signals should drive the aggregate very close to 1.
    expect(agg).toBeGreaterThan(0.99);
  });
});

// ---------------------------------------------------------------------------
// aggregateInGreyBand
// ---------------------------------------------------------------------------

describe('aggregateInGreyBand', () => {
  it('returns true at the lower bound', () => {
    expect(aggregateInGreyBand(0.3, [0.3, 0.6])).toBe(true);
  });
  it('returns false at the upper bound (exclusive)', () => {
    expect(aggregateInGreyBand(0.6, [0.3, 0.6])).toBe(false);
  });
  it('returns false below the band', () => {
    expect(aggregateInGreyBand(0.29, [0.3, 0.6])).toBe(false);
  });
  it('returns false above the band', () => {
    expect(aggregateInGreyBand(0.9, [0.3, 0.6])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runOrchestrator — end-to-end
// ---------------------------------------------------------------------------

describe('runOrchestrator', () => {
  it('passes on a clean response below the grey band, without invoking the critic', async () => {
    const critic = stubCritic({
      kind: 'verdict',
      verdict: { verdict: 'fail', confidence: 0.9, reason: 'unexpected' },
    });
    const decision = await runOrchestrator(
      {
        response: 'Here is a perfectly reasonable and helpful answer to your question.',
        userPrompt: 'What time is it?',
      },
      makeConfig({ llmCritic: critic }),
    );
    expect(decision.kind).toBe('pass');
    expect(critic.run).not.toHaveBeenCalled();
  });

  it('escalates on hard-signal evidence without invoking the critic', async () => {
    const critic = stubCritic({
      kind: 'verdict',
      verdict: { verdict: 'pass', confidence: 0.9, reason: 'looks ok' },
    });
    // Explicit refusal text drives the refusal detector above 0.9; the
    // aggregate exceeds the default 0.6 threshold on hard signals alone.
    const decision = await runOrchestrator(
      {
        response: "I'm sorry, but I cannot help with that request.",
        userPrompt: 'Please explain how to do it.',
      },
      makeConfig({ llmCritic: critic }),
    );
    expect(decision.kind).toBe('escalate');
    if (decision.kind === 'escalate') {
      expect(decision.reason).toBe('hard_signals');
      expect(decision.signals.some((s) => s.category === 'refusal')).toBe(true);
    }
    expect(critic.run).not.toHaveBeenCalled();
  });

  it('invokes the critic when the aggregate lands in the grey band', async () => {
    const critic = stubCritic({
      kind: 'verdict',
      verdict: { verdict: 'fail', confidence: 0.8, reason: 'too short' },
    });
    // A single mid-confidence hedge fires one 0.4 refusal signal.
    // Noisy-OR with a single 0.4 signal → aggregate 0.4, inside [0.3, 0.6).
    const decision = await runOrchestrator(
      {
        response: 'I would advise caution when interpreting these numbers because data is thin.',
        userPrompt: 'Is the trend positive?',
      },
      makeConfig({ llmCritic: critic }),
    );
    expect(critic.run).toHaveBeenCalledTimes(1);
    expect(decision.kind).toBe('escalate');
    if (decision.kind === 'escalate') {
      expect(decision.reason).toBe('llm_verdict');
      expect(decision.verdict?.verdict).toBe('fail');
    }
  });

  it('passes with the verdict attached when the critic says pass in the grey band', async () => {
    const critic = stubCritic({
      kind: 'verdict',
      verdict: { verdict: 'pass', confidence: 0.9, reason: 'adequate' },
    });
    const decision = await runOrchestrator(
      {
        response: 'I would advise caution when interpreting these numbers because data is thin.',
        userPrompt: 'Is the trend positive?',
      },
      makeConfig({ llmCritic: critic }),
    );
    expect(decision.kind).toBe('pass');
    if (decision.kind === 'pass') {
      expect(decision.verdict?.verdict).toBe('pass');
    }
  });

  it('passes when the critic fail verdict has low confidence (below threshold)', async () => {
    const critic = stubCritic({
      kind: 'verdict',
      verdict: { verdict: 'fail', confidence: 0.3, reason: 'uncertain' },
    });
    const decision = await runOrchestrator(
      {
        response: 'I would advise caution when interpreting these numbers because data is thin.',
        userPrompt: 'Is the trend positive?',
      },
      makeConfig({ llmCritic: critic }),
    );
    expect(decision.kind).toBe('pass');
  });

  it('passes without a verdict when the critic is skipped (budget exceeded)', async () => {
    const critic = stubCritic({ kind: 'skipped', reason: 'over_budget' });
    const decision = await runOrchestrator(
      {
        response: 'I would advise caution when interpreting these numbers because data is thin.',
        userPrompt: 'Is the trend positive?',
      },
      makeConfig({ llmCritic: critic }),
    );
    expect(decision.kind).toBe('pass');
    if (decision.kind === 'pass') {
      expect(decision.verdict).toBeUndefined();
    }
  });

  it('passes without a verdict when the critic errors out', async () => {
    const critic = stubCritic({ kind: 'error', reason: 'network', detail: 'connection refused' });
    const decision = await runOrchestrator(
      {
        response: 'I would advise caution when interpreting these numbers because data is thin.',
        userPrompt: 'Is the trend positive?',
      },
      makeConfig({ llmCritic: critic }),
    );
    expect(decision.kind).toBe('pass');
    if (decision.kind === 'pass') {
      expect(decision.verdict).toBeUndefined();
    }
  });

  it('does not invoke the critic outside the grey band even when configured', async () => {
    const critic = stubCritic({
      kind: 'verdict',
      verdict: { verdict: 'fail', confidence: 0.9, reason: 'x' },
    });
    // Clean response → aggregate well below the lower grey bound.
    await runOrchestrator(
      {
        response: 'This is a clear, complete, helpful answer with specifics and context.',
        userPrompt: 'Explain that briefly.',
      },
      makeConfig({ llmCritic: critic }),
    );
    expect(critic.run).not.toHaveBeenCalled();
  });

  it('forwards finishReason and locale to the hard-signal detectors', async () => {
    // finish_reason: 'length' without a natural terminator fires the
    // truncation detector at 0.9 → well above the default threshold.
    const decision = await runOrchestrator(
      {
        response: 'The answer ends mid-thou',
        userPrompt: 'Explain.',
        finishReason: 'length',
      },
      makeConfig(),
    );
    expect(decision.kind).toBe('escalate');
    if (decision.kind === 'escalate') {
      expect(decision.signals.some((s) => s.category === 'truncation')).toBe(true);
    }
  });
});
