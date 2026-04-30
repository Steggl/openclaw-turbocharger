// Per-request header overrides (Issue #12).
//
// Two headers are recognised, both case-insensitive (HTTP-spec):
//
//   X-Turbocharger-Answer-Mode: single | chorus
//   X-Turbocharger-Transparency: silent | banner | card
//
// Per ADR-0025 the design is tolerant-with-reject: invalid header
// values do not fail the request. Instead they are listed in a
// response-side `x-turbocharger-override-rejected` header so the
// client sees what was ignored. The request continues with the
// configured defaults, never silently. This matches the brief's
// "no silent fallbacks" rule while keeping the sidecar resilient
// against client typos and version skew.
//
// A chorus-mode override against a deployment without a chorus
// configuration is a special case of the same pattern: the override
// is rejected (chorus needs an endpoint, no endpoint configured),
// the request continues in single mode.

import type { AnswerMode, ChorusConfig, TransparencyConfig } from '../types.js';

const HEADER_ANSWER_MODE = 'x-turbocharger-answer-mode';
const HEADER_TRANSPARENCY = 'x-turbocharger-transparency';

/**
 * Reasons an override was rejected. Exposed so server.ts can emit
 * them on the `x-turbocharger-override-rejected` response header
 * and on the structured log line.
 */
export interface OverrideReject {
  readonly field: 'answer-mode' | 'transparency';
  readonly value: string;
  readonly reason: 'invalid-value' | 'chorus-config-missing';
}

export interface RequestOverrides {
  readonly answerMode?: AnswerMode;
  readonly transparencyMode?: TransparencyConfig['mode'];
  readonly rejected: readonly OverrideReject[];
}

/**
 * Parse request headers into a `RequestOverrides`. The `chorusConfig`
 * argument is consulted only to validate a chorus-mode override:
 * when the request asks for chorus mode but no chorus endpoint is
 * configured, the override is rejected.
 *
 * The function never throws. Anything that cannot be parsed becomes
 * a {@link OverrideReject} entry; the caller decides what to do
 * with the list (typically: emit them as a response header so the
 * client knows, then proceed with defaults).
 */
export function parseRequestOverrides(
  headers: Headers,
  chorusConfig: ChorusConfig | undefined,
): RequestOverrides {
  const rejected: OverrideReject[] = [];
  let answerMode: AnswerMode | undefined;
  let transparencyMode: TransparencyConfig['mode'] | undefined;

  const rawAnswer = headers.get(HEADER_ANSWER_MODE);
  if (rawAnswer !== null) {
    const trimmed = rawAnswer.trim().toLowerCase();
    if (trimmed === 'single') {
      answerMode = 'single';
    } else if (trimmed === 'chorus') {
      if (chorusConfig === undefined) {
        rejected.push({
          field: 'answer-mode',
          value: trimmed,
          reason: 'chorus-config-missing',
        });
      } else {
        answerMode = 'chorus';
      }
    } else if (trimmed.length > 0) {
      rejected.push({
        field: 'answer-mode',
        value: trimmed,
        reason: 'invalid-value',
      });
    }
    // empty string after trim: silently ignore — header was set but
    // empty, which is more likely a client bug than a deliberate
    // value to validate against.
  }

  const rawTransparency = headers.get(HEADER_TRANSPARENCY);
  if (rawTransparency !== null) {
    const trimmed = rawTransparency.trim().toLowerCase();
    if (trimmed === 'silent' || trimmed === 'banner' || trimmed === 'card') {
      transparencyMode = trimmed;
    } else if (trimmed.length > 0) {
      rejected.push({
        field: 'transparency',
        value: trimmed,
        reason: 'invalid-value',
      });
    }
  }

  return {
    ...(answerMode !== undefined ? { answerMode } : {}),
    ...(transparencyMode !== undefined ? { transparencyMode } : {}),
    rejected,
  };
}

/**
 * Render the rejection list as the value for the
 * `x-turbocharger-override-rejected` response header. Returns
 * `null` when there is nothing to emit so the caller can skip
 * setting the header entirely.
 *
 * Format: comma-separated `field=value:reason` entries. Example:
 *
 *   x-turbocharger-override-rejected: answer-mode=dance:invalid-value, transparency=flashy:invalid-value
 *
 * The value-after-colon disambiguates the two rejection reasons
 * (invalid-value vs chorus-config-missing) so monitoring tools can
 * tell why each entry was dropped without parsing the value text.
 */
export function formatRejectedHeader(rejected: readonly OverrideReject[]): string | null {
  if (rejected.length === 0) return null;
  return rejected.map((r) => `${r.field}=${r.value}:${r.reason}`).join(', ');
}
