// OpenAI-compatible HTTP server entry.
//
// Issue #2 introduced the pass-through proxy. Issue #5 adds an optional
// orchestrator pipeline in front of the proxy: when `pipelineConfig` is
// present in {@link AppDeps}, the request flows through
// {@link runPipeline} instead of directly through
// {@link forwardChatCompletion}, and the resulting decision is surfaced
// in response headers and in the per-request log line.

import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { loadEnvConfig } from './config/env.js';
import { runPipeline } from './pipeline.js';
import { forwardChatCompletion } from './proxy.js';
import type {
  AppConfig,
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
   * Optional orchestrator configuration. When present, the server runs
   * the full {@link runPipeline} (proxy + orchestrator) and adds
   * X-Turbocharger-* response headers and a decision field to the log
   * line. When absent, the server falls back to the pass-through proxy
   * behaviour from issue #2.
   */
  readonly orchestratorConfig?: OrchestratorConfig;
}

/**
 * Per-request log entry with an optional orchestrator decision field.
 * Extends {@link RequestLogEntry} without modifying its narrow shape.
 */
export interface DecisionLogEntry extends RequestLogEntry {
  readonly decision?: OrchestratorDecision['kind'];
  readonly decision_reason?: string;
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
    try {
      if (deps.orchestratorConfig !== undefined) {
        const result = await runPipeline(c.req.raw, deps.proxyTarget, deps.orchestratorConfig);
        status = result.response.status;
        decisionKind = result.decision.kind;
        if (result.decision.kind === 'escalate' || result.decision.kind === 'skipped') {
          decisionReason = result.decision.reason;
        }
        return result.response;
      }
      const downstream = await forwardChatCompletion(c.req.raw, deps.proxyTarget);
      status = downstream.status;
      return downstream;
    } catch (err) {
      // The fetch call itself failed (downstream unreachable, DNS failure,
      // connection reset before any HTTP response). Surface as 502 with a
      // diagnostic body. HTTP-level errors from a reachable downstream go
      // through the success branch above and are forwarded verbatim — the
      // sidecar never invents its own error status when the downstream
      // produced one.
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
      };
      log(entry);
    }
  });

  return app;
}

/** Handle returned by {@link startServer} for graceful shutdown. */
export interface RunningServer {
  /** The address the server is listening on, for tests that bind port 0. */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Start the sidecar HTTP server on the configured port. Returns a handle
 * with a `close()` for graceful shutdown.
 */
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

// Self-execution guard: running `node dist/server.js` boots the server;
// importing the module from another file does not. Standard Node ESM
// idiom for "is this the entry point".
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
