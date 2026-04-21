// Escalation module barrel.
//
// Issue #6 exposes the ladder strategy as a pure function. Issues #7
// (max) and #8 (chorus-stub) will add their own strategy modules here.
// The pipeline (src/pipeline.ts) selects the active strategy from the
// configured {@link EscalationConfig.mode} and calls the strategy's
// pure helpers to compute the next model. The pipeline itself owns the
// re-query loop so the strategy modules stay stateless and testable.

export { nextLadderStep, remainingLadderSteps } from './ladder.js';
