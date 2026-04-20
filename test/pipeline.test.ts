import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../src/server.js';
import type {
  DecisionLogEntry,
  OrchestratorConfig,
  SignalWeights,
} from '../src/types.js';

// Re-declare here because src/server.ts does not re-export DecisionLogEntry
// via a type-only barrel.
// NOTE: Keep this in sync with the DecisionLogEntry in src/server.ts.
type LogEntry = DecisionLogEntry;

// ---------------------------------------------------------------------------
// Test helpers (mirrors proxy.test.ts for consistency)
// ---------------------------------------------------------------------------

type MockHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
) => void | Promise<void>;

interface MockDownstream {
  readonly baseUrl: string;
  setHandler(handler: MockHandler): void;
  close(): Promise<void>;
}

async function startMockDownstream(): Promise<MockDownstream> {
  let handler: MockHandler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
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

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
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
// Suite
// ---------------------------------------------------------------------------

describe('pipeline', () => {
  let mock: MockDownstream;
  let sidecar: RunningServer;
  let sidecarBaseUrl: string;
  let logs: LogEntry[];

  beforeEach(async () => {
    mock = await startMockDownstream();
    logs = [];
    sidecar = startServer(
      { port: 0, downstreamBaseUrl: mock.baseUrl },
      {
        logger: (entry) => {
          logs.push(entry as LogEntry);
        },
        orchestratorConfig: makeConfig(),
      },
    );
    sidecarBaseUrl = `http://127.0.0.1:${sidecar.port}`;
  });

  afterEach(async () => {
    await sidecar.close();
    await mock.close();
  });

  it('annotates a pass response with X-Turbocharger-Decision: pass', async () => {
    const body = buildChatCompletionBody(
      'Here is a clear, complete, helpful answer with concrete details and context.',
    );
    mock.setHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-mini',
        messages: [{ role: 'user', content: 'Explain it briefly.' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-turbocharger-decision')).toBe('pass');
    const aggregate = res.headers.get('x-turbocharger-aggregate');
    expect(aggregate).not.toBeNull();
    expect(Number(aggregate)).toBeLessThan(0.3);
    // Body must be byte-for-byte preserved.
    expect(await res.text()).toBe(body);
    expect(logs[0]?.decision).toBe('pass');
  });

  it('annotates an escalate response with reason=hard_signals when a refusal fires', async () => {
    const body = buildChatCompletionBody("I'm sorry, but I cannot help with that.");
    mock.setHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-mini',
        messages: [{ role: 'user', content: 'Please help with something.' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-turbocharger-decision')).toBe('escalate');
    expect(res.headers.get('x-turbocharger-reason')).toBe('hard_signals');
    const signalsHeader = res.headers.get('x-turbocharger-signals');
    expect(signalsHeader).not.toBeNull();
    expect(signalsHeader!.split(',')).toContain('refusal');
    expect(await res.text()).toBe(body);
    expect(logs[0]?.decision).toBe('escalate');
    expect(logs[0]?.decision_reason).toBe('hard_signals');
  });

  it('skips streaming responses with decision=skipped, reason=streaming', async () => {
    // Whatever the mock sends is fine — the pipeline should short-circuit
    // on the request body's stream: true and not inspect the response.
    mock.setHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-mini',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-turbocharger-decision')).toBe('skipped');
    expect(res.headers.get('x-turbocharger-reason')).toBe('streaming');
    expect(logs[0]?.decision).toBe('skipped');
    expect(logs[0]?.decision_reason).toBe('streaming');
  });

  it('skips non-2xx downstream responses with reason=non_ok_status', async () => {
    mock.setHandler((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"server_error"}');
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(500);
    expect(res.headers.get('x-turbocharger-decision')).toBe('skipped');
    expect(res.headers.get('x-turbocharger-reason')).toBe('non_ok_status');
  });

  it('skips non-JSON downstream responses with reason=non_json_content_type', async () => {
    mock.setHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('plain text body');
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-turbocharger-decision')).toBe('skipped');
    expect(res.headers.get('x-turbocharger-reason')).toBe('non_json_content_type');
    expect(await res.text()).toBe('plain text body');
  });

  it('preserves the original response body bytes on the pass path', async () => {
    // Use a body with non-ASCII content and a field order that would
    // round-trip differently through JSON.parse / JSON.stringify, so any
    // reformatting is visible.
    const body = JSON.stringify({
      id: 'chatcmpl-utf',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Die Antwort ist klar, vollständig und enthält Details: ä-ö-ü-ß-€.',
          },
          finish_reason: 'stop',
        },
      ],
    });
    mock.setHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-mini',
        messages: [{ role: 'user', content: 'Erkläre es kurz.' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
  });
});
