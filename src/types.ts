// Shared type surface. The brief (§9) treats this file as the single source of
// truth so that proxy / critic / escalation / transparency stay structurally
// consistent. Issue #2 introduces the minimal surface needed for the
// pass-through proxy; issue #3 adds the hard-signal detection surface;
// issue #4 adds the LLM-critic surface; issue #5 adds the orchestrator and
// pipeline surfaces; issue #6 adds the escalation surface; later issues
// extend further.

/**
 * Effective configuration for a running sidecar process.
 *
 * Issue #2 reads this from environment variables (see {@link
 * ../config/env.ts}). Issue #11 will introduce a Zod-validated config file
 * shape and merge env / file / defaults; the resolved object satisfies this
 * interface.
 */
export interface AppConfig {
  /** TCP port the sidecar listens on. */
  readonly port: number;
  /**
   * OpenAI-compatible base URL of the downstream target. Examples:
   * `http://localhost:11434/v1` (Ollama), `https://api.openai.com/v1`,
   * `https://api.anthropic.com/v1`. The proxy appends `/chat/completions`
   * when forwarding; trailing slashes on the base URL are normalized away
   * at load time.
   */
  readonly downstreamBaseUrl: string;
  /**
   * Optional bearer token to inject as `Authorization: Bearer <key>` when
   * the upstream client did not supply its own `Authorization` header. Lets
   * the same sidecar serve a local Ollama (no auth) and a hosted provider
   * (env-supplied key) without client changes.
   */
  readonly downstreamApiKey?: string;
}

/** What the proxy needs to know about its forwarding target. */
export interface ProxyTarget {
  readonly baseUrl: string;
  readonly apiKey?: string;
}

/** One log line per request. Emitted as a single JSON object on stderr. */
export interface RequestLogEntry {
  readonly ts: string;
  readonly method: string;
  readonly path: string;
  /** HTTP status returned to the client. `0` if the request never produced one. */
  readonly status: number;
  readonly latency_ms: number;
}

export type RequestLogger = (entry: RequestLogEntry) => void;

// ---------------------------------------------------------------------------
// Critic — hard-signal detection (issue #3)
// ---------------------------------------------------------------------------

/**
 * One piece of evidence that a response may be inadequate. Detectors in
 * {@link ../critic/hard-signals.ts} emit these; the orchestrator
 * (issue #5) aggregates them via noisy-OR per ADR-0006 and compares the
 * result to a configurable threshold.
 */
export interface Signal {
  readonly category: SignalCategory;
  /**
   * Continuous confidence in `[0, 1]`. `0` means no evidence, `1` means
   * certainty. Detectors use intermediate values to express "weak but
   * present" evidence that would be lost by a boolean fire/no-fire output
   * — exactly the case ADR-0006 cites as the motivation for the noisy-OR
   * aggregator.
   */
  readonly confidence: number;
  /** Short human-readable reason, suitable for transparency banner / card. */
  readonly reason: string;
}

export type SignalCategory =
  | 'refusal'
  | 'truncation'
  | 'repetition'
  | 'empty'
  | 'tool_error'
  | 'syntax_error';

/**
 * Input bundle passed to every hard-signal detector. A detector reads
 * whichever fields it needs and returns a {@link Signal} or `null`.
 *
 * Kept deliberately small: the orchestrator (issue #5) may enrich it
 * later with per-request metadata (e.g. user-specified locale override,
 * trace id for the audit log from ADR-0007), but a detector should never
 * need provider-specific fields.
 */
export interface DetectorInput {
  /** The assembled response text content as the client would see it. */
  readonly response: string;
  /** The user's most recent message, for context-dependent checks. */
  readonly userPrompt: string;
  /**
   * OpenAI `finish_reason` from the upstream response, when the provider
   * supplied one. Common values: `"stop"`, `"length"`, `"tool_calls"`,
   * `"content_filter"`.
   */
  readonly finishReason?: string;
  /**
   * BCP-47 locale hint used for locale-aware pattern matching (refusal
   * phrases, sentence terminators). Defaults to `"en"` when absent.
   */
  readonly locale?: string;
}

/** Signature every hard-signal detector must satisfy. */
export type HardSignalDetector = (input: DetectorInput) => Signal | null;

// ---------------------------------------------------------------------------
// Critic — LLM-critic (issue #4)
// ---------------------------------------------------------------------------

/**
 * A verdict delivered by the LLM-critic. Per ADR-0011 this is NOT mixed
 * into the hard-signal noisy-OR pool; the orchestrator (issue #5) compares
 * it against the escalation threshold as an independent piece of evidence.
 *
 * The `verdict` field is the coarse yes/no answer, and `confidence`
 * expresses how certain the critic is. Escalation fires when
 * `verdict === 'fail' && confidence >= threshold`; `pass` verdicts never
 * escalate regardless of their confidence.
 */
