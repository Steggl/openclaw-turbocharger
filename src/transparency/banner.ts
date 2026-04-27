// Transparency banner (Issue #9).
//
// Produces a short, locale-aware text annotation that the pipeline
// prepends to the response content when the orchestrator decided that
// escalation was warranted. The goal is to make adequacy decisions
// visible to the end user without overwhelming them — when a request
// passed adequacy on the first try, no banner is emitted.
//
// Per the brief (§7) the banner is the default-recommended transparency
// mode for v0.1, but the technical default for {@link TransparencyConfig.mode}
// is `silent`: a sidecar deployed without explicit transparency config
// must not start mutating response bodies. Operators opt in by setting
// `mode: 'banner'` on their AppDeps. Once opted in, every escalation
// decision in single-mode requests produces a banner; chorus-mode
// responses are untouched per ADR-0021.
//
// The banner format is a single-line marker plus the localized text,
// followed by a blank line, then the original content:
//
//   [turbocharger] <localized message>
//
//   <original assistant content>
//
// The `[turbocharger]` marker is unambiguous and machine-parseable —
// downstream clients that want to strip the banner can match
// `/^\[turbocharger\] [^\n]+\n\n/`.
//
// Scope (v0.1, Issue #9):
//   - Banner only. The `card` mode arrives in Issue #10 with a
//     structured JSON-in-content surface.
//   - Two locales: `en` (default fallback) and `de` (covers de-DE,
//     de-AT, de-CH via prefix match). Other locales fall through to
//     `en`.
//   - No banner for `decision: pass`. The user only sees a banner
//     when something *interesting* happened — escalation, skip with
//     reason, or a hard configuration stop.
//   - No banner for streaming responses (ADR-0013): the pipeline
//     skips the orchestrator entirely there, so this module never
//     gets called for those.
//   - No banner for chorus-mode responses (ADR-0021): chorus is its
//     own paradigm and its outcome surface is the chorus headers.

import type { EscalationTrace, OrchestratorDecision } from '../types.js';

export type BannerLocale = 'en' | 'de';

const BANNER_MARKER = '[turbocharger]';

/**
 * Resolve a BCP-47 locale tag to one of the supported banner locales.
 * Prefix-matches `de*` → `de`; everything else falls through to `en`.
 */
export function resolveBannerLocale(locale: string | undefined): BannerLocale {
  if (locale === undefined || locale.length === 0) return 'en';
  const lower = locale.toLowerCase();
  if (lower === 'de' || lower.startsWith('de-') || lower.startsWith('de_')) return 'de';
  return 'en';
}

/**
 * Produce the banner text (without trailing blank line) for a given
 * decision and trace, or `null` if no banner should be emitted.
 *
 * Returns `null` for `kind: 'pass'` per the design decision that
 * users should only see a banner when escalation/skip happened.
 */
export function formatBanner(
  decision: OrchestratorDecision,
  trace: EscalationTrace,
  locale: string | undefined,
): string | null {
  const lang = resolveBannerLocale(locale);

  // Suppress the banner only when the very first response passed —
  // i.e. the orchestrator said pass AND no escalation ever ran. If a
  // re-query produced a passing answer (decision: pass, depth > 0),
  // the banner IS what the user should see: the visible answer comes
  // from a different model than the client requested, and that's
  // exactly the transparency goal.
  if (decision.kind === 'pass' && trace.depth === 0) return null;

  if (decision.kind === 'skipped') {
    const text = SKIPPED_TEXT[lang][decision.reason];
    if (text === undefined) return null;
    return `${BANNER_MARKER} ${text}`;
  }

  // Either decision.kind === 'escalate' (the loop ended without a
  // passing answer) or decision.kind === 'pass' with depth > 0 (a
  // re-query produced a passing answer). Both cases share the same
  // narrative, parameterized by trace.stoppedReason — the i18n table
  // maps stoppedReason to the user-facing text.
  const text = ESCALATE_TEXT[lang][trace.stoppedReason];
  return `${BANNER_MARKER} ${text}`;
}

/**
 * Convenience for the pipeline: returns the banner text plus the
 * trailing blank line, ready to be prepended to assistant content.
 * Returns `null` when no banner should be emitted.
 */
export function formatBannerPrefix(
  decision: OrchestratorDecision,
  trace: EscalationTrace,
  locale: string | undefined,
): string | null {
  const banner = formatBanner(decision, trace, locale);
  if (banner === null) return null;
  return `${banner}\n\n`;
}

// ---------------------------------------------------------------------------
// Text tables
// ---------------------------------------------------------------------------

// Tone: deliberately vague. Per the project principle "do not overclaim",
// the banner says "looked incomplete" rather than "was wrong" — we report
// what the adequacy critic flagged, not a definitive judgement of the
// answer's correctness.

const ESCALATE_TEXT: Record<BannerLocale, Record<EscalationTrace['stoppedReason'], string>> = {
  en: {
    passed:
      'A stronger model was used because the first answer looked incomplete. The answer below is from the stronger model.',
    max_depth_reached:
      'The first answer looked incomplete and a stronger model was tried, but its answer was also flagged. The answer below is the last attempt.',
    ladder_exhausted:
      'The first answer looked incomplete and the strongest available model was tried, but its answer was also flagged. The answer below is from that model.',
    model_not_on_ladder:
      'The first answer looked incomplete, but no stronger model is configured for this request. The answer below is the original.',
    max_model_not_set:
      'The first answer looked incomplete, but max-mode escalation has no target model configured. The answer below is the original.',
    not_attempted:
      'The first answer looked incomplete, but escalation is disabled for this request. The answer below is the original.',
  },
  de: {
    passed:
      'Ein stärkeres Modell wurde verwendet, weil die erste Antwort unvollständig wirkte. Die Antwort unten stammt vom stärkeren Modell.',
    max_depth_reached:
      'Die erste Antwort wirkte unvollständig; ein stärkeres Modell wurde versucht, aber auch dessen Antwort wurde als unzureichend markiert. Die Antwort unten ist der letzte Versuch.',
    ladder_exhausted:
      'Die erste Antwort wirkte unvollständig; das stärkste verfügbare Modell wurde versucht, aber auch dessen Antwort wurde markiert. Die Antwort unten stammt von diesem Modell.',
    model_not_on_ladder:
      'Die erste Antwort wirkte unvollständig, aber für diese Anfrage ist kein stärkeres Modell konfiguriert. Die Antwort unten ist die ursprüngliche.',
    max_model_not_set:
      'Die erste Antwort wirkte unvollständig, aber für Max-Mode ist kein Zielmodell konfiguriert. Die Antwort unten ist die ursprüngliche.',
    not_attempted:
      'Die erste Antwort wirkte unvollständig, aber Eskalation ist für diese Anfrage deaktiviert. Die Antwort unten ist die ursprüngliche.',
  },
};

// Streaming is intentionally absent: streaming responses skip the
// orchestrator entirely (ADR-0013) and this module is never called
// for them. We list it as undefined-skipping to make that explicit.
const SKIPPED_TEXT: Record<
  BannerLocale,
  Partial<Record<NonNullable<Extract<OrchestratorDecision, { kind: 'skipped' }>['reason']>, string>>
> = {
  en: {
    non_ok_status: 'The downstream model returned an error response.',
    non_json_content_type:
      'The downstream model returned a response that could not be evaluated.',
  },
  de: {
    non_ok_status: 'Das Backend-Modell hat eine Fehlerantwort zurückgegeben.',
    non_json_content_type:
      'Das Backend-Modell hat eine Antwort zurückgegeben, die nicht ausgewertet werden konnte.',
  },
};
