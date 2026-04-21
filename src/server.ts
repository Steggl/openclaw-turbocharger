// OpenAI-compatible HTTP server entry.
//
// Issue #2 introduced the pass-through proxy. Issue #5 added the optional
// orchestrator pipeline. Issue #6 extends the same pipeline with a
// ladder-escalation strategy: when the orchestrator decides `escalate`,
// the pipeline loops through the configured ladder of models until the
// response passes, the ladder is exhausted, or the configured maxDepth
// is reached. All three are opt-in via AppDeps; the server falls back
// to pass-through forwarding when orchestratorConfig is absent.

import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { loadEnvConfig } from './config/env.js';
import { runPipeline } from './pipeline.js';
import { forwardChatCompletion } from './proxy.js';
import type {
  AppConfig,
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
   * Optional orchestrator configuration. When present, requests flow
   * through {@link runPipeline}; otherwise the server is a pure
   * pass-through proxy (issue #2 behaviour).
   */
  readonly orchestratorConfig?: OrchestratorConfig;
  /**
   * Optional escalation configuration. Only consulted when
   * `orchestratorConfig` is also present. When absent, the pipeline runs
   * the orchestrator but never re-queries — decisions are reported via
   * headers and logs only (issue #5 behaviour).
   */
  readonly escalationConfig?: EscalationConfig;
}

/**
 * Per-request log entry with optional orchestrator and escalation fields.
 * Extends {@link RequestLogEntry} without changing its base shape so that
 * non-pipeline requests keep emitting the narrower object.
 */
export interface DecisionLogEntry extends RequestLogEntry {
  readonly decision?: OrchestratorDecision['kind'];
  readonly decision_reason?: string;
  readonly escalation_depth?: number;
  readonly escalation_stopped?: EscalationTrace['stoppedReason'];
  readonly escalation_path?: readonly string[];
}

const defaultLogger: RequestLogger = (entry) => {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
};

/**
 * Build a Hono app wired against the given proxy target. Exported so tests
 * can construct an app pointing at an in-process mock downstream without
 * touching environment variables.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const log = deps.logger ?? defaultLogger;

  app.post('/v1/chat/completions', async (c) => {
    const start = Date.now();
    let status = 0;
    let decisionKind: OrchestratorDecision['kind'] | undefined;
    let decisionReason: string | undefined;
    let escalationDepth: number | undefined;
    let escalationStopped: EscalationTrace['stoppedReason'] | undefined;
    let escalationPath: readonly string[] | undefined;
    try {
      if (deps.orchestratorConfig !== undefined) {
        const result = await runPipeline(
          c.req.raw,
          deps.proxyTarget,
          deps.orchestratorConfig,
          deps.escalationConfig,
        );
        status = result.response.status;
        decisionKind = result.decision.kind;
        if (result.decision.kind === 'escalate' || result.decision.kind === 'skipped') {
          decisionReason = result.decision.reason;
        }
        escalationDepth = result.trace.depth;
        escalationStopped = result.trace.stoppedReason;
        if (result.trace.path.length > 0) {
          escalationPath = result.trace.path;
        }
        return result.response;
      }
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
        ...(decisionKind !== undefined ? { decision: decisionKind } : {}),
        ...(decisionReason !== undefined ? { decision_reason: decisionReason } : {}),
        ...(escalationDepth !== undefined ? { escalation_depth: escalationDepth } : {}),
        ...(escalationStopped !== undefined ? { escalation_stopped: escalationStopped } : {}),
        ...(escalationPath !== undefined ? { escalation_path: escalationPath } : {}),
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
    ...(deps?.escalationConfig !== undefined
      ? { escalationConfig: deps.escalationConfig }
      : {}),
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
