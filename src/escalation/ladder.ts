// Ladder escalation strategy: step up a user-configured chain of model IDs
// one rung at a time when the orchestrator (issue #5) signals that the
// current model's answer is inadequate.
//
// Scope (v0.1, issue #6):
//   - Pure function {@link nextLadderStep} that resolves the position of a
//     current model on a ladder and returns the next rung, or `null` when
//     the ladder is exhausted or the current model is unknown.
//   - No I/O, no state, no escalation execution — those live in the
//     pipeline (src/pipeline.ts) which loops nextLadderStep + forward +
//     orchestrate until a pass, ladder exhaustion, or the configured
//     maxDepth is reached.
//
// Intentionally NOT in this file:
//   - The escalation loop itself — pipeline.ts owns the re-query logic so
//     the strategy modules stay pure and independently testable.
//   - Per-model baseUrl / apiKey — see ADR-0016. v0.1 sends every ladder
//     step to the single configured downstream ProxyTarget.
//   - Max-mode and chorus dispatch — issues #7 and #8 respectively.

/**
 * Find the next model on the ladder above `currentModel`. Returns
 * `null` when:
 * - the current model is not on the ladder (caller decides whether to
 *   treat that as "start from the bottom" or "don't escalate"; the
 *   pipeline treats it as the latter per ADR-0016);
 * - the current model is already the top rung;
 * - the ladder is empty.
 *
 * Case-sensitive match on the model ID — provider IDs are
 * conventionally case-sensitive (`anthropic/claude-haiku-4-5` vs
 * `Anthropic/Claude-Haiku-4-5` are not the same model) and we do not
 * silently normalize.
 */
export function nextLadderStep(currentModel: string, ladder: readonly string[]): string | null {
  if (ladder.length === 0) return null;
  const index = ladder.indexOf(currentModel);
  if (index === -1) return null;
  if (index >= ladder.length - 1) return null;
  return ladder[index + 1] ?? null;
}

/**
 * Count how many ladder steps remain above `currentModel`. Returns `0`
 * when the current model is at the top of or not on the ladder. Used
 * by the pipeline to decide whether to attempt escalation at all when
 * the configured `maxDepth` still allows it but the ladder has nothing
 * more to offer.
 */
export function remainingLadderSteps(currentModel: string, ladder: readonly string[]): number {
  if (ladder.length === 0) return 0;
  const index = ladder.indexOf(currentModel);
  if (index === -1) return 0;
  return Math.max(0, ladder.length - 1 - index);
}
