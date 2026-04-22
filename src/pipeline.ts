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
import { maxStep } from './escalation/max.js';
import { dispatchChorus } from './escalation/chorus.js';
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
    parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;

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
  // Default stoppedReason is 'not_attempted', which is correct for
  // every case where the escalation loop does not run at all: no
  // escalation config, non-ladder mode, maxDepth === 0, or the very
  // first orchestrator decision was escalate but the loop condition
  // still prevents re-query. The up-front 'pass' check below promotes
  // it to 'passed' when the first response was already adequate; every
  // branch inside the loop that stops early explicitly sets its own
  // final value.
  let stoppedReason: EscalationTrace['stoppedReason'] = 'not_attempted';

  if (currentDecision.kind === 'pass') {
    stoppedReason = 'passed';
  }

  // Chorus dispatch (issue #8). Runs only when:
  //   - the orchestrator decided `escalate`,
  //   - an escalation config is provided,
  //   - the mode is `chorus`,
  //   - `maxDepth` is > 0 (keeps the kill switch uniform with ladder
  //     and max; per ADR-0018 and ADR-0019 maxDepth=0 means "no
  //     escalation for any mode").
  //
  // Unlike the ladder/max loop, chorus goes to a different HTTP
  // endpoint (not the configured ProxyTarget) and its response is
  // forwarded verbatim — no orchestrator re-evaluation. Per ADR-0020
  // the dispatch is hard-fail: any error classifies the stop reason
  // and the original inadequate response is returned to the client.
  if (
    currentDecision.kind === 'escalate' &&
    escalationConfig !== undefined &&
    escalationConfig.mode === 'chorus' &&
    escalationConfig.maxDepth > 0
  ) {
    const chorusResult = await dispatchChorus(escalationConfig, {
      bodyBytes: currentBodyText.length > 0 ? getOriginalRequestBody(parsed) : '{}',
      clientHeaders: request.headers,
      contextHeaders: buildChorusContextHeaders(currentDecision, escalationConfig),
    });

    if (chorusResult.kind === 'ok') {
      const chorusBodyText = await chorusResult.response.text();
      const chorusContentType = chorusResult.response.headers.get('content-type') ?? '';
      if (chorusContentType.toLowerCase().includes('application/json')) {
        // The chorus response is forwarded as-is. We re-run the
        // orchestrator so the decision on the response is honest —
        // but we do not act on an `escalate` decision here because
        // chorus has no further step to take. The decision is
        // reported via headers, the body is the chorus answer.
        const chorusAssistant = parseChatCompletionBody(safeJsonParse(chorusBodyText));
        const chorusDecision = await runOrchestrator(
          buildOrchestratorInput(chorusAssistant, parsed),
          orchestratorConfig,
        );
        currentDecision = chorusDecision;
        currentBodyText = chorusBodyText;
        currentResponse = chorusResult.response;
        path.push('chorus');
        depth = 1;
        stoppedReason = chorusDecision.kind === 'pass' ? 'passed' : 'max_depth_reached';
      } else {
        // Chorus returned non-JSON. Forward the bytes as-is, record
        // the stop reason, and keep the original decision (so the
        // client still sees that escalation was attempted).
        currentBodyText = chorusBodyText;
        currentResponse = chorusResult.response;
        path.push('chorus');
        depth = 1;
        stoppedReason = 'max_depth_reached';
      }
    } else {
      // Classified chorus error. Keep the original (inadequate)
      // response body for the client and record the specific stop
      // reason for monitors and the transparency layer.
      switch (chorusResult.reason) {
        case 'endpoint_not_set':
          stoppedReason = 'chorus_endpoint_not_set';
          break;
        case 'unreachable':
          stoppedReason = 'chorus_unreachable';
          break;
        case 'timeout':
          stoppedReason = 'chorus_timeout';
          break;
        case 'non_ok_status':
          stoppedReason = 'chorus_non_ok_status';
          break;
      }
    }
  }

  // Escalation loop. Runs only when:
  //   - the orchestrator decided `escalate`,
  //   - an escalation config is provided,
  //   - the mode is `ladder` or `max` (chorus falls through; issue #8),
  //   - `maxDepth` has not yet been spent,
  //   - a next target model can be resolved (strategy-specific).
  while (
    currentDecision.kind === 'escalate' &&
    escalationConfig !== undefined &&
    (escalationConfig.mode === 'ladder' || escalationConfig.mode === 'max') &&
    depth < escalationConfig.maxDepth
  ) {
    // Strategy dispatch: resolve the next target model. Ladder walks
    // one rung; max returns the configured maxModel (once) or null
    // when it is unset. Per ADR-0019, a null from maxStep is a
    // configuration error, not a silent fallback to another strategy.
    let next: string | null;
    if (escalationConfig.mode === 'max') {
      next = maxStep(escalationConfig);
      if (next === null) {
        stoppedReason = 'max_model_not_set';
        break;
      }
    } else {
      next = nextLadderStep(currentModel, escalationConfig.ladder);
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
    // Max mode does exactly one re-query per invocation: after the
    // orchestrator evaluates the re-queried response, there is no
    // further target to escalate to. If the decision is still
    // `escalate`, we stop with max_depth_reached (semantically:
    // "we used the one jump we had").
    if (escalationConfig.mode === 'max') {
      stoppedReason = 'max_depth_reached';
      break;
    }
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

/**
 * Serialise the client's original request body for forwarding to the
 * chorus endpoint. If parsing failed upstream (parsed.body is null),
 * fall back to an empty JSON object — the chorus server will return
 * a 4xx which we will classify as non_ok_status.
 */
function getOriginalRequestBody(parsed: ParsedRequest): string {
  if (parsed.body === null) return '{}';
  return JSON.stringify(parsed.body);
}

/**
 * Build the per-request context headers the chorus endpoint receives
 * on top of the client's forwarded headers. Per ADR-0020 the chorus
 * protocol is OpenAI-compatible; the context is provided through
 * `X-Turbocharger-*` headers so a chorus server can optionally make
 * use of it without requiring a non-standard request body shape.
 */
function buildChorusContextHeaders(
  decision: OrchestratorDecision,
  config: EscalationConfig,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (decision.kind === 'escalate') {
    headers['x-turbocharger-reason'] = decision.reason;
    headers['x-turbocharger-aggregate'] = decision.aggregate.toFixed(3);
    if (decision.signals.length > 0) {
      headers['x-turbocharger-signals'] = decision.signals.map((s) => s.category).join(',');
    }
    if (decision.verdict !== undefined) {
      headers['x-turbocharger-verdict'] = decision.verdict.verdict;
      headers['x-turbocharger-verdict-confidence'] = decision.verdict.confidence.toFixed(3);
    }
  }
  if (config.ladder.length > 0) {
    headers['x-turbocharger-ladder'] = config.ladder.join(',');
  }
  if (config.maxModel !== undefined && config.maxModel.length > 0) {
    headers['x-turbocharger-max-model'] = config.maxModel;
  }
  return headers;
}
