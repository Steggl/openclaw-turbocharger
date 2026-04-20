// Critic module barrel.
//
// Issue #3 exposed the hard-signal detection surface. Issue #4 adds the
// LLM-critic. The noisy-OR aggregator for hard signals, the escalation
// threshold comparison, and the trigger-gating that decides when the
// LLM-critic runs all land in issue #5 (orchestrator) alongside ADRs
// 0006, 0010, and 0011.
//
// Until then, callers importing from this module get the detection
// primitives (hard-signal detectors, the collector) and the LLM-critic
// callable. Gluing them into a single verdict is not committed to yet.

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

export { runLlmCritic } from './llm-critic.js';
