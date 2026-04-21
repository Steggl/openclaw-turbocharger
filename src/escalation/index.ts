// Escalation module barrel.
//
// Issue #6 exposed the ladder strategy. Issue #7 adds the max
// strategy (one-shot jump to a configured `maxModel`). Issue #8
// (chorus-stub) will add its own strategy module here. The pipeline
// (src/pipeline.ts) selects the active strategy from the configured
// {@link EscalationConfig.mode} and calls the strategy's pure
// helpers to compute the next model. The pipeline itself owns the
// re-query loop so the strategy modules stay stateless and testable.

export { nextLadderStep, remainingLadderSteps } from './ladder.js';
export { maxStep } from './max.js';
