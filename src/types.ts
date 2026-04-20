// Shared type surface. The brief (§9) treats this file as the single source of
// truth so that proxy / critic / escalation / transparency stay structurally
// consistent. Issue #2 introduces the minimal surface needed for the
// pass-through proxy; issue #3 adds the hard-signal detection surface;
// later issues extend further.

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
