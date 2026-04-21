// Max escalation strategy: jump directly to a user-configured
// "maximum performance" model when the orchestrator (issue #5) signals
// that the current model's answer is inadequate. No intermediate
// ladder steps — one re-query, then stop.
//
// Scope (v0.1, issue #7):
//   - Pure function {@link maxStep} that returns the configured
//     `maxModel` when set, or `null` when the caller has selected
//     max-mode without supplying a maxModel.
//   - The pipeline (src/pipeline.ts) owns the re-query logic and the
//     stopping condition; this module only resolves the target model.
//   - Per ADR-0019, max-mode respects `maxDepth`: when `maxDepth` is
//     0 the max-mode strategy is disabled just like ladder-mode. The
//     pipeline enforces that; this module does not read `maxDepth`.
//
// Intentionally NOT in this file:
//   - The re-query / orchestrator loop — pipeline.ts handles it.
//   - Per-model baseUrl / apiKey — shared with ladder per ADR-0016.
//     v0.1 addresses every mode's target at the single configured
//     downstream ProxyTarget.
//   - A fallback to the top of `ladder` when `maxModel` is unset —
//     deliberately omitted per ADR-0019 to make missing configuration
//     loud rather than silent.

import type { EscalationConfig } from '../types.js';

/**
 * Resolve the target model for a max-mode escalation.
 *
 * Returns `config.maxModel` when set, otherwise `null`. A `null`
 * result means the caller has a configuration error (mode is 'max'
 * but no maxModel was supplied) and the pipeline should treat the
 * escalation as not-attempted rather than invent a fallback target.
 */
export function maxStep(config: EscalationConfig): string | null {
  if (config.maxModel === undefined || config.maxModel.length === 0) {
    return null;
  }
  return config.maxModel;
}
