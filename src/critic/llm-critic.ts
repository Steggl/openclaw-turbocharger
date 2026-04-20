// LLM-critic: asks a small, separate model whether an assistant response
// adequately answers the user's request. Returns a discriminated
// {@link LlmCriticResult} — either a usable verdict, or an explicit
// "skipped" / "error" reason that the orchestrator (issue #5) handles
// without ever converting into a silent `pass`.
//
// Scope for v0.1 (see ADRs 0010, 0011, 0012):
//   - Does NOT run automatically. The orchestrator (issue #5) invokes this
//     only when the hard-signal noisy-OR aggregate lands in the grey band
//     (0.3..0.6), per ADR-0010.
//   - The verdict it returns is NOT mixed into the hard-signal pool per
//     ADR-0011. The orchestrator compares it against the escalation
//     threshold independently.
//   - Per ADR-0012: no silent defaults for `baseUrl` or `model`; prompt
//     templates are locale-keyed (English + German shipped, English
//     fallback); verdict extraction is deliberately tolerant (```json
//     fence, then first-`{`-to-last-`}`, then direct `JSON.parse`).
//
// Intentionally NOT in this file:
//   - Trigger gating / threshold comparison — issue #5 (orchestrator).
//   - Cumulative cost accounting across requests — post-MVP.
//   - Config merging / Zod validation — issue #11 (config schema).
//   - Retry logic — one attempt per invocation; retries would skew the
//     per-request budget and are better handled by the caller.

import type {
  LlmCritic,
  LlmCriticConfig,
  LlmCriticInput,
  LlmCriticResult,
  LlmVerdict,
  ModelPricing,
} from '../types.js';

const DEFAULT_LOCALE = 'en';
const DEFAULT_TIMEOUT_MS = 30_000;
const ASSUMED_OUTPUT_TOKENS = 100;

// ---------------------------------------------------------------------------
// Prompt templates (locale-keyed per ADR-0012)
// ---------------------------------------------------------------------------

interface PromptTemplate {
  readonly system: string;
  readonly user: (ctx: { userPrompt: string; response: string }) => string;
}

const PROMPT_TEMPLATES: Readonly<Record<string, PromptTemplate>> = {
  en: {
    system:
      'You are an adequacy critic. A user made a request and received a response. ' +
      'Your job is to judge whether the response adequately answers the request. ' +
      'You must output a JSON object with exactly three fields: ' +
      '"verdict" (either "pass" or "fail"), ' +
      '"confidence" (a number in [0, 1] indicating how certain you are), ' +
      'and "reason" (a short one-sentence explanation). ' +
      'Do NOT rewrite or improve the response; you are only a judge. ' +
      'The user and assistant may be conversing in any language; your verdict ' +
      'JSON is always in English with the structure specified above.',
    user: ({ userPrompt, response }) =>
      `USER REQUEST:\n<<<\n${userPrompt}\n>>>\n\n` +
      `ASSISTANT RESPONSE:\n<<<\n${response}\n>>>\n\n` +
      'Output only the JSON object, no additional text.',
  },
  de: {
    system:
      'Du bist ein Adäquanz-Kritiker. Ein Nutzer hat eine Anfrage gestellt und eine ' +
      'Antwort erhalten. Deine Aufgabe ist es zu beurteilen, ob die Antwort die Anfrage ' +
      'adäquat beantwortet. Du musst ein JSON-Objekt mit genau drei Feldern ausgeben: ' +
      '"verdict" (entweder "pass" oder "fail"), ' +
      '"confidence" (eine Zahl in [0, 1], die angibt, wie sicher du bist), ' +
      'und "reason" (eine kurze, einsätzige Begründung). ' +
      'Schreibe die Antwort NICHT um und verbessere sie NICHT; du bist nur Richter. ' +
      'Nutzer und Assistent können in jeder Sprache kommunizieren; dein Verdict-JSON ' +
      'ist immer in englischen Feldnamen mit der oben spezifizierten Struktur.',
    user: ({ userPrompt, response }) =>
      `NUTZER-ANFRAGE:\n<<<\n${userPrompt}\n>>>\n\n` +
      `ASSISTENT-ANTWORT:\n<<<\n${response}\n>>>\n\n` +
      'Gib nur das JSON-Objekt aus, keinen zusätzlichen Text.',
  },
};

function selectTemplate(locale: string | undefined): PromptTemplate {
  const key = locale ?? DEFAULT_LOCALE;
  return PROMPT_TEMPLATES[key] ?? PROMPT_TEMPLATES[DEFAULT_LOCALE]!;
}

// ---------------------------------------------------------------------------
// Budget check
// ---------------------------------------------------------------------------