export interface LlmVerdict {
  readonly verdict: 'pass' | 'fail';
  /** Continuous confidence in `[0, 1]`. */
  readonly confidence: number;
  /** Short reason produced by the critic, suitable for the transparency layer. */
  readonly reason: string;
}

/**
 * Input passed to the LLM-critic. Matches {@link DetectorInput} in shape
 * for the fields the critic needs, but does not include `finishReason` —
 * that is hard-signal territory and has no role in the critic's judgement.
 */
export interface LlmCriticInput {
  readonly response: string;
  readonly userPrompt: string;
  /** BCP-47 locale hint; selects the prompt template. Defaults to `"en"`. */
  readonly locale?: string;
}

/**
 * Token pricing for a critic model, used by the pre-call budget check.
 * When not supplied, the budget check is skipped and the critic runs
 * regardless of the configured budget. Per ADR-0012, v0.1 has no defaults
 * here — the caller must opt in to budget enforcement.
 */
export interface ModelPricing {
  /** USD cost per 1,000,000 input tokens. */
  readonly inputUsdPerMillion: number;
  /** USD cost per 1,000,000 output tokens. */
  readonly outputUsdPerMillion: number;
}

/**
 * Configuration bundle for a single LLM-critic invocation. Per ADR-0012,
 * there are no silent defaults for `baseUrl` or `model`; callers must
 * supply them explicitly. Budget enforcement is optional and requires
 * both `budgetUsd` and `pricing` to be set.
 */
