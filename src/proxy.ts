// Pass-through forwarder for OpenAI-compatible chat/completions requests.
//
// Issue #2 scope: forward the inbound request to a single configured
// downstream target without any inspection or modification of the body, and
// return the downstream response unchanged. No critic, no escalation, no
// transparency annotations — those land in issues #3-#10.

import type { ProxyTarget } from './types.js';

/**
 * Hop-by-hop headers per RFC 7230 §6.1. These describe the connection
 * between two specific HTTP peers and MUST NOT be forwarded by an
 * intermediary; they are regenerated for each new connection by the runtime.
 * `host` is added on top because Node's fetch implementation sets it from
 * the target URL and a forwarded client `Host` would point at the wrong
 * authority.
 *
 * Note: RFC 7230 §6.1 also permits a sender to list additional hop-by-hop
 * header names inside the `Connection` header value. We do not parse
 * `Connection`'s value here. Revisit if a real-world downstream relies on
 * that mechanism.
 */
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function isHopByHop(name: string): boolean {
  return HOP_BY_HOP_HEADERS.has(name.toLowerCase());
}

function copyEndToEndHeaders(source: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of source) {
    if (!isHopByHop(name)) out.set(name, value);
  }
  return out;
}

/**
 * Forward an OpenAI chat/completions request to the configured downstream
 * target without modification of the request body, and return the downstream
 * response (status, end-to-end headers, body) unchanged. Streaming responses
 * (`stream: true`) are passed through as a `ReadableStream` without
 * intermediate buffering.
 *
 * Auth handling: the client's `Authorization` header is forwarded as-is when
 * present; otherwise the configured `target.apiKey` is injected as
 * `Authorization: Bearer <key>` so that the same sidecar can sit in front of
 * a local Ollama (no auth) and a hosted provider (env-supplied key) without
 * client changes.
 */
export async function forwardChatCompletion(
  request: Request,
  target: ProxyTarget,
): Promise<Response> {
  const headers = copyEndToEndHeaders(request.headers);

  // Content-Length is end-to-end, not hop-by-hop, but Node's fetch
  // implementation sets it itself from the body length. Keeping a
  // client-supplied value risks a mismatch error from undici. The body bytes
  // themselves are untouched; only the framing header is recomputed.
  headers.delete('content-length');

  if (!headers.has('authorization') && target.apiKey !== undefined) {
    headers.set('authorization', `Bearer ${target.apiKey}`);
  }

  // Buffer the request body before forwarding. Chat/completions requests are
  // small JSON bodies; the *response* is what may stream. Buffering keeps the
  // forward call out of the half-duplex streaming-body code path and lets
  // fetch set Content-Length correctly. Body bytes are passed byte-for-byte.
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.arrayBuffer() : undefined;

  const url = `${target.baseUrl}/chat/completions`;

  const downstream = await fetch(url, {
    method: request.method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });

  return new Response(downstream.body, {
    status: downstream.status,
    statusText: downstream.statusText,
    headers: copyEndToEndHeaders(downstream.headers),
  });
}
