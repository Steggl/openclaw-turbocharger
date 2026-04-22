// Chorus module barrel. See ADR-0021 for why chorus lives outside
// src/escalation: chorus is a parallel AnswerMode (user-selected
// paradigm for multi-model consensus with bias transparency), not an
// escalation fallback.

export { dispatchChorus } from './dispatch.js';
export type { ChorusDispatchInput } from './dispatch.js';
