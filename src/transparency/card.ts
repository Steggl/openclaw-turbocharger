// Transparency card (Issue #10).
//
// The card is a structured-Markdown counterpart to the single-line
// banner from Issue #9. Where the banner conveys "something happened"
// in one sentence, the card surfaces the full decision context:
// which model the request started with, what the orchestrator
// decided and why, which signals fired with what confidence, the
// aggregate score, the escalation path, and the outcome.
//
// Like the banner, the card is opt-in (technical default is
// `silent`) and only emits in single-mode responses — chorus-mode
// responses are exempt per ADR-0021. Streaming is exempt per
// ADR-0013 since the orchestrator does not run there in the first
// place.
//
// Format (English variant, escalation that succeeded on a re-query):
//
//   [turbocharger card]
//   - Initial model: weak-model
//   - Decision: escalate (hard_signals)
//   - Signals: refusal (0.92)
//   - Aggregate: 0.853
//   - Path: weak-model → mid-model
//   - Outcome: passed at depth 1
//
//   ---
//
//   <original assistant content>
//
// Design notes:
//
//   - The marker `[turbocharger card]` is distinct from the banner's
//     `[turbocharger]`. Clients that strip transparency annotations
//     can match each marker independently.
//   - Structural labels (`Initial model:`, `Decision:`, ...) are
//     localized — `en` and `de`. Values stay English (model IDs,
//     signal categories like `refusal`, decision kinds like `pass`).
//     These match the `x-turbocharger-*` headers and ADR vocabulary;
//     localizing them would diverge user-facing text from the
//     machine-readable surface.
//   - Pass + depth=0 emits no card, matching the banner suppression
//     rule. The card is for "something interesting happened"; a
//     successful first try is not interesting.
//   - LLM-verdict information is shown when present (one extra line
//     with verdict + confidence). The verdict's free-form `reason`
//     text is not shown — it would be the most variable field and
//     the operator opted into a structured surface, not free text.
//   - Cost-delta and time-delta are deliberately out of scope for
//     v0.1 of the card. Cost delta requires per-model pricing data
//     the sidecar does not have today; time delta is captured in
//     the structured log already and adding it here would imply a
//     precision the card cannot deliver. Both are candidates for
//     a later issue.

import type { EscalationTrace, OrchestratorDecision, Signal } from '../types.js';

export type CardLocale = 'en' | 'de';

const CARD_MARKER = '[turbocharger card]';

/**
 * Resolve a BCP-47 locale tag to one of the supported card locales.
 * Mirrors the banner's resolveBannerLocale: `de*` → `de`, everything
 * else → `en`.
 */
export function resolveCardLocale(locale: string | undefined): CardLocale {
  if (locale === undefined || locale.length === 0) return 'en';
  const lower = locale.toLowerCase();
  if (lower === 'de' || lower.startsWith('de-') || lower.startsWith('de_')) return 'de';
  return 'en';
}

/**
 * Produce the card text (without trailing separator or blank line)
 * for a given decision and trace, or `null` if no card should be
 * emitted (pass + depth=0, or skipped with a reason that has no
 * card mapping).
 */
export function formatCard(
  decision: OrchestratorDecision,
  trace: EscalationTrace,
  initialModel: string,
  locale: string | undefined,
): string | null {
  const lang = resolveCardLocale(locale);
  const labels = LABELS[lang];

  // Suppress for pass + depth=0 (consistent with banner).
  if (decision.kind === 'pass' && trace.depth === 0) return null;

  // Skipped decisions: only emit for skipped reasons that have a
  // user-visible mapping. Streaming-skipped never reaches this
  // function (orchestrator does not run for streaming) but we list
  // it explicitly via the LABELS table for completeness.
  if (decision.kind === 'skipped') {
    const skipText = labels.skipReasons[decision.reason];
    if (skipText === undefined) return null;
    const lines = [
      CARD_MARKER,
      `- ${labels.initialModel}: ${initialModel}`,
      `- ${labels.decision}: skipped (${skipText})`,
    ];
    if (decision.detail !== undefined && decision.detail.length > 0) {
      lines.push(`- ${labels.detail}: ${decision.detail}`);
    }
    return lines.join('\n');
  }

  // Pass + depth>0 (re-query produced a passing answer) and escalate
  // both share the same field set: initial model, decision, signals
  // (when present), aggregate, optional verdict, path, outcome. The
  // decision-line wording differs slightly to make the success vs
  // open-ended escalation distinction visible.
  const lines: string[] = [CARD_MARKER];
  lines.push(`- ${labels.initialModel}: ${initialModel}`);

  if (decision.kind === 'pass') {
    lines.push(`- ${labels.decision}: ${labels.passAfterEscalation}`);
  } else {
    // escalate
    lines.push(`- ${labels.decision}: escalate (${decision.reason})`);
  }

  if (decision.signals.length > 0) {
    const nonZero = decision.signals.filter((s) => s.confidence > 0);
    if (nonZero.length > 0) {
      lines.push(`- ${labels.signals}: ${formatSignals(nonZero)}`);
    }
  }

  lines.push(`- ${labels.aggregate}: ${decision.aggregate.toFixed(3)}`);

  if (decision.verdict !== undefined) {
    lines.push(
      `- ${labels.llmVerdict}: ${decision.verdict.verdict} (${decision.verdict.confidence.toFixed(2)})`,
    );
  }

  if (trace.path.length > 0) {
    lines.push(`- ${labels.path}: ${[initialModel, ...trace.path].join(' → ')}`);
  }

  lines.push(`- ${labels.outcome}: ${formatOutcome(trace, labels)}`);

  return lines.join('\n');
}

