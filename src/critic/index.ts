// Critic module barrel.
//
// Issue #3 exposed the hard-signal detection surface. Issue #4 added the
// LLM-critic. Issue #5 adds the orchestrator that combines them into a
// single decision via noisy-OR aggregation and grey-band gating.
//
// Callers importing from this module get the detection primitives,
// the LLM-critic callable, and the orchestrator. The pipeline that
// wires the orchestrator in front of the proxy is in
// {@link ../pipeline.ts}.

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

export { aggregateSignals, runOrchestrator } from './orchestrator.js';
