// Hard-signal detectors: deterministic, zero-cost adequacy checks that emit
// probabilistic {@link Signal}s per ADR-0006. The orchestrator (issue #5)
// aggregates signals from all enabled detectors via noisy-OR and compares
// the aggregate against a threshold to decide escalation.
//
// Each detector is a pure function. A detector returns `null` when it finds
// no evidence, or a {@link Signal} with a confidence score that reflects
// how strongly it believes the response is inadequate.
//
// Scope notes:
//   - Syntax-error checks cover JSON code fences only, per ADR-0008.
//     Multi-language syntax validation (JS/TS/Python/...) lands in a
//     post-MVP issue.
//
// Intentionally NOT in this file:
//   - Aggregation / threshold logic: issue #5 (ADR-0006).
//   - Per-rule disable flags from config: issue #11 (config schema).
//   - Weight application: issue #5.

import type { DetectorInput, HardSignalDetector, Signal } from '../types.js';
import { resolveLocale } from '../locale.js';

// ---------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------

interface RefusalPattern {
  readonly pattern: RegExp;
  readonly confidence: number;
}

/**
 * Locale-keyed refusal patterns. Confidence levels:
 *   0.95 — explicit, unambiguous refusal.
 *   0.70 — boilerplate AI-disclaimer preamble often preceding a refusal.
 *   0.40 — soft hedging that sometimes but not always precedes refusal.
 *
 * Patterns are case-insensitive.
 */
