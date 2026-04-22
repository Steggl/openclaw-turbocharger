import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startServer, type DecisionLogEntry, type RunningServer } from '../src/server.js';
import type { ChorusConfig, OrchestratorConfig, SignalWeights } from '../src/types.js';

// ---------------------------------------------------------------------------
// Mock downstream (reused shape from test/pipeline-escalation.test.ts)
// ---------------------------------------------------------------------------

type MockHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
) => void | Promise<void>;

interface MockDownstream {
  readonly baseUrl: string;
  setHandler(handler: MockHandler): void;
  bodies(): readonly Buffer[];
  close(): Promise<void>;
}

async function startMockDownstream(): Promise<MockDownstream> {
  let handler: MockHandler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  };
  const seen: Buffer[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push(body);
      Promise.resolve(handler(req, res, body)).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(`mock-error: ${String(err)}`);
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    setHandler(h) {
      handler = h;
    },
    bodies() {
      return seen;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

const DEFAULT_WEIGHTS: SignalWeights = {
  refusal: 1,
  truncation: 1,
  repetition: 1,
  empty: 1,
  tool_error: 1,
  syntax_error: 1,
};

function makeOrchestratorConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    threshold: 0.6,
    weights: DEFAULT_WEIGHTS,
    greyBand: [0.3, 0.6] as const,
    ...overrides,
  };
}

function buildChatCompletionBody(content: string, finishReason = 'stop'): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finishReason,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Chorus AnswerMode (ADR-0021)
// ---------------------------------------------------------------------------

describe('pipeline (answerMode: chorus)', () => {
  let downstream: MockDownstream;
  let chorus: MockDownstream;
  let sidecar: RunningServer;
  let sidecarBaseUrl: string;
  let logs: DecisionLogEntry[];

  beforeEach(async () => {
    downstream = await startMockDownstream();
    chorus = await startMockDownstream();
    logs = [];
  });

  afterEach(async () => {
    await sidecar.close();
    await downstream.close();
    await chorus.close();
  });

  function startSidecar(chorusConfig?: ChorusConfig): void {
    sidecar = startServer(
      { port: 0, downstreamBaseUrl: downstream.baseUrl },
      {
        logger: (entry) => {
          logs.push(entry as DecisionLogEntry);
        },
        orchestratorConfig: makeOrchestratorConfig(),
        defaultAnswerMode: 'chorus',
        ...(chorusConfig !== undefined ? { chorusConfig } : {}),
      },
    );
    sidecarBaseUrl = `http://127.0.0.1:${sidecar.port}`;
  }

  it('dispatches directly to chorus, bypassing the orchestrator and downstream', async () => {
    startSidecar({ endpoint: `${chorus.baseUrl}/chat/completions` });

    chorus.setHandler((_req, res, _body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        buildChatCompletionBody(
          'Here is a chorus-synthesised answer with bias transparency and minority reports.',
        ),
      );
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'irrelevant-in-chorus-mode',
        messages: [{ role: 'user', content: 'What are the risks of x?' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-turbocharger-answer-mode')).toBe('chorus');
    expect(res.headers.get('x-turbocharger-chorus-outcome')).toBe('ok');
    // No orchestrator headers in chorus mode.
    expect(res.headers.get('x-turbocharger-decision')).toBeNull();
    expect(res.headers.get('x-turbocharger-escalation-depth')).toBeNull();

    const body = await res.text();
    expect(body).toContain('bias transparency and minority reports');

    // Downstream was not touched; chorus was.
    expect(downstream.bodies()).toHaveLength(0);
    expect(chorus.bodies()).toHaveLength(1);

    expect(logs[0]?.answer_mode).toBe('chorus');
    expect(logs[0]?.chorus_outcome).toBe('ok');
  });

  it('returns endpoint_not_set when chorusConfig is missing', async () => {
    startSidecar(); // No chorusConfig wired.

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'x',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get('x-turbocharger-answer-mode')).toBe('chorus');
    expect(res.headers.get('x-turbocharger-chorus-outcome')).toBe('endpoint_not_set');
    expect(downstream.bodies()).toHaveLength(0);
    expect(chorus.bodies()).toHaveLength(0);
  });

  it('surfaces non_ok_status when chorus endpoint responds 500', async () => {
    startSidecar({ endpoint: `${chorus.baseUrl}/chat/completions` });

    chorus.setHandler((_req, res, _body) => {
      res.writeHead(500);
      res.end('chorus crashed');
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'x',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(502);
    expect(res.headers.get('x-turbocharger-answer-mode')).toBe('chorus');
    expect(res.headers.get('x-turbocharger-chorus-outcome')).toBe('non_ok_status');
    expect(chorus.bodies()).toHaveLength(1);
  });

  it('surfaces unreachable when chorus endpoint cannot be reached', async () => {
    // Point to a closed port on localhost — ECONNREFUSED.
    const closedServer = createServer();
    await new Promise<void>((resolve) => closedServer.listen(0, '127.0.0.1', resolve));
    const addr = closedServer.address() as AddressInfo;
    const closedUrl = `http://127.0.0.1:${addr.port}/chat/completions`;
    await new Promise<void>((resolve, reject) => {
      closedServer.close((err) => (err ? reject(err) : resolve()));
    });

    startSidecar({ endpoint: closedUrl });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'x',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(502);
    expect(res.headers.get('x-turbocharger-answer-mode')).toBe('chorus');
    expect(res.headers.get('x-turbocharger-chorus-outcome')).toBe('unreachable');
  });
});
