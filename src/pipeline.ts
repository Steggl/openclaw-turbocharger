// Pipeline: forwards a chat/completions request via the proxy, then runs
// the orchestrator against the response body to produce an
// {@link OrchestratorDecision}. Returns the (possibly annotated)
// response and the decision; the caller (server.ts) emits headers and
// the log line.
//
// Scope (v0.1, issue #5):
//   - Non-streamed `application/json` responses with 2xx status are
//     evaluated. The body is buffered, the orchestrator runs against
//     the assembled content, and the decision is surfaced via
//     X-Turbocharger-* headers on the response that is returned to the
//     client. Body bytes are unchanged.
//   - Streamed responses (`stream: true` or `text/event-stream`) are
//     skipped per ADR-0013. The orchestrator returns
//     { kind: 'skipped', reason: 'streaming' }; the response is
//     forwarded unchanged and no decision headers are added.
//   - Non-2xx responses are skipped (the downstream already signalled
//     failure; the critic has no role), as are non-JSON bodies.
//
// Intentionally NOT in this file:
//   - The actual escalation machinery. Issue #5 only decides; issue #6
//     (ladder/max) acts on the decision.
//   - Config loading. The pipeline takes an OrchestratorConfig as
//     input; how that config is built (env, YAML, Zod schema) is
//     issue #11.

import { forwardChatCompletion } from './proxy.js';
import { runOrchestrator } from './critic/orchestrator.js';
import type { OrchestratorConfig, OrchestratorDecision, ProxyTarget } from './types.js';

// ---------------------------------------------------------------------------
// Request inspection
// ---------------------------------------------------------------------------

interface ParsedRequest {
  readonly stream: boolean;
  readonly userPrompt: string;
  readonly locale?: string;
}

/**
 * Inspect the client's chat/completions request body to decide whether
 * streaming was requested, extract the last user message for the
 * orchestrator, and pick up an optional locale hint.
 *
 * The original Request is not consumed: the caller owns the original,
 * we clone for inspection so that {@link forwardChatCompletion} can
 * still read the body bytes.
 */
async function parseClientRequest(request: Request): Promise<ParsedRequest> {
  let parsed: unknown = null;
  try {
    parsed = await request.clone().json();
  } catch {
    // Not JSON, or malformed. Proceed with safe defaults; the downstream
    // will return an HTTP error and the orchestrator will skip it.
  }

  const stream = readBoolean(parsed, 'stream');
  const userPrompt = extractUserPrompt(parsed);
  const locale = readString(parsed, 'locale') ?? readHeaderLocale(request);

  return {
    stream,
    userPrompt,
    ...(locale !== undefined ? { locale } : {}),
  };
}

function readBoolean(obj: unknown, key: string): boolean {
  if (typeof obj !== 'object' || obj === null) return false;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'boolean' ? v : false;
}

function readString(obj: unknown, key: string): string | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

function readHeaderLocale(request: Request): string | undefined {
  const hdr = request.headers.get('accept-language');
  if (hdr === null || hdr.length === 0) return undefined;
  // Simplest possible parse: take the first tag, strip any q-factor.
  const first = hdr.split(',')[0];
  if (first === undefined) return undefined;
  const tag = first.split(';')[0]?.trim();
  return tag !== undefined && tag.length > 0 ? tag : undefined;
}

function extractUserPrompt(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null) return '';
  const messages = (parsed as Record<string, unknown>)['messages'];
  if (!Array.isArray(messages)) return '';
  // Walk from the end, find the last message with role === 'user'.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== 'object' || msg === null) continue;
    const role = (msg as Record<string, unknown>)['role'];
    if (role !== 'user') continue;
    const content = (msg as Record<string, unknown>)['content'];
    if (typeof content === 'string') return content;
    // OpenAI supports array-of-parts content; extract text parts only.
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (typeof part === 'object' && part !== null) {
          const text = (part as Record<string, unknown>)['text'];
          if (typeof text === 'string') parts.push(text);
        }
      }
      return parts.join('\n');
    }
    return '';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Response inspection
// ---------------------------------------------------------------------------

interface ParsedResponse {
  readonly content: string;
  readonly finishReason?: string;
}

/** Extract the assistant content and finish_reason from a non-streamed
 * chat/completions JSON body. Returns empty strings for anything
 * unexpected — the orchestrator's empty/short detector catches those
 * naturally. */