const REFUSAL_PATTERNS: Readonly<Record<string, readonly RefusalPattern[]>> = {
  en: [
    {
      pattern: /\bI\s+(?:can(?:not|'t)|am\s+unable\s+to|won't)\s+(?:help|assist|provide|do)\b/i,
      confidence: 0.95,
    },
    {
      pattern:
        /\b(?:sorry|unfortunately)[,.]\s*(?:but\s+)?I\s+(?:can(?:not|'t)|am\s+unable\s+to)\b/i,
      confidence: 0.95,
    },
    { pattern: /\bAs\s+an\s+AI\s+(?:language\s+)?(?:model|assistant)[,.]/i, confidence: 0.7 },
    { pattern: /\bI\s+(?:must|should|would)\s+(?:caution|advise|warn|note)\b/i, confidence: 0.4 },
    { pattern: /\bI\s+have\s+concerns\s+about\b/i, confidence: 0.4 },
  ],
  de: [
    {
      pattern:
        /\b(?:ich\s+kann\s+(?:dir|Ihnen|dabei)\s+nicht\s+helfen|ich\s+bin\s+nicht\s+in\s+der\s+Lage)\b/i,
      confidence: 0.95,
    },
    {
      pattern:
        /\b(?:leider|entschuldigung)[,.]\s*(?:aber\s+)?(?:ich\s+kann|das\s+kann\s+ich\s+nicht)\b/i,
      confidence: 0.95,
    },
    { pattern: /\bAls\s+(?:KI|K\.I\.|ein\s+KI-(?:Assistent|Modell))[,.]/i, confidence: 0.7 },
    {
      pattern: /\bich\s+(?:muss|sollte|möchte)\s+(?:darauf\s+hinweisen|anmerken|warnen)\b/i,
      confidence: 0.4,
    },
  ],
};

const DEFAULT_LOCALE = 'en';
const REFUSAL_LOCALES = ['en', 'de'] as const;

export const refusalDetector: HardSignalDetector = (input) => {
  // Resolve the request locale to one of the buckets we actually have
  // patterns for. Without this resolver, `Accept-Language: de-DE` would
  // miss the German bucket and fall through to English-only patterns.
  // See ADR-0026 and issue #18.
  const locale = resolveLocale(input.locale, REFUSAL_LOCALES, DEFAULT_LOCALE);
  const primary = REFUSAL_PATTERNS[locale] ?? REFUSAL_PATTERNS[DEFAULT_LOCALE] ?? [];
  // Also try English patterns as a fallback — non-English interactions
  // frequently surface English refusal phrasing from providers whose
  // system prompts lean toward English.
  const fallback = locale === DEFAULT_LOCALE ? [] : (REFUSAL_PATTERNS[DEFAULT_LOCALE] ?? []);
  const candidates = [...primary, ...fallback];

  let best: RefusalPattern | null = null;
  for (const candidate of candidates) {
    if (candidate.pattern.test(input.response)) {
      if (best === null || candidate.confidence > best.confidence) {
        best = candidate;
      }
    }
  }

  if (best === null) return null;
  return {
    category: 'refusal',
    confidence: best.confidence,
    reason: `refusal phrase matched: /${best.pattern.source.slice(0, 60)}/`,
  };
};

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/**
 * Likely truncation when the provider signaled `finish_reason: "length"`
 * AND the text does not end with a natural sentence terminator.
 * Terminator detection is heuristic — it permits trailing whitespace and
 * closing quotes/brackets, and covers English, German, and CJK punctuation.
 */
export const truncationDetector: HardSignalDetector = (input) => {
  if (input.finishReason !== 'length') return null;

  const trimmed = input.response.replace(/[\s"')\]}]+$/u, '');
  if (trimmed.length === 0) {
    // Empty-after-trim is the {@link emptyDetector}'s territory; do not
    // double-fire here.
    return null;
  }
  const lastChar = trimmed[trimmed.length - 1];
  const endsNaturally = lastChar !== undefined && /[.!?。！？]/u.test(lastChar);

  const confidence = endsNaturally ? 0.6 : 0.9;
  return {
    category: 'truncation',
    confidence,
    reason: endsNaturally
      ? 'finish_reason=length with sentence terminator (ambiguous)'
      : 'finish_reason=length and text ends mid-thought',
  };
};

// ---------------------------------------------------------------------------
// Repetition
// ---------------------------------------------------------------------------

const NGRAM_SIZE = 4;
const MIN_REPEAT_COUNT = 3;
const MIN_TOKENS = 20;

/**
 * N-gram based repetition detector. Fires only when:
 *   - the response has at least {@link MIN_TOKENS} tokens (shorter
 *     responses are the empty/short detector's territory), AND
 *   - the most frequent {@link NGRAM_SIZE}-gram appears at least
 *     {@link MIN_REPEAT_COUNT} times.
 *
 * Confidence scales with the *share* of the response that the most
 * frequent n-gram occupies (doubled and clamped to [0.4, 0.95] so that
 * the minimum repeat count registers meaningfully but this heuristic
 * never claims certainty on its own).
 */
export const repetitionDetector: HardSignalDetector = (input) => {
  const tokens = input.response.toLowerCase().match(/\S+/g) ?? [];
  if (tokens.length < MIN_TOKENS) return null;

  const counts = new Map<string, number>();
  for (let i = 0; i + NGRAM_SIZE <= tokens.length; i++) {
    const gram = tokens.slice(i, i + NGRAM_SIZE).join(' ');
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }

  let maxCount = 0;
  let maxGram = '';
  for (const [gram, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      maxGram = gram;
    }
  }

  if (maxCount < MIN_REPEAT_COUNT) return null;

  const totalGrams = tokens.length - NGRAM_SIZE + 1;
  const share = maxCount / totalGrams;
  const confidence = Math.min(0.95, Math.max(0.4, share * 2));

  return {
    category: 'repetition',
    confidence,
    reason: `${maxCount}× repeated ${NGRAM_SIZE}-gram: "${maxGram.slice(0, 40)}"`,
  };
};

// ---------------------------------------------------------------------------
// Empty / short
// ---------------------------------------------------------------------------

/**
 * Flags responses that are suspiciously short relative to the user's
 * prompt. Comparison is on character length rather than tokens — good
 * enough for coarse triage, and it sidesteps a tokenizer dependency.
 */
export const emptyDetector: HardSignalDetector = (input) => {
  const responseLen = input.response.trim().length;
  const promptLen = input.userPrompt.trim().length;

  if (responseLen === 0) {
    return { category: 'empty', confidence: 0.95, reason: 'empty response' };
  }
  if (responseLen < 20 && promptLen >= 50) {
    return {
      category: 'empty',
      confidence: 0.9,
      reason: `response too short (${responseLen} chars) for prompt (${promptLen} chars)`,
    };
  }
  if (responseLen < 50 && promptLen >= 200) {
    return {
      category: 'empty',
      confidence: 0.6,
      reason: `response short (${responseLen} chars) relative to prompt (${promptLen} chars)`,
    };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Tool error
// ---------------------------------------------------------------------------

/**
 * Flags tool-call failures that surfaced in the response body. Structured
 * tool-call errors at the HTTP level are handled by the orchestrator
 * (issue #5); this detector catches error/exception markers that leaked
 * through into the assistant's textual output.
 *
 * The pattern requires the marker at the start of a line to avoid
 * matching the word "error" used as prose ("the most common error is
 * thinking…").
 */
const TOOL_ERROR_PATTERN =
  /(?:^|\n)\s*(?:Error|Exception|Traceback|TypeError|ValueError|SyntaxError|RuntimeError)\b[:\s]/;

export const toolErrorDetector: HardSignalDetector = (input) => {
  if (TOOL_ERROR_PATTERN.test(input.response)) {
    return {
      category: 'tool_error',
      confidence: 0.9,
      reason: 'error/exception marker at line start in response',
    };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Syntax error — JSON only (ADR-0008)
// ---------------------------------------------------------------------------

/**
 * Flags responses that contain a fenced code block explicitly tagged as
 * JSON whose contents do not parse. Untagged fences are skipped because
 * the language is ambiguous and false positives would dominate.
 *
 * Scope is limited to JSON in v0.1 per ADR-0008; multi-language syntax
 * checking is deferred to a post-MVP issue (`critic:code-syntax`). The
 * `syntax_error` category is kept broad so that consumers
 * (transparency layer, audit log) need no changes when additional
 * languages are added.
 */
const JSON_FENCE = /```json\s*\n([\s\S]*?)\n\s*```/g;

export const syntaxErrorDetector: HardSignalDetector = (input) => {
  // Reset lastIndex in case the shared regex was used by something earlier.
  JSON_FENCE.lastIndex = 0;

  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = JSON_FENCE.exec(input.response)) !== null) {
    if (match[1] !== undefined) blocks.push(match[1]);
  }

  if (blocks.length === 0) return null;

  const failures: string[] = [];
  for (const block of blocks) {
    try {
      JSON.parse(block);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : 'parse failure');
    }
  }

  if (failures.length === 0) return null;
  return {
    category: 'syntax_error',
    confidence: 0.85,
    reason: `${failures.length} of ${blocks.length} JSON block(s) failed to parse: ${failures[0] ?? ''}`,
  };
};

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

/**
 * Canonical detector list. Exported so tests and the orchestrator
 * (issue #5) can iterate without importing each detector by name, and
 * so the order of emitted signals is deterministic.
 */
export const HARD_SIGNAL_DETECTORS: readonly HardSignalDetector[] = [
  refusalDetector,
  truncationDetector,
  repetitionDetector,
  emptyDetector,
  toolErrorDetector,
  syntaxErrorDetector,
];

/**
 * Run every hard-signal detector and return the non-null results in the
 * canonical order defined by {@link HARD_SIGNAL_DETECTORS}. The returned
 * list may be empty.
 *
 * This function deliberately does not apply weights, does not compare
 * against any threshold, and does not express a pass/fail verdict — those
 * concerns belong to the orchestrator in issue #5, following ADR-0006.
 */
export function collectHardSignals(input: DetectorInput): readonly Signal[] {
  const signals: Signal[] = [];
  for (const detector of HARD_SIGNAL_DETECTORS) {
    const signal = detector(input);
    if (signal !== null) signals.push(signal);
  }
  return signals;
}
