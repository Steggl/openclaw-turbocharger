// Shared type surface. The brief (§9) treats this file as the single source of
// truth so that proxy / critic / escalation / transparency stay structurally
// consistent. Issue #2 introduces the minimal surface needed for the
// pass-through proxy; later issues extend it.

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