function parseChatCompletionBody(json: unknown): ParsedResponse {
  if (typeof json !== 'object' || json === null) return { content: '' };
  const choices = (json as Record<string, unknown>)['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return { content: '' };
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return { content: '' };
  const message = (first as Record<string, unknown>)['message'];
  const finishReason = (first as Record<string, unknown>)['finish_reason'];
  const rawContent =
    typeof message === 'object' && message !== null
      ? (message as Record<string, unknown>)['content']
      : undefined;
  const content = typeof rawContent === 'string' ? rawContent : '';
  return {
    content,
    ...(typeof finishReason === 'string' ? { finishReason } : {}),
  };
}

// ---------------------------------------------------------------------------
// Header annotation
// ---------------------------------------------------------------------------

/** Attach X-Turbocharger-* headers describing the decision. Header
 * values never contain newlines or control characters. The reason
 * strings from individual signals are condensed to a comma-separated
 * category list to keep header sizes modest. */
function annotateResponse(response: Response, decision: OrchestratorDecision): Response {
  const headers = new Headers(response.headers);

  switch (decision.kind) {
    case 'pass': {
      headers.set('x-turbocharger-decision', 'pass');
      headers.set('x-turbocharger-aggregate', decision.aggregate.toFixed(3));
      if (decision.signals.length > 0) {
        headers.set('x-turbocharger-signals', decision.signals.map((s) => s.category).join(','));
      }
      if (decision.verdict !== undefined) {
        headers.set('x-turbocharger-verdict', decision.verdict.verdict);
        headers.set('x-turbocharger-verdict-confidence', decision.verdict.confidence.toFixed(3));
      }
      break;
    }
    case 'escalate': {
      headers.set('x-turbocharger-decision', 'escalate');
      headers.set('x-turbocharger-reason', decision.reason);
      headers.set('x-turbocharger-aggregate', decision.aggregate.toFixed(3));
      if (decision.signals.length > 0) {
        headers.set('x-turbocharger-signals', decision.signals.map((s) => s.category).join(','));
      }
      if (decision.verdict !== undefined) {
        headers.set('x-turbocharger-verdict', decision.verdict.verdict);
        headers.set('x-turbocharger-verdict-confidence', decision.verdict.confidence.toFixed(3));
      }
      break;
    }
    case 'skipped': {
      headers.set('x-turbocharger-decision', 'skipped');
      headers.set('x-turbocharger-reason', decision.reason);
      break;
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface PipelineResult {
  readonly response: Response;
  readonly decision: OrchestratorDecision;
}

/**
 * Run the full pipeline: forward the request, then run the orchestrator
 * against the response if it is evaluable (non-streamed JSON, 2xx).
 * Returns the (possibly annotated) response and the decision.
 *
 * Streams and error responses skip the orchestrator by design:
 * - Streaming responses (ADR-0013) are not inspected in v0.1.
 * - Non-2xx responses are passed through with no critic involvement.
 */
export async function runPipeline(
  request: Request,
  target: ProxyTarget,
  orchestratorConfig: OrchestratorConfig,
): Promise<PipelineResult> {
  const parsed = await parseClientRequest(request);
  const downstream = await forwardChatCompletion(request, target);

  // Short-circuit paths that bypass the orchestrator entirely. The
  // response body is already a ReadableStream in these cases; we must
  // not consume it, or the client will see an empty body.
  if (parsed.stream) {
    const decision: OrchestratorDecision = { kind: 'skipped', reason: 'streaming' };
    return { response: annotateResponse(downstream, decision), decision };
  }
  if (!downstream.ok) {
    const decision: OrchestratorDecision = {
      kind: 'skipped',
      reason: 'non_ok_status',
      detail: `${downstream.status} ${downstream.statusText}`,
    };
    return { response: annotateResponse(downstream, decision), decision };
  }

  const contentType = downstream.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    const decision: OrchestratorDecision = {
      kind: 'skipped',
      reason: 'non_json_content_type',
      detail: contentType,
    };
    return { response: annotateResponse(downstream, decision), decision };
  }

  // Buffer the response body. Chat-completion JSON payloads are small;
  // the streaming case above handles the one that could be large.
  const bodyText = await downstream.text();

  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(bodyText);
  } catch {
    // Downstream claimed JSON but produced something we can't parse.
    // Forward the body bytes unchanged and skip the orchestrator.
    const decision: OrchestratorDecision = {
      kind: 'skipped',
      reason: 'non_json_content_type',
      detail: 'JSON parse failure',
    };
    const reconstituted = new Response(bodyText, {
      status: downstream.status,
      statusText: downstream.statusText,
      headers: downstream.headers,
    });
    return { response: annotateResponse(reconstituted, decision), decision };
  }

  const assistant = parseChatCompletionBody(bodyJson);
  const decision = await runOrchestrator(
    {
      response: assistant.content,
      userPrompt: parsed.userPrompt,
      ...(assistant.finishReason !== undefined ? { finishReason: assistant.finishReason } : {}),
      ...(parsed.locale !== undefined ? { locale: parsed.locale } : {}),
    },
    orchestratorConfig,
  );

  // Rebuild the response with the original body text (so the client
  // gets the exact bytes the downstream sent).
  const reconstituted = new Response(bodyText, {
    status: downstream.status,
    statusText: downstream.statusText,
    headers: downstream.headers,
  });
  return { response: annotateResponse(reconstituted, decision), decision };
}
