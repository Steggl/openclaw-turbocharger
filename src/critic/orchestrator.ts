// Orchestrator: combines hard-signal evidence with an optional LLM-critic
// verdict into a single {@link OrchestratorDecision}. Pure function, no
// I/O of its own beyond invoking the caller-supplied LLM-critic.
//
// Scope (v0.1, issue #5):
//   - Runs every enabled hard-signal detector (ADR-0006 noisy-OR
//     aggregation with per-category weights).
//   - Invokes the LLM-critic when the noisy-OR aggregate lands in the
//     configurable grey band (ADR-0010, default [0.30, 0.60)).
//   - The LLM-critic verdict is compared against the escalation
//     threshold independently of the pool (ADR-0011). A fail verdict
//     with confidence >= threshold escalates; pass verdicts never do,
//     regardless of confidence; skipped/error results never escalate
//     (brief: no silent fallbacks — a missing verdict is not a pass).
//
// Intentionally NOT in this file:
//   - Actual escalation to a stronger model (issue #6, ladder/max).
//   - Chorus dispatch (issue #8, stub only in MVP).
//   - Streaming-body handling (ADR-0013: orchestrator is skipped for
//     streams; the pipeline decides that upstream of this function).

import { collectHardSignals } from './hard-signals.js';
import type {
  LlmVerdict,
  Orchestrator,
  OrchestratorConfig,
  OrchestratorDecision,
  OrchestratorInput,
  Signal,
  SignalCategory,
  SignalWeights,
} from '../types.js';

// ---------------------------------------------------------------------------
// Noisy-OR aggregation
// ---------------------------------------------------------------------------

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Aggregate signals via weighted noisy-OR:
 *   P(inadequate) = 1 - prod(1 - weight[cat] * confidence)
 * Returns a value in [0, 1]. Signals whose weight is 0 contribute
 * nothing (their category is effectively disabled).
 */
export function aggregateSignals(
  signals: readonly Signal[],
  weights: SignalWeights,
): number {
  let product = 1;
  for (const signal of signals) {
    const w = clamp01(weights[signal.category]);
    const c = clamp01(signal.confidence);
    product *= 1 - w * c;
  }
  return clamp01(1 - product);
}

// ---------------------------------------------------------------------------
// Verdict gating
// ---------------------------------------------------------------------------

/**
 * Return true iff the orchestrator should invoke the LLM-critic given
 * the hard-signal aggregate. Per ADR-0010 the critic runs only inside
 * the configured grey band `[lower, upper)`. Outside the band it is
 * either redundant (aggregate already escalates) or wasteful
 * (aggregate is confidently below threshold).
 */
function aggregateInGreyBand(
  aggregate: number,
  greyBand: readonly [number, number],
): boolean {
  const lower = greyBand[0];
  const upper = greyBand[1];
  return aggregate >= lower && aggregate < upper;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export const runOrchestrator: Orchestrator = async (
  input: OrchestratorInput,
  config: OrchestratorConfig,
): Promise<OrchestratorDecision> => {
  const detectorInput = {
    response: input.response,
    userPrompt: input.userPrompt,
    ...(input.finishReason !== undefined ? { finishReason: input.finishReason } : {}),
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
  };
  const signals = collectHardSignals(detectorInput);
  const aggregate = aggregateSignals(signals, config.weights);

  // Hard-signal track: escalate immediately when the pool crosses the
  // threshold. No need to invoke the LLM-critic — the evidence is already
  // sufficient.
  if (aggregate >= config.threshold) {
    return { kind: 'escalate', reason: 'hard_signals', signals, aggregate };
  }

  // LLM-critic track: only when configured AND aggregate lands in the
  // grey band.
  if (config.llmCritic !== undefined && aggregateInGreyBand(aggregate, config.greyBand)) {
    const result = await config.llmCritic.run(
      {
        response: input.response,
        userPrompt: input.userPrompt,
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
      },
      config.llmCritic.config,
    );

    if (result.kind === 'verdict') {
      const v: LlmVerdict = result.verdict;
      // Per ADR-0011: pass verdicts never escalate; fail verdicts
      // escalate only when confidence clears the same threshold the
      // hard-signal pool uses. Skipped/error verdicts (not handled
      // here) fall through to pass — per brief, "no silent fallback"
      // means we don't invent a fail from a missing verdict.
      if (v.verdict === 'fail' && v.confidence >= config.threshold) {
        return {
          kind: 'escalate',
          reason: 'llm_verdict',
          signals,
          aggregate,
          verdict: v,
        };
      }
      return { kind: 'pass', signals, aggregate, verdict: v };
    }
    // result.kind is 'skipped' or 'error'; fall through to pass
    // without a verdict — the transparency layer and audit log can
    // show the signals and aggregate, and the absence of a verdict is
    // itself signal-bearing information they can render.
  }

  return { kind: 'pass', signals, aggregate };
};

// ---------------------------------------------------------------------------
// Internal helpers exported for testing
// ---------------------------------------------------------------------------

/** @internal — exposed for unit tests only. */
export const __internal = {
  aggregateSignals,
  aggregateInGreyBand,
  clamp01,
};

/** Re-export for convenience so callers importing the orchestrator get
 * the category list from one place. */
export type { SignalCategory };
