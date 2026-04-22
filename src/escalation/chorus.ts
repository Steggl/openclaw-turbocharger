// Chorus escalation strategy — interface stub (issue #8, ADR-0020).
//
// Chorus dispatches the client's original request to an external,
// OpenAI-compatible endpoint that is expected to fan out to multiple
// models, synthesise a combined answer, and return it as a standard
// chat-completions response. Full chorus logic lives in the separate
// `openclaw-chorus` project; this module only reserves the HTTP
// connection point and the error surface.
//
// Scope (v0.1, issue #8):
//   - {@link dispatchChorus} POSTs the original request body (plus
//     per-request context surfaced via `X-Turbocharger-*` headers)
//     to the configured endpoint. It is a drop-in OpenAI client with
//     a caller-controlled timeout and an enumerated error surface.
//   - Per ADR-0020, the dispatch is hard-fail: no fallback to
//     ladder, max, or any provider default. A missing, unreachable,
//     timing-out, or error-responding endpoint is surfaced as a
//     specific {@link ChorusDispatchResult}.`error` with a dedicated
//     {@link EscalationTrace.stoppedReason}.
//   - The pipeline (src/pipeline.ts) owns the decision of when to
//     dispatch to chorus and how to thread the result back into the
//     response; this module only performs the one HTTP call.
//
// Intentionally NOT in this file:
//   - The chorus logic itself (parallel dispatch, synthesis, minority
//     reports) — those belong to `openclaw-chorus`.
//   - Re-evaluating chorus output with the orchestrator. Per ADR-0020
//     the chorus response is forwarded as-is; the assumption is that
//     the chorus server already incorporates adequacy judgement into
//     its synthesis.
//   - Retrying failed dispatches. One attempt, then the pipeline
//     stops.

import {
  DEFAULT_CHORUS_TIMEOUT_MS,
  type ChorusDispatchResult,
  type EscalationConfig,
} from '../types.js';

export interface ChorusDispatchInput {
  /** Raw body bytes of the client's original chat/completions request. */
  readonly bodyBytes: string;
  /** Forwarded headers from the client's request. */
  readonly clientHeaders: Headers;
  /**
   * Context headers produced by the pipeline: decision reason,
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
  config: EscalationConfig,
  input: ChorusDispatchInput,
): Promise<ChorusDispatchResult> {
  if (config.chorusEndpoint === undefined || config.chorusEndpoint.length === 0) {
    return {
      kind: 'error',
      reason: 'endpoint_not_set',
      detail: 'EscalationConfig.chorusEndpoint is required when mode is "chorus"',
    };
  }

  const fetchFn: typeof fetch = input.fetchImpl ?? fetch;
  const timeoutMs = config.chorusTimeoutMs ?? DEFAULT_CHORUS_TIMEOUT_MS;

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
    const response = await fetchFn(config.chorusEndpoint, {
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
