// OpenAI-compatible HTTP server entry.
//
// Issue #2 introduced the pass-through proxy. Issue #5 added the
// optional orchestrator pipeline. Issue #6 and Issue #7 added the
// ladder and max escalation strategies. ADR-0021 refactored the
// pipeline around {@link AnswerMode}: a request is either `single`
// (proxy + orchestrator + optional escalation) or `chorus` (direct
// dispatch to an external chorus endpoint with no orchestrator
// involvement). The server wires the AnswerMode from its default
// config on each request; issue #12 will add per-request header
// overrides.

import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { loadEnvConfig } from './config/env.js';
import { runPipeline } from './pipeline.js';
import { forwardChatCompletion } from './proxy.js';
import type {
  AnswerMode,
  AppConfig,
  ChorusConfig,
  ChorusTrace,
  EscalationConfig,
  EscalationTrace,
  OrchestratorConfig,
  OrchestratorDecision,
  ProxyTarget,
  RequestLogEntry,
  RequestLogger,
} from './types.js';

export interface AppDeps {
  readonly proxyTarget: ProxyTarget;
  /** Optional logger override; defaults to one JSON object per line on stderr. */
  readonly logger?: RequestLogger;
  /**
   * Optional orchestrator configuration. When present, `single` mode
   * requests flow through {@link runPipeline}; otherwise the server
   * falls back to a pass-through proxy (issue #2 behaviour). Does not
   * affect `chorus` mode, which bypasses the orchestrator entirely
   * per ADR-0021.
   */
  readonly orchestratorConfig?: OrchestratorConfig;
  /**
   * Optional escalation configuration. Only consulted when
   * `orchestratorConfig` is also present and the request uses
   * `single` answer mode. When absent, the pipeline runs the
   * orchestrator but never re-queries — decisions are reported via
   * headers and logs only (issue #5 behaviour).
   */
  readonly escalationConfig?: EscalationConfig;
  /**
   * Optional chorus configuration. Required for requests using
   * `chorus` answer mode; unused otherwise. Per ADR-0021 chorus is
   * a parallel answer paradigm, not an escalation strategy, so its
   * configuration lives separately from `escalationConfig`.
   */
  readonly chorusConfig?: ChorusConfig;
  /**
   * Default AnswerMode for requests that do not override via header
   * (issue #12). When absent, `single` is assumed.
   */
  readonly defaultAnswerMode?: AnswerMode;
}

/**
 * Per-request log entry with optional orchestrator, escalation, and
 * chorus fields. Extends {@link RequestLogEntry} without changing
 * its base shape so that non-pipeline requests keep emitting the
 * narrower object.
 */
export interface DecisionLogEntry extends RequestLogEntry {
  readonly answer_mode?: AnswerMode;
  readonly decision?: OrchestratorDecision['kind'];
  readonly decision_reason?: string;
  readonly escalation_depth?: number;
  readonly escalation_stopped?: EscalationTrace['stoppedReason'];
  readonly escalation_path?: readonly string[];
  readonly chorus_outcome?: ChorusTrace['outcome'];
  readonly chorus_detail?: string;
}

const defaultLogger: RequestLogger = (entry) => {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
};

// Minimal orchestrator config used when chorus mode is active without
// a separately configured orchestrator. The pipeline's chorus path
// does not invoke the orchestrator, but the current runPipeline
// signature still requires an OrchestratorConfig; this stub is the
// least-invasive way to satisfy that until issue #11 introduces a
// proper config schema.
const CHORUS_NOOP_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  threshold: 0,
  weights: {
    refusal: 0,
    truncation: 0,
    repetition: 0,
    empty: 0,
    tool_error: 0,
    syntax_error: 0,
  },
  greyBand: [0, 0] as const,
};

