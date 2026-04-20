// Critic module barrel.
//
// Issue #3 scope: re-exports the hard-signal detection surface
// (see {@link ./hard-signals.ts}). The noisy-OR aggregator, weight
// application, and verdict/threshold decision live in a future file
// in this directory, added when issue #5 lands.
//
// Until then, callers get only the detection primitives. The
// orchestrator's interface (cascade strategy, threshold comparison,
// LLM-critic gating, cost ceiling) is deliberately not committed yet,
// because its exact shape is driven by ADR-0006 (aggregation) and
// the config schema from issue #11.

export {
  collectHardSignals,
  emptyDetector,
  HARD_SIGNAL_DETECTORS,
  refusalDetector,
  repetitionDetector,
  syntaxErrorDetector,
  toolErrorDetector,
  truncationDetector,
} from './hard-signals.js';
