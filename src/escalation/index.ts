// Escalation module barrel.
//
// Issue #6 exposed the ladder strategy. Issue #7 added the max
// strategy (one-shot jump to a configured `maxModel`). Issue #8
// adds the chorus dispatch stub (one-shot POST to a configured
// `chorusEndpoint`; full chorus logic lives in the separate
// `openclaw-chorus` project). The pipeline (src/pipeline.ts)
// selects the active strategy from the configured
// {@link EscalationConfig.mode} and calls the strategy's pure
// helpers; the re-query loop and the chorus dispatch are owned by
// the pipeline so the strategy modules stay stateless and testable.

export { nextLadderStep, remainingLadderSteps } from './ladder.js';
export { maxStep } from './max.js';
export { dispatchChorus } from './chorus.js';