/**
 * Convenience for the pipeline: returns the card text plus the
 * `---` separator and trailing blank line, ready to be prepended
 * to assistant content. Returns `null` when no card should be
 * emitted.
 */
export function formatCardPrefix(
  decision: OrchestratorDecision,
  trace: EscalationTrace,
  initialModel: string,
  locale: string | undefined,
): string | null {
  const card = formatCard(decision, trace, initialModel, locale);
  if (card === null) return null;
  return `${card}\n\n---\n\n`;
}

function formatSignals(signals: readonly Signal[]): string {
  return signals.map((s) => `${s.category} (${s.confidence.toFixed(2)})`).join(', ');
}

function formatOutcome(trace: EscalationTrace, labels: CardLabels): string {
  switch (trace.stoppedReason) {
    case 'passed':
      return labels.outcomePassedAtDepth.replace('{depth}', String(trace.depth));
    case 'max_depth_reached':
      return labels.outcomeMaxDepthReached;
    case 'ladder_exhausted':
      return labels.outcomeLadderExhausted;
    case 'model_not_on_ladder':
      return labels.outcomeModelNotOnLadder;
    case 'max_model_not_set':
      return labels.outcomeMaxModelNotSet;
    case 'not_attempted':
      return labels.outcomeNotAttempted;
  }
}

// ---------------------------------------------------------------------------
// Label tables
// ---------------------------------------------------------------------------

interface CardLabels {
  readonly initialModel: string;
  readonly decision: string;
  readonly signals: string;
  readonly aggregate: string;
  readonly llmVerdict: string;
  readonly path: string;
  readonly outcome: string;
  readonly detail: string;
  readonly passAfterEscalation: string;
  readonly outcomePassedAtDepth: string;
  readonly outcomeMaxDepthReached: string;
  readonly outcomeLadderExhausted: string;
  readonly outcomeModelNotOnLadder: string;
  readonly outcomeMaxModelNotSet: string;
  readonly outcomeNotAttempted: string;
  readonly skipReasons: Partial<
    Record<NonNullable<Extract<OrchestratorDecision, { kind: 'skipped' }>['reason']>, string>
  >;
}

const LABELS: Record<CardLocale, CardLabels> = {
  en: {
    initialModel: 'Initial model',
    decision: 'Decision',
    signals: 'Signals',
    aggregate: 'Aggregate',
    llmVerdict: 'LLM verdict',
    path: 'Path',
    outcome: 'Outcome',
    detail: 'Detail',
    passAfterEscalation: 'pass (after escalation)',
    outcomePassedAtDepth: 'passed at depth {depth}',
    outcomeMaxDepthReached: 'stopped after reaching max depth',
    outcomeLadderExhausted: 'stopped after exhausting the ladder',
    outcomeModelNotOnLadder: 'stopped because no stronger model is configured',
    outcomeMaxModelNotSet: 'stopped because max-mode has no target model',
    outcomeNotAttempted: 'no escalation attempted (disabled)',
    skipReasons: {
      non_ok_status: 'non_ok_status',
      non_json_content_type: 'non_json_content_type',
    },
  },
  de: {
    initialModel: 'Initiales Modell',
    decision: 'Entscheidung',
    signals: 'Signale',
    aggregate: 'Aggregat',
    llmVerdict: 'LLM-Verdict',
    path: 'Pfad',
    outcome: 'Ergebnis',
    detail: 'Detail',
    passAfterEscalation: 'pass (nach Eskalation)',
    outcomePassedAtDepth: 'passed bei Tiefe {depth}',
    outcomeMaxDepthReached: 'gestoppt nach Erreichen der Max-Tiefe',
    outcomeLadderExhausted: 'gestoppt nach Aufbrauch der Ladder',
    outcomeModelNotOnLadder: 'gestoppt, weil kein stärkeres Modell konfiguriert ist',
    outcomeMaxModelNotSet: 'gestoppt, weil Max-Mode kein Zielmodell hat',
    outcomeNotAttempted: 'keine Eskalation versucht (deaktiviert)',
    skipReasons: {
      non_ok_status: 'non_ok_status',
      non_json_content_type: 'non_json_content_type',
    },
  },
};
