// Chorus dispatch — forwards a client request to an external chorus
// endpoint. Per ADR-0021, chorus is an {@link AnswerMode}, not an
// escalation strategy: users opt in to chorus because they want
// multi-model consensus with bias transparency and minority reports,
// not as a reactive fallback when adequacy fails.
//
// Scope (v0.1, after ADR-0021 refactor):
//   - {@link dispatchChorus} POSTs the original request body plus
//     per-request context surfaced via `X-Turbocharger-*` headers to
//     the configured endpoint. It is a drop-in OpenAI client with a
//     caller-controlled timeout and an enumerated error surface.
//   - Per ADR-0020 (retained under ADR-0021) the dispatch is
//     hard-fail: no silent fallback to ladder/max/a baked-in default.
//     A missing, unreachable, timing-out, or error-responding
//     endpoint surfaces a specific {@link ChorusDispatchResult}.
//   - The pipeline (src/pipeline.ts) owns when chorus runs
//     (AnswerMode === 'chorus') and how the result reaches the
//     client; this module only performs the one HTTP call.
//
// Intentionally NOT in this file:
//   - The chorus logic itself (parallel dispatch, synthesis, minority
//     reports) — those belong to `openclaw-chorus`.
//   - Re-evaluating chorus output with the orchestrator. Per ADR-0021
//     chorus answers are not put through the adequacy critic; chorus
//     is itself the adequacy mechanism.
//   - Retrying failed dispatches. One attempt, then the pipeline
//     returns the classified error to the client via the normal
//     response pathway.

import {
  DEFAULT_CHORUS_TIMEOUT_MS,
  type ChorusConfig,
  type ChorusDispatchResult,
} from '../types.js';

export interface ChorusDispatchInput {
  /** Raw body bytes of the client's original chat/completions request. */
  readonly bodyBytes: string;
  /** Forwarded headers from the client's request. */
  readonly clientHeaders: Headers;
  /**
   * Context headers produced by the caller: decision reason,
   * aggregate score, ladder configuration, etc. Added on top of the
   * client headers so the chorus server can make use of them without
   * the client having to pass them explicitly.
   */
  readonly contextHeaders: Record<string, string>;
  /** Optional `fetch` override for tests. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Send the client's original request to the configured chorus
 * endpoint and return the response or a classified error.
 */
export async function dispatchChorus(
  config: ChorusConfig,
  input: ChorusDispatchInput,
): Promise<ChorusDispatchResult> {
  if (config.endpoint === undefined || config.endpoint.length === 0) {
    return {
      kind: 'error',
      reason: 'endpoint_not_set',
      detail: 'ChorusConfig.endpoint is required when AnswerMode is "chorus"',
    };
  }

  const fetchFn: typeof fetch = input.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_CHORUS_TIMEOUT_MS;

  // Build the outbound headers. Hop-by-hop headers from the client
  // (per RFC 7230) are stripped to match the behaviour of the
  // regular proxy path; content-type is preserved because the body
  // bytes are forwarded verbatim.
  const outboundHeaders = new Headers();
  for (const [name, value] of input.clientHeaders.entries()) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'host') continue;
    if (lower === 'content-length') continue;
    outboundHeaders.set(name, value);
  }
  for (const [name, value] of Object.entries(input.contextHeaders)) {
    outboundHeaders.set(name, value);
  }
  if (!outboundHeaders.has('content-type')) {
    outboundHeaders.set('content-type', 'application/json');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(config.endpoint, {
      method: 'POST',
      headers: outboundHeaders,
      body: input.bodyBytes,
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        kind: 'error',
        reason: 'non_ok_status',
        detail: `chorus endpoint responded with HTTP ${response.status} ${response.statusText}`,
      };
    }
    return { kind: 'ok', response };
  } catch (err) {
    // AbortError (timeout) is distinguishable by its name across
    // runtimes; other errors are classified as "unreachable" which
    // covers DNS failures, connection refused, TLS errors, etc.
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        kind: 'error',
        reason: 'timeout',
        detail: `chorus dispatch timed out after ${timeoutMs}ms`,
      };
    }
    const message = err instanceof Error ? err.message : 'unknown error';
    return {
      kind: 'error',
      reason: 'unreachable',
      detail: `chorus dispatch failed: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Same hop-by-hop header list as the regular proxy. Kept local here
// to avoid importing from proxy.ts (which would couple the two
// modules more tightly than necessary).
const HOP_BY_HOP = new Set<string>([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
