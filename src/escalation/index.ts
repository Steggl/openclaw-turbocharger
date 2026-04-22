// Escalation module barrel.
//
// Issue #6 exposed the ladder strategy. Issue #7 added the max
// strategy (one-shot jump to a configured `maxModel`). The pipeline
// (src/pipeline.ts) selects the active strategy from the configured
// {@link EscalationConfig.mode} and calls the strategy's pure
// helpers; the re-query loop is owned by the pipeline so the
// strategy modules stay stateless and testable.
//
// Chorus was originally added here under Issue #8 but was moved out
// into src/chorus/ per ADR-0021: chorus is not an escalation
// strategy but a parallel answer mode, and putting it under
// escalation conflated two different concerns.

export { nextLadderStep, remainingLadderSteps } from './ladder.js';
export { maxStep } from './max.js';
