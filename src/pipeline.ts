// Pipeline: forwards a chat/completions request via the proxy, runs the
// orchestrator against the response body to produce an
// {@link OrchestratorDecision}, and — when an escalation strategy is
// configured (issue #6) — re-queries with the next model on the ladder
// until either the response passes, the ladder is exhausted, or the
// configured `maxDepth` is reached. Returns the (possibly annotated)
// final response plus a trace of what happened; the caller (server.ts)
// emits headers and the log line.
//
// Scope (v0.1, issue #6):
//   - Non-streamed `application/json` responses with 2xx status are
//     evaluated. The body is buffered, the orchestrator runs against
//     the assembled content, and — on an `escalate` decision — the
//     pipeline re-sends the same request body with the next ladder
//     model's id substituted into `model:`. Successive responses are
//     re-evaluated by the orchestrator until a stopping condition is
//     met (see EscalationTrace.stoppedReason).
//   - Streamed responses (`stream: true` or `text/event-stream`) are
//     skipped per ADR-0013. No orchestrator, no escalation.
//   - Non-2xx responses and non-JSON bodies short-circuit the
//     orchestrator and escalation alike.
//
// Intentionally NOT in this file:
//   - Body-level transparency (banner / card in response content) —
//     issue #9. This file surfaces decisions via headers only.
//   - The discarded original responses are not retained or surfaced to
//     the client, per ADR-0017. Only the final attempted response
//     reaches the client body.
//   - Max-mode and chorus-mode escalation — the dispatch here treats
//     `mode !== 'ladder'` as "no escalation" so that issues #7 and #8
//     can plug in without reshaping this file.

import { runOrchestrator } from './critic/orchestrator.js';
import { nextLadderStep } from './escalation/ladder.js';
import { forwardChatCompletion } from './proxy.js';
import type {
  EscalationConfig,
  EscalationTrace,
  OrchestratorConfig,
  OrchestratorDecision,
  ProxyTarget,
} from './types.js';

// ---------------------------------------------------------------------------
// Request inspection
// ---------------------------------------------------------------------------

interface ParsedRequest {
  readonly stream: boolean;
  readonly userPrompt: string;
  readonly model: string;
  readonly locale?: string;
  /** Parsed JSON body, or `null` if parsing failed. */
  readonly body: Record<string, unknown> | null;
}

async function parseClientRequest(request: Request): Promise<ParsedRequest> {
  let parsed: unknown = null;
  try {
    parsed = await request.clone().json();
  } catch {
    // Not JSON, or malformed. Downstream will error; orchestrator will skip.
  }

  const stream = readBoolean(parsed, 'stream');
  const userPrompt = extractUserPrompt(parsed);
  const model = readString(parsed, 'model') ?? '';
  const locale = readString(parsed, 'locale') ?? readHeaderLocale(request);
  const body =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;

  return {
    stream,
    userPrompt,
    model,
    body,
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
  const first = hdr.split(',')[0];
  if (first === undefined) return undefined;
  const tag = first.split(';')[0]?.trim();
  return tag !== undefined && tag.length > 0 ? tag : undefined;
}

function extractUserPrompt(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null) return '';
  const messages = (parsed as Record<string, unknown>)['messages'];
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== 'object' || msg === null) continue;
    const role = (msg as Record<string, unknown>)['role'];
    if (role !== 'user') continue;
    const content = (msg as Record<string, unknown>)['content'];
    if (typeof content === 'string') return content;
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
// Escalation helpers
// ---------------------------------------------------------------------------

/**
 * Build a Request object for a single escalation attempt: clone the
 * original request body, substitute the `model` field, and send it to
 * the same downstream. The resulting Request is passed to
 * {@link forwardChatCompletion} exactly like the original would be.
 *
 * All headers are preserved from the original Request so that
 * Authorization, Content-Type, and any client-supplied `X-*` headers
 * stay consistent across escalation steps.
 */
function buildEscalationRequest(
  original: Request,
  body: Record<string, unknown>,
  newModel: string,
): Request {
  const newBody = { ...body, model: newModel };
  return new Request(original.url, {
    method: original.method,
    headers: original.headers,
    body: JSON.stringify(newBody),
  });
}

// ---------------------------------------------------------------------------
// Header annotation
// ---------------------------------------------------------------------------