export interface LlmCriticConfig {
  /** OpenAI-compatible base URL, e.g. `http://localhost:11434/v1`. */
  readonly baseUrl: string;
  /** Model slug as understood by the downstream endpoint. */
  readonly model: string;
  /** Optional bearer token for the critic endpoint. */
  readonly apiKey?: string;
  /** Per-request timeout in milliseconds. Defaults to 30_000. */
  readonly timeoutMs?: number;
  /** Per-request USD ceiling. Only enforced when `pricing` is also set. */
  readonly budgetUsd?: number;
  /** Pricing for cost estimation. When absent, budget is not enforced. */
  readonly pricing?: ModelPricing;
  /**
   * Optional `fetch` implementation for testing. Defaults to the global
   * `fetch` in Node 22. Exposed here so tests can inject mocks without
   * polluting the global scope.
   */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Discriminated result of an LLM-critic invocation. The three kinds are:
 *
 * - `verdict`: the critic returned a usable verdict.
 * - `skipped`: the critic did not run (budget exceeded, or explicitly
 *   disabled by the caller).
 * - `error`: the critic ran but produced no usable verdict (network
 *   failure, HTTP error, parse failure, timeout, empty response).
 *
 * Per the brief's "no silent fallbacks that hide failures" principle,
 * the orchestrator (issue #5) never converts `error` or `skipped` into
 * an implicit `pass`. Callers decide case by case.
 */
export type LlmCriticResult =
  | { readonly kind: 'verdict'; readonly verdict: LlmVerdict }
  | { readonly kind: 'skipped'; readonly reason: 'over_budget' | 'disabled' }
  | {
      readonly kind: 'error';
      readonly reason: 'timeout' | 'network' | 'http' | 'empty' | 'parse_failure';
      readonly detail: string;
    };

/** Signature of the LLM-critic callable. */
export type LlmCritic = (
  input: LlmCriticInput,
  config: LlmCriticConfig,
) => Promise<LlmCriticResult>;

// ---------------------------------------------------------------------------
// Orchestrator and pipeline (issue #5)
// ---------------------------------------------------------------------------

/**
 * Per-category weight for the hard-signal noisy-OR aggregation. Each
 * weight is a multiplier applied to the signal's confidence before the
 * noisy-OR combination:
 * `P(inadequate) = 1 - prod(1 - weight_i * confidence_i)`.
 * A weight of `0` disables the category. Weights outside [0, 1] are
 * clamped by the aggregator.
 */
export type SignalWeights = Readonly<Record<SignalCategory, number>>;

/**
 * Configuration passed to {@link runOrchestrator}. No Zod validation
 * yet — issue #11 introduces the full config schema. Sensible defaults
 * are documented but the orchestrator does not supply them; callers
 * must construct a complete config.
 */
export interface OrchestratorConfig {
  /**
   * Escalation threshold: when the noisy-OR aggregate crosses this (or
   * the LLM-critic's fail confidence does, per ADR-0011), the decision
   * is `escalate`. Default recommendation: 0.6 (see ADR-0006).
   */
  readonly threshold: number;
  /** Per-category weights for the hard-signal aggregator. */
  readonly weights: SignalWeights;
  /**
   * Grey band [lower, upper) in which the LLM-critic, if configured,
   * is invoked. Outside the band, the critic is skipped. Per ADR-0010
   * the default is `[0.30, 0.60)`.
   */
  readonly greyBand: readonly [number, number];
  /**
   * Optional LLM-critic invocation. When absent, the orchestrator runs
   * hard-signals only. When present, the callable is invoked when the
   * noisy-OR aggregate lands in the grey band.
   */
  readonly llmCritic?: {
    readonly run: LlmCritic;
    readonly config: LlmCriticConfig;
  };
}

/**
 * Input passed to {@link runOrchestrator}. Same fields as
 * {@link DetectorInput}, plus the finish_reason pass-through.
 */
export interface OrchestratorInput {
  readonly response: string;
  readonly userPrompt: string;
  readonly finishReason?: string;
  readonly locale?: string;
}

/**
 * Discriminated decision produced by {@link runOrchestrator}. The kind
 * drives what the pipeline does next:
 *
 * - `pass`: no escalation. Response is forwarded unchanged.
 * - `escalate`: adequacy fell short. Escalation machinery (issue #6)
 *   will act on this; in v0.1 it is only reported via headers and log.
 * - `skipped`: orchestrator was not able to run (e.g. streaming response
 *   per ADR-0013). Pipeline forwards unchanged and logs the skip.
 *
 * The `signals`, `aggregate`, and `verdict` fields let the transparency
 * layer (ADR-0007) and the audit log render a rich report without
 * re-running anything.
 */
export type OrchestratorDecision =
  | {
      readonly kind: 'pass';
      readonly signals: readonly Signal[];
      readonly aggregate: number;
      readonly verdict?: LlmVerdict;
    }
  | {
      readonly kind: 'escalate';
      readonly reason: 'hard_signals' | 'llm_verdict';
      readonly signals: readonly Signal[];
      readonly aggregate: number;
      readonly verdict?: LlmVerdict;
    }
  | {
      readonly kind: 'skipped';
      readonly reason: 'streaming' | 'non_ok_status' | 'non_json_content_type';
      readonly detail?: string;
    };

/** Signature of the orchestrator callable. */
export type Orchestrator = (
  input: OrchestratorInput,
  config: OrchestratorConfig,
) => Promise<OrchestratorDecision>;

// ---------------------------------------------------------------------------
// Escalation (issue #6)
// ---------------------------------------------------------------------------

/**
 * Mode of escalation selected when an {@link OrchestratorDecision} is
 * `kind: 'escalate'`.
 *
 * - `ladder`: step up a user-configured chain of model IDs one rung at a
 *   time. Issue #6.
 * - `max`: jump directly to a single configured maximum-performance
 *   model. Issue #7 (stub in #6).
 * - `chorus`: dispatch to an external chorus endpoint for multi-model
 *   consensus. Issue #8 (interface only; no implementation in v0.1).
 */
export type EscalationMode = 'ladder' | 'max' | 'chorus';

/**
 * Configuration for the escalation strategy. Per ADR-0016, the ladder is
 * a flat list of model IDs addressed against the single configured
 * downstream {@link ProxyTarget}; per-model baseUrls are deliberately
 * out of scope for v0.1.
 *
 * Per ADR-0018 the default for `maxDepth` is 2 (one initial attempt plus
 * up to two escalations, i.e. the client sees an answer from at most the
 * third ladder step). Callers must supply it explicitly; there are no
 * silent defaults at this layer.
 */
export interface EscalationConfig {
  readonly mode: EscalationMode;
  /**
   * Ordered list of model IDs from weakest to strongest. The ladder's
   * semantics: the client-supplied `model` field in the request body
   * locates the current position; escalation advances to the next
   * entry. When the current model is not on the ladder, or the ladder
   * is exhausted, {@link nextLadderStep} returns `null` and the
   * pipeline preserves the last attempted response.
   */
  readonly ladder: readonly string[];
  /**
   * Optional max-mode target. Required when `mode === 'max'`; unused
   * in `ladder` mode. Issue #7 makes this operational.
   */
  readonly maxModel?: string;
  /**
   * Optional chorus endpoint. Required when `mode === 'chorus'`;
   * unused in other modes. Issue #8 makes this operational.
   */
  readonly chorusEndpoint?: string;
  /**
   * Maximum number of escalation steps. `0` disables escalation
   * (decisions are reported but no re-query happens). `1` allows one
   * escalation and then freezes on whatever that produced. Per ADR-0018
   * the recommended default is `2`.
   */
  readonly maxDepth: number;
}

/**
 * Result of one escalation attempt, as recorded on the response headers
 * and in the log line. Distinct from {@link OrchestratorDecision}: the
 * orchestrator decides whether an escalation is warranted; the
 * escalation result records what happened when the pipeline acted on
 * that decision.
 */
export interface EscalationTrace {
  /** The model ID each escalation step targeted, in order. */
  readonly path: readonly string[];
  /** Why the pipeline stopped escalating. */
  readonly stoppedReason:
    | 'passed'
    | 'max_depth_reached'
    | 'ladder_exhausted'
    | 'model_not_on_ladder'
    | 'max_model_not_set'
    | 'not_attempted';
  /** How many re-queries actually ran (0 when the first response passed). */
  readonly depth: number;
}
