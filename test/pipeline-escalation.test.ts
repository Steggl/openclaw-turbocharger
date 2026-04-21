import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startServer, type DecisionLogEntry, type RunningServer } from '../src/server.js';
import type {
  EscalationConfig,
  OrchestratorConfig,
  SignalWeights,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Test helpers (mirror test/pipeline.test.ts)
// ---------------------------------------------------------------------------

type MockHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
) => void | Promise<void>;

interface MockDownstream {
  readonly baseUrl: string;
  setHandler(handler: MockHandler): void;
  /** Most recent received request bodies, in order. */
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

function makeOrchestratorConfig(
  overrides: Partial<OrchestratorConfig> = {},
): OrchestratorConfig {
  return {
    threshold: 0.6,
    weights: DEFAULT_WEIGHTS,
    greyBand: [0.3, 0.6] as const,
    ...overrides,
  };
}

function makeEscalationConfig(overrides: Partial<EscalationConfig> = {}): EscalationConfig {
  return {
    mode: 'ladder',
    ladder: ['weak-model', 'mid-model', 'strong-model'],
    maxDepth: 2,
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

function readModelFromRequestBody(body: Buffer): string {
  try {
    const parsed = JSON.parse(body.toString('utf-8')) as Record<string, unknown>;
    return typeof parsed['model'] === 'string' ? parsed['model'] : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('pipeline escalation (ladder)', () => {
  let mock: MockDownstream;
  let sidecar: RunningServer;
  let sidecarBaseUrl: string;
  let logs: DecisionLogEntry[];

  beforeEach(async () => {
    mock = await startMockDownstream();
    logs = [];
    sidecar = startServer(
      { port: 0, downstreamBaseUrl: mock.baseUrl },
      {
        logger: (entry) => {
          logs.push(entry as DecisionLogEntry);
        },
        orchestratorConfig: makeOrchestratorConfig(),
        escalationConfig: makeEscalationConfig(),
      },
    );
    sidecarBaseUrl = `http://127.0.0.1:${sidecar.port}`;
  });

  afterEach(async () => {
    await sidecar.close();
    await mock.close();
  });

  it('escalates from weak-model to mid-model when first response refuses, and stops on pass', async () => {
    mock.setHandler((_req, res, body) => {
      const model = readModelFromRequestBody(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (model === 'weak-model') {
        res.end(buildChatCompletionBody("I'm sorry, but I cannot help with that."));
      } else if (model === 'mid-model') {
        res.end(
          buildChatCompletionBody(
            'Here is a clear, complete, helpful answer with concrete details and context.',
          ),
        );
      } else {
        res.end(buildChatCompletionBody('unexpected model'));
      }
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'weak-model',
        messages: [{ role: 'user', content: 'Please help.' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-turbocharger-decision')).toBe('pass');
    expect(res.headers.get('x-turbocharger-escalation-depth')).toBe('1');
    expect(res.headers.get('x-turbocharger-escalation-stopped')).toBe('passed');
    expect(res.headers.get('x-turbocharger-escalation-path')).toBe('mid-model');

    const finalBody = await res.text();
    expect(finalBody).toContain('clear, complete, helpful answer');

    // Downstream should have been hit twice: weak-model (refusal) + mid-model (pass).
    expect(mock.bodies()).toHaveLength(2);
    expect(readModelFromRequestBody(mock.bodies()[0]!)).toBe('weak-model');
    expect(readModelFromRequestBody(mock.bodies()[1]!)).toBe('mid-model');

    expect(logs[0]?.escalation_depth).toBe(1);
    expect(logs[0]?.escalation_stopped).toBe('passed');
  });

  it('stops at maxDepth=2 even when the last response is still inadequate', async () => {
    // Every model returns a refusal; the loop should hit weak → mid → strong
    // and then stop with max_depth_reached.
    mock.setHandler((_req, res, _body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(buildChatCompletionBody("I'm sorry, I cannot help with that."));
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'weak-model',
        messages: [{ role: 'user', content: 'Please help.' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-turbocharger-decision')).toBe('escalate');
    expect(res.headers.get('x-turbocharger-escalation-depth')).toBe('2');
    expect(res.headers.get('x-turbocharger-escalation-stopped')).toBe('max_depth_reached');
    expect(res.headers.get('x-turbocharger-escalation-path')).toBe('mid-model,strong-model');
    // The final body is whatever the last attempted model returned — here
    // still a refusal, since every model refuses. That is by design
    // (ADR-0017: the discarded earlier responses are not surfaced).
    expect(mock.bodies()).toHaveLength(3);
  });

  it('stops with ladder_exhausted when the top rung refuses and no further steps exist', async () => {
    // Use a ladder with only two rungs and maxDepth large enough that the
    // limiting factor is the ladder, not the depth.
    await sidecar.close();
    logs = [];
    sidecar = startServer(
      { port: 0, downstreamBaseUrl: mock.baseUrl },
      {
        logger: (entry) => {
          logs.push(entry as DecisionLogEntry);
        },
        orchestratorConfig: makeOrchestratorConfig(),
        escalationConfig: makeEscalationConfig({
          ladder: ['weak-model', 'top-model'],
          maxDepth: 5,
        }),
      },
    );
    sidecarBaseUrl = `http://127.0.0.1:${sidecar.port}`;

    mock.setHandler((_req, res, _body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(buildChatCompletionBody("I'm sorry, I cannot help with that."));
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'weak-model',
        messages: [{ role: 'user', content: 'Please help.' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-turbocharger-escalation-stopped')).toBe('ladder_exhausted');
    expect(res.headers.get('x-turbocharger-escalation-depth')).toBe('1');
    expect(res.headers.get('x-turbocharger-escalation-path')).toBe('top-model');
  });

  it('does not escalate when the first response passes', async () => {
    mock.setHandler((_req, res, _body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        buildChatCompletionBody(
          'Here is a clear, complete, helpful answer with concrete details and context.',
        ),
      );
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'weak-model',
        messages: [{ role: 'user', content: 'Explain it briefly.' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-turbocharger-decision')).toBe('pass');
    expect(res.headers.get('x-turbocharger-escalation-depth')).toBe('0');
    expect(res.headers.get('x-turbocharger-escalation-stopped')).toBe('passed');
    expect(res.headers.get('x-turbocharger-escalation-path')).toBeNull();
    expect(mock.bodies()).toHaveLength(1);
  });

  it('reports model_not_on_ladder when the client-sent model is not in the configured ladder', async () => {
    mock.setHandler((_req, res, _body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(buildChatCompletionBody("I'm sorry, I cannot help."));
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'rogue-model',
        messages: [{ role: 'user', content: 'help' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-turbocharger-decision')).toBe('escalate');
    expect(res.headers.get('x-turbocharger-escalation-stopped')).toBe('model_not_on_ladder');
    expect(res.headers.get('x-turbocharger-escalation-depth')).toBe('0');
    expect(res.headers.get('x-turbocharger-escalation-path')).toBeNull();
    expect(mock.bodies()).toHaveLength(1);
  });

  it('does not escalate when mode is not ladder (e.g. max, not yet implemented in #6)', async () => {
    await sidecar.close();
    logs = [];
    sidecar = startServer(
      { port: 0, downstreamBaseUrl: mock.baseUrl },
      {
        logger: (entry) => {
          logs.push(entry as DecisionLogEntry);
        },
        orchestratorConfig: makeOrchestratorConfig(),
        escalationConfig: makeEscalationConfig({
          mode: 'max',
          maxModel: 'unused-in-this-test',
        }),
      },
    );
    sidecarBaseUrl = `http://127.0.0.1:${sidecar.port}`;

    mock.setHandler((_req, res, _body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(buildChatCompletionBody("I'm sorry, I cannot help."));
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'weak-model',
        messages: [{ role: 'user', content: 'help' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-turbocharger-decision')).toBe('escalate');
    expect(res.headers.get('x-turbocharger-escalation-depth')).toBe('0');
    expect(res.headers.get('x-turbocharger-escalation-stopped')).toBe('not_attempted');
    expect(mock.bodies()).toHaveLength(1);
  });

  it('maxDepth: 0 disables escalation entirely', async () => {
    await sidecar.close();
    logs = [];
    sidecar = startServer(
      { port: 0, downstreamBaseUrl: mock.baseUrl },
      {
        logger: (entry) => {
          logs.push(entry as DecisionLogEntry);
        },
        orchestratorConfig: makeOrchestratorConfig(),
        escalationConfig: makeEscalationConfig({ maxDepth: 0 }),
      },
    );
    sidecarBaseUrl = `http://127.0.0.1:${sidecar.port}`;

    mock.setHandler((_req, res, _body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(buildChatCompletionBody("I'm sorry, I cannot help."));
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'weak-model',
        messages: [{ role: 'user', content: 'help' }],
      }),
    });

    expect(res.headers.get('x-turbocharger-decision')).toBe('escalate');
    expect(res.headers.get('x-turbocharger-escalation-depth')).toBe('0');
    expect(res.headers.get('x-turbocharger-escalation-stopped')).toBe('not_attempted');
    expect(mock.bodies()).toHaveLength(1);
  });
});