function annotateResponse(
  response: Response,
  decision: OrchestratorDecision,
  trace: EscalationTrace,
): Response {
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

  // Escalation trace is always emitted when a trace exists (even
  // "not_attempted" for pass-first-try responses — makes client-side
  // log parsing uniform).
  headers.set('x-turbocharger-escalation-depth', String(trace.depth));
  headers.set('x-turbocharger-escalation-stopped', trace.stoppedReason);
  if (trace.path.length > 0) {
    headers.set('x-turbocharger-escalation-path', trace.path.join(','));
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
  readonly trace: EscalationTrace;
}

/**
 * Run the full pipeline: forward the request, run the orchestrator on
 * the response, and — when configured — escalate up a ladder of models
 * until the response passes or a stopping condition is reached.
 */
export async function runPipeline(
  request: Request,
  target: ProxyTarget,
  orchestratorConfig: OrchestratorConfig,
  escalationConfig?: EscalationConfig,
): Promise<PipelineResult> {
  const parsed = await parseClientRequest(request);

  // Short-circuit paths that bypass the orchestrator entirely.
  if (parsed.stream) {
    const decision: OrchestratorDecision = { kind: 'skipped', reason: 'streaming' };
    const trace: EscalationTrace = {
      path: [],
      stoppedReason: 'not_attempted',
      depth: 0,
    };
    const downstream = await forwardChatCompletion(request, target);
    return { response: annotateResponse(downstream, decision, trace), decision, trace };
  }

  // First attempt: forward the original request.
  const firstResponse = await forwardChatCompletion(request, target);

  if (!firstResponse.ok) {
    const decision: OrchestratorDecision = {
      kind: 'skipped',
      reason: 'non_ok_status',
      detail: `${firstResponse.status} ${firstResponse.statusText}`,
    };
    const trace: EscalationTrace = {
      path: [],
      stoppedReason: 'not_attempted',
      depth: 0,
    };
    return { response: annotateResponse(firstResponse, decision, trace), decision, trace };
  }

  const contentType = firstResponse.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    const decision: OrchestratorDecision = {
      kind: 'skipped',
      reason: 'non_json_content_type',
      detail: contentType,
    };
    const trace: EscalationTrace = {
      path: [],
      stoppedReason: 'not_attempted',
      depth: 0,
    };
    return { response: annotateResponse(firstResponse, decision, trace), decision, trace };
  }

  // First response is a JSON body we can evaluate.
  let currentResponse = firstResponse;
  let currentBodyText = await currentResponse.text();
  let currentModel = parsed.model;
  let currentAssistant = parseChatCompletionBody(safeJsonParse(currentBodyText));
  let currentDecision: OrchestratorDecision = await runOrchestrator(
    buildOrchestratorInput(currentAssistant, parsed),
    orchestratorConfig,
  );

  const path: string[] = [];
  let depth = 0;
  let stoppedReason: EscalationTrace['stoppedReason'] = 'passed';

  // Escalation loop. Runs only when:
  //   - the orchestrator decided `escalate`,
  //   - an escalation config is provided,
  //   - the mode is `ladder` (other modes fall through untouched; issues #7/#8),
  //   - `maxDepth` has not yet been spent,
  //   - a next ladder step exists.
  while (
    currentDecision.kind === 'escalate' &&
    escalationConfig !== undefined &&
    escalationConfig.mode === 'ladder' &&
    depth < escalationConfig.maxDepth
  ) {
    const next = nextLadderStep(currentModel, escalationConfig.ladder);
    if (next === null) {
      // Current model isn't on the ladder, or we're at the top. Stop
      // with an informative reason so monitors can distinguish the two
      // off-ladder cases from actual ladder exhaustion.
      stoppedReason =
        escalationConfig.ladder.indexOf(currentModel) === -1
          ? 'model_not_on_ladder'
          : 'ladder_exhausted';
      break;
    }

    path.push(next);
    depth += 1;

    const reQueryRequest = buildEscalationRequest(request, parsed.body ?? {}, next);
    const reQueryResponse = await forwardChatCompletion(reQueryRequest, target);

    if (!reQueryResponse.ok) {
      // The re-query itself failed at the HTTP level. Stop the loop and
      // hand the last failing response back so the client can see what
      // happened. The decision stays `escalate`.
      currentResponse = reQueryResponse;
      currentBodyText = await reQueryResponse.text();
      stoppedReason = 'max_depth_reached';
      break;
    }

    const reQueryContentType = reQueryResponse.headers.get('content-type') ?? '';
    if (!reQueryContentType.toLowerCase().includes('application/json')) {
      // Similar handling: if the re-query returns non-JSON, stop and
      // return that body unchanged.
      currentResponse = reQueryResponse;
      currentBodyText = await reQueryResponse.text();
      stoppedReason = 'max_depth_reached';
      break;
    }

    currentResponse = reQueryResponse;
    currentBodyText = await reQueryResponse.text();
    currentAssistant = parseChatCompletionBody(safeJsonParse(currentBodyText));
    currentModel = next;
    currentDecision = await runOrchestrator(
      buildOrchestratorInput(currentAssistant, parsed),
      orchestratorConfig,
    );

    if (currentDecision.kind === 'pass') {
      stoppedReason = 'passed';
      break;
    }
    if (depth >= escalationConfig.maxDepth) {
      stoppedReason = 'max_depth_reached';
      break;
    }
  }

  // If no escalation happened at all, the stoppedReason is either
  // 'passed' (first response was adequate) or 'not_attempted' (no
  // escalation config, or decision wasn't escalate, or mode isn't
  // ladder).
  if (path.length === 0 && currentDecision.kind === 'pass') {
    stoppedReason = 'passed';
  } else if (path.length === 0 && currentDecision.kind === 'escalate') {
    stoppedReason = 'not_attempted';
  }

  const trace: EscalationTrace = { path, stoppedReason, depth };

  const reconstituted = new Response(currentBodyText, {
    status: currentResponse.status,
    statusText: currentResponse.statusText,
    headers: currentResponse.headers,
  });
  return {
    response: annotateResponse(reconstituted, currentDecision, trace),
    decision: currentDecision,
    trace,
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildOrchestratorInput(
  assistant: ParsedResponse,
  parsed: ParsedRequest,
): Parameters<typeof runOrchestrator>[0] {
  return {
    response: assistant.content,
    userPrompt: parsed.userPrompt,
    ...(assistant.finishReason !== undefined ? { finishReason: assistant.finishReason } : {}),
    ...(parsed.locale !== undefined ? { locale: parsed.locale } : {}),
  };
}