/**
 * Build a Hono app wired against the given proxy target. Exported so
 * tests can construct an app pointing at in-process mocks without
 * touching environment variables.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const log = deps.logger ?? defaultLogger;
  const defaultAnswerMode: AnswerMode = deps.defaultAnswerMode ?? 'single';

  app.post('/v1/chat/completions', async (c) => {
    const start = Date.now();
    let status = 0;
    let answerMode: AnswerMode | undefined;
    let decisionKind: OrchestratorDecision['kind'] | undefined;
    let decisionReason: string | undefined;
    let escalationDepth: number | undefined;
    let escalationStopped: EscalationTrace['stoppedReason'] | undefined;
    let escalationPath: readonly string[] | undefined;
    let chorusOutcome: ChorusTrace['outcome'] | undefined;
    let chorusDetail: string | undefined;

    try {
      if (defaultAnswerMode === 'chorus') {
        // Chorus mode: orchestratorConfig is not required; pipeline
        // dispatches directly to the chorus endpoint.
        answerMode = 'chorus';
        const orchestratorConfig = deps.orchestratorConfig ?? CHORUS_NOOP_ORCHESTRATOR_CONFIG;
        const result = await runPipeline({
          request: c.req.raw,
          target: deps.proxyTarget,
          orchestratorConfig,
          answerMode: 'chorus',
          ...(deps.chorusConfig !== undefined ? { chorusConfig: deps.chorusConfig } : {}),
        });
        status = result.response.status;
        if (result.mode === 'chorus') {
          chorusOutcome = result.trace.outcome;
          if (result.trace.detail !== undefined) {
            chorusDetail = result.trace.detail;
          }
        }
        return result.response;
      }

      if (deps.orchestratorConfig !== undefined) {
        // Single mode with orchestrator.
        answerMode = 'single';
        const result = await runPipeline({
          request: c.req.raw,
          target: deps.proxyTarget,
          orchestratorConfig: deps.orchestratorConfig,
          answerMode: 'single',
          ...(deps.escalationConfig !== undefined
            ? { escalationConfig: deps.escalationConfig }
            : {}),
        });
        status = result.response.status;
        if (result.mode === 'single') {
          decisionKind = result.decision.kind;
          if (result.decision.kind === 'escalate' || result.decision.kind === 'skipped') {
            decisionReason = result.decision.reason;
          }
          escalationDepth = result.trace.depth;
          escalationStopped = result.trace.stoppedReason;
          if (result.trace.path.length > 0) {
            escalationPath = result.trace.path;
          }
        }
        return result.response;
      }

      // No orchestrator, pass-through proxy (issue #2).
      const downstream = await forwardChatCompletion(c.req.raw, deps.proxyTarget);
      status = downstream.status;
      return downstream;
    } catch (err) {
      status = 502;
      const message = err instanceof Error ? err.message : 'unknown error';
      return c.json(
        {
          error: {
            message: `downstream request failed: ${message}`,
            type: 'upstream_unreachable',
          },
        },
        502,
      );
    } finally {
      const entry: DecisionLogEntry = {
        ts: new Date().toISOString(),
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status,
        latency_ms: Date.now() - start,
        ...(answerMode !== undefined ? { answer_mode: answerMode } : {}),
        ...(decisionKind !== undefined ? { decision: decisionKind } : {}),
        ...(decisionReason !== undefined ? { decision_reason: decisionReason } : {}),
        ...(escalationDepth !== undefined ? { escalation_depth: escalationDepth } : {}),
        ...(escalationStopped !== undefined ? { escalation_stopped: escalationStopped } : {}),
        ...(escalationPath !== undefined ? { escalation_path: escalationPath } : {}),
        ...(chorusOutcome !== undefined ? { chorus_outcome: chorusOutcome } : {}),
        ...(chorusDetail !== undefined ? { chorus_detail: chorusDetail } : {}),
      };
      log(entry);
    }
  });

  return app;
}

/** Handle returned by {@link startServer} for graceful shutdown. */
export interface RunningServer {
  readonly port: number;
  close(): Promise<void>;
}

export function startServer(
  config: AppConfig = loadEnvConfig(),
  deps?: Omit<AppDeps, 'proxyTarget'>,
): RunningServer {
  const proxyTarget: ProxyTarget = {
    baseUrl: config.downstreamBaseUrl,
    ...(config.downstreamApiKey !== undefined ? { apiKey: config.downstreamApiKey } : {}),
  };
  const app = createApp({
    proxyTarget,
    ...(deps?.logger !== undefined ? { logger: deps.logger } : {}),
    ...(deps?.orchestratorConfig !== undefined
      ? { orchestratorConfig: deps.orchestratorConfig }
      : {}),
    ...(deps?.escalationConfig !== undefined ? { escalationConfig: deps.escalationConfig } : {}),
    ...(deps?.chorusConfig !== undefined ? { chorusConfig: deps.chorusConfig } : {}),
    ...(deps?.defaultAnswerMode !== undefined ? { defaultAnswerMode: deps.defaultAnswerMode } : {}),
  });

  const server = serve({
    fetch: app.fetch,
    port: config.port,
  });

  const address = server.address();
  const boundPort = address !== null && typeof address === 'object' ? address.port : config.port;

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

const isDirectRun = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const config = loadEnvConfig();
  const handle = startServer(config);
  process.stderr.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      event: 'listen',
      port: handle.port,
      downstream: config.downstreamBaseUrl,
    })}\n`,
  );

  const shutdown = (signal: string): void => {
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), event: 'shutdown', signal })}\n`,
    );
    handle
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