/**
 * Estimate tokens from a character count. Character-to-token ratios vary
 * by language and tokenizer; 1 token ≈ 4 characters is the common heuristic
 * for English-leaning GPT-family tokenizers and is close enough for a
 * pre-call budget check. Post-call actual usage is ignored in v0.1.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateCostUsd(promptChars: number, pricing: ModelPricing): number {
  const inputTokens = estimateTokens(' '.repeat(promptChars));
  const outputTokens = ASSUMED_OUTPUT_TOKENS;
  return (
    (inputTokens * pricing.inputUsdPerMillion + outputTokens * pricing.outputUsdPerMillion) /
    1_000_000
  );
}

// ---------------------------------------------------------------------------
// Verdict extraction (tolerant per ADR-0012)
// ---------------------------------------------------------------------------

function tryParseVerdict(candidate: string): LlmVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const verdict = obj['verdict'];
  const confidence = obj['confidence'];
  const reason = obj['reason'];

  if (verdict !== 'pass' && verdict !== 'fail') return null;
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return null;
  if (typeof reason !== 'string') return null;

  // Clamp to [0, 1] in case the critic emits values outside that range.
  const clamped = Math.min(1, Math.max(0, confidence));

  return { verdict, confidence: clamped, reason };
}

/**
 * Extract a {@link LlmVerdict} from a raw critic response. Tries three
 * strategies in order: fenced ```json block, first-`{`-to-last-`}`
 * substring, then the whole content as JSON. Returns null only when all
 * three fail.
 */
function extractVerdict(content: string): LlmVerdict | null {
  // 1. ```json fence
  const fencePattern = /```json\s*\n([\s\S]*?)\n\s*```/;
  const fenceMatch = fencePattern.exec(content);
  if (fenceMatch?.[1] !== undefined) {
    const verdict = tryParseVerdict(fenceMatch[1]);
    if (verdict !== null) return verdict;
  }

  // 2. First `{` to last `}`
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const verdict = tryParseVerdict(content.slice(firstBrace, lastBrace + 1));
    if (verdict !== null) return verdict;
  }

  // 3. Whole content
  return tryParseVerdict(content);
}

// ---------------------------------------------------------------------------
// Fetch wrapper with timeout
// ---------------------------------------------------------------------------

interface ChatCompletionChoice {
  readonly message?: { readonly content?: string | null };
}

interface ChatCompletionResponse {
  readonly choices?: readonly ChatCompletionChoice[];
}

async function fetchVerdictResponse(
  input: LlmCriticInput,
  config: LlmCriticConfig,
): Promise<LlmCriticResult | { kind: 'ok'; content: string }> {
  const template = selectTemplate(input.locale);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (config.apiKey !== undefined) {
    headers['authorization'] = `Bearer ${config.apiKey}`;
  }

  const body = JSON.stringify({
    model: config.model,
    messages: [
      { role: 'system', content: template.system },
      {
        role: 'user',
        content: template.user({
          userPrompt: input.userPrompt,
          response: input.response,
        }),
      },
    ],
    temperature: 0,
    stream: false,
  });

  const controller = new AbortController();
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const impl: typeof fetch = config.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await impl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    // AbortError has name 'AbortError' but message varies across runtimes.
    const isAbort = err instanceof Error && (err.name === 'AbortError' || /abort/i.test(message));
    return {
      kind: 'error',
      reason: isAbort ? 'timeout' : 'network',
      detail: message,
    };
  }
  clearTimeout(timer);

  if (!res.ok) {
    return {
      kind: 'error',
      reason: 'http',
      detail: `HTTP ${res.status} ${res.statusText}`,
    };
  }

  let parsed: ChatCompletionResponse;
  try {
    parsed = (await res.json()) as ChatCompletionResponse;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'error', reason: 'parse_failure', detail: `response body: ${message}` };
  }

  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    return {
      kind: 'error',
      reason: 'empty',
      detail: 'response contained no message content',
    };
  }

  return { kind: 'ok', content };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the LLM-critic. Returns a discriminated {@link LlmCriticResult}.
 * Never throws — all failures are represented as `error` or `skipped`
 * variants, per the brief's "no silent failures" principle.
 */
export const runLlmCritic: LlmCritic = async (input, config) => {
  // Pre-call budget check (opt-in: requires both budgetUsd and pricing).
  if (config.budgetUsd !== undefined && config.pricing !== undefined) {
    const template = selectTemplate(input.locale);
    const promptChars =
      template.system.length +
      template.user({ userPrompt: input.userPrompt, response: input.response }).length;
    const estimated = estimateCostUsd(promptChars, config.pricing);
    if (estimated > config.budgetUsd) {
      return { kind: 'skipped', reason: 'over_budget' };
    }
  }

  const fetched = await fetchVerdictResponse(input, config);
  if (fetched.kind !== 'ok') {
    return fetched;
  }

  const verdict = extractVerdict(fetched.content);
  if (verdict === null) {
    return {
      kind: 'error',
      reason: 'parse_failure',
      detail: `could not extract verdict JSON from: ${fetched.content.slice(0, 120)}`,
    };
  }
  return { kind: 'verdict', verdict };
};

// ---------------------------------------------------------------------------
// Internal helpers exported for testing
// ---------------------------------------------------------------------------

/** @internal — exposed for unit tests only. */
export const __internal = {
  extractVerdict,
  estimateCostUsd,
  selectTemplate,
};
