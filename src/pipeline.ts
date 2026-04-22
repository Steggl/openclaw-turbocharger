// Pipeline: the sidecar's request processing path. Routes a client
// request according to the configured {@link AnswerMode}:
//
//   - `single` (default): forwards to the configured {@link ProxyTarget},
//     runs the orchestrator on the response, and — when an escalation
//     strategy is configured (issue #6) — re-queries with the next model
//     on the ladder until either the response passes, the ladder is
//     exhausted, or `maxDepth` is reached. Issues #5, #6, #7.
//   - `chorus` (per ADR-0021): forwards directly to the configured
//     chorus endpoint, bypassing the proxy and the orchestrator. The
//     chorus endpoint is expected to perform its own multi-model
//     synthesis with bias transparency; re-running the adequacy
//     critic on top would be double judgement.
//
// Returns the (possibly annotated) final response plus a trace of what
// happened. For `single` mode the trace is an {@link EscalationTrace};
// for `chorus` mode it's a {@link ChorusTrace}. The caller (server.ts)
// emits headers and the log line.
//
// Scope (v0.1):
//   - Non-streamed `application/json` responses with 2xx status are
//     evaluated in `single` mode. Streamed responses (`stream: true`
//     or `text/event-stream`) are skipped per ADR-0013.
//   - Non-2xx responses and non-JSON bodies short-circuit the
//     orchestrator and escalation alike.
//   - `chorus` mode does not re-evaluate the chorus response; chorus
//     IS the adequacy mechanism.
//
// Intentionally NOT in this file:
//   - Body-level transparency (banner / card in response content) —
//     issue #9. This file surfaces decisions via headers only.
//   - Per ADR-0017 the discarded original responses in escalation
//     loops are not retained or surfaced to the client.
//   - Per-request AnswerMode override via X-Turbocharger-Answer-Mode
//     header (issue #12). The pipeline takes answerMode as an
//     argument; how the caller decides is the caller's concern.

import { runOrchestrator } from './critic/orchestrator.js';
import { nextLadderStep } from './escalation/ladder.js';
import { maxStep } from './escalation/max.js';
import { dispatchChorus } from './chorus/dispatch.js';
import { forwardChatCompletion } from './proxy.js';
import type {
  AnswerMode,
  ChorusConfig,
  ChorusTrace,
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

function annotateSingleResponse(
  response: Response,
  decision: OrchestratorDecision,
  trace: EscalationTrace,
): Response {
  const headers = new Headers(response.headers);
  headers.set('x-turbocharger-answer-mode', 'single');

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

function annotateChorusResponse(response: Response, trace: ChorusTrace): Response {
  const headers = new Headers(response.headers);
  headers.set('x-turbocharger-answer-mode', 'chorus');
  headers.set('x-turbocharger-chorus-outcome', trace.outcome);
  if (trace.detail !== undefined) {
    headers.set('x-turbocharger-chorus-detail', trace.detail);
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

export interface SinglePipelineResult {
  readonly mode: 'single';
  readonly response: Response;
  readonly decision: OrchestratorDecision;
  readonly trace: EscalationTrace;
}

export interface ChorusPipelineResult {
  readonly mode: 'chorus';
  readonly response: Response;
  readonly trace: ChorusTrace;
}

export type PipelineResult = SinglePipelineResult | ChorusPipelineResult;

export interface PipelineInput {
  readonly request: Request;
  readonly target: ProxyTarget;
  readonly orchestratorConfig: OrchestratorConfig;
  readonly answerMode: AnswerMode;
  readonly chorusConfig?: ChorusConfig;
  readonly escalationConfig?: EscalationConfig;
}

/**
 * Run the pipeline. Dispatches on `answerMode`: `single` goes through
 * the proxy + orchestrator + optional escalation path, `chorus` goes
 * directly to the chorus endpoint without orchestrator involvement.
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  if (input.answerMode === 'chorus') {
    return runChorusPipeline(input);
  }
  return runSinglePipeline(input);
}

async function runChorusPipeline(input: PipelineInput): Promise<ChorusPipelineResult> {
  const { request, chorusConfig } = input;

  if (chorusConfig === undefined) {
    // AnswerMode was set to 'chorus' but no ChorusConfig was wired.
    // Return a classified error response; the pipeline does not fall
    // back to single-mode silently per ADR-0021's hard-fail policy.
    const body = JSON.stringify({
      error: {
        type: 'chorus_endpoint_not_set',
        message: 'chorus answer mode requires a ChorusConfig; none was provided',
      },
    });
    const response = new Response(body, {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'content-type': 'application/json' },
    });
    const trace: ChorusTrace = {
      outcome: 'endpoint_not_set',
      detail: 'ChorusConfig missing on AppDeps',
    };
    return { mode: 'chorus', response: annotateChorusResponse(response, trace), trace };
  }

  // Read the raw body so we can forward it verbatim.
  let bodyBytes = '{}';
  try {
    bodyBytes = await request.clone().text();
  } catch {
    // Leave the default; chorus will likely 4xx and we'll classify.
  }

  const dispatchResult = await dispatchChorus(chorusConfig, {
    bodyBytes,
    clientHeaders: request.headers,
    contextHeaders: {},
  });

  if (dispatchResult.kind === 'ok') {
    const trace: ChorusTrace = { outcome: 'ok' };
    return {
      mode: 'chorus',
      response: annotateChorusResponse(dispatchResult.response, trace),
      trace,
    };
  }

  // Classified error. Return an error response with the trace.
  const errorBody = JSON.stringify({
    error: {
      type: `chorus_${dispatchResult.reason}`,
      message: dispatchResult.detail,
    },
  });
  const status = dispatchResult.reason === 'timeout' ? 504 : 502;
  const response = new Response(errorBody, {
    status,
    statusText: dispatchResult.reason === 'timeout' ? 'Gateway Timeout' : 'Bad Gateway',
    headers: { 'content-type': 'application/json' },
  });
  const trace: ChorusTrace = {
    outcome: dispatchResult.reason,
    detail: dispatchResult.detail,
  };
  return { mode: 'chorus', response: annotateChorusResponse(response, trace), trace };
}

async function runSinglePipeline(input: PipelineInput): Promise<SinglePipelineResult> {
  const { request, target, orchestratorConfig, escalationConfig } = input;
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
    return {
      mode: 'single',
      response: annotateSingleResponse(downstream, decision, trace),
      decision,
      trace,
    };
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
    return {
      mode: 'single',
      response: annotateSingleResponse(firstResponse, decision, trace),
      decision,
      trace,
    };
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
    return {
      mode: 'single',
      response: annotateSingleResponse(firstResponse, decision, trace),
      decision,
      trace,
    };
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
  let stoppedReason: EscalationTrace['stoppedReason'] = 'not_attempted';

  if (currentDecision.kind === 'pass') {
    stoppedReason = 'passed';
  }

  // Escalation loop. Runs only when:
  //   - the orchestrator decided `escalate`,
  //   - an escalation config is provided,
  //   - the mode is `ladder` or `max`,
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
      currentResponse = reQueryResponse;
      currentBodyText = await reQueryResponse.text();
      stoppedReason = 'max_depth_reached';
      break;
    }

    const reQueryContentType = reQueryResponse.headers.get('content-type') ?? '';
    if (!reQueryContentType.toLowerCase().includes('application/json')) {
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
    mode: 'single',
    response: annotateSingleResponse(reconstituted, currentDecision, trace),
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
