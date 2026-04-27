import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startServer, type DecisionLogEntry, type RunningServer } from '../src/server.js';
import type {
  EscalationConfig,
  OrchestratorConfig,
  SignalWeights,
  TransparencyConfig,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Test helpers (mirror test/pipeline-escalation.test.ts)
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

function makeEscalationConfig(overrides: Partial<EscalationConfig> = {}): EscalationConfig {
  return {
    mode: 'ladder',
    ladder: ['weak-model', 'mid-model', 'strong-model'],
    maxDepth: 2,
    ...overrides,
  };
}

function buildChatCompletionBody(content: string): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
  });
}

function extractContent(bodyText: string): string {
  const obj = JSON.parse(bodyText) as {
    choices: ReadonlyArray<{ message: { content: string } }>;
  };
  return obj.choices[0]!.message.content;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('pipeline transparency (banner)', () => {
  let mock: MockDownstream;
  let sidecar: RunningServer;
  let sidecarBaseUrl: string;
  let logs: DecisionLogEntry[];

  beforeEach(async () => {
    mock = await startMockDownstream();
    logs = [];
  });

  afterEach(async () => {
    await sidecar.close();
    await mock.close();
  });

  function startSidecar(transparencyConfig?: TransparencyConfig): void {
    sidecar = startServer(
      { port: 0, downstreamBaseUrl: mock.baseUrl },
      {
        logger: (entry) => {
          logs.push(entry as DecisionLogEntry);
        },
        orchestratorConfig: makeOrchestratorConfig(),
        escalationConfig: makeEscalationConfig(),
        ...(transparencyConfig !== undefined ? { transparencyConfig } : {}),
      },
    );
    sidecarBaseUrl = `http://127.0.0.1:${sidecar.port}`;
  }

  it('prepends a banner to the assistant content when escalation succeeded', async () => {
    startSidecar({ mode: 'banner' });

    mock.setHandler((_req, res, body) => {
      const parsed = JSON.parse(body.toString('utf-8')) as { model: string };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (parsed.model === 'weak-model') {
        res.end(buildChatCompletionBody("I'm sorry, but I cannot help with that."));
      } else {
        res.end(
          buildChatCompletionBody(
            'Here is a clear, complete, helpful answer with concrete details and context.',
          ),
        );
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
    const bodyText = await res.text();
    const content = extractContent(bodyText);
    expect(content.startsWith('[turbocharger] ')).toBe(true);
    expect(content).toContain('stronger model was used');
    // Original content is preserved AFTER the banner.
    expect(content).toContain('clear, complete, helpful answer');

    expect(logs[0]?.transparency_mode).toBe('banner');
  });

  it('does not prepend a banner when the first response passes', async () => {
    startSidecar({ mode: 'banner' });

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
    const content = extractContent(await res.text());
    expect(content.startsWith('[turbocharger]')).toBe(false);
    expect(content.startsWith('Here is a clear')).toBe(true);
  });

  it('does not prepend a banner when transparency mode is silent', async () => {
    startSidecar({ mode: 'silent' });

    mock.setHandler((_req, res, body) => {
      const parsed = JSON.parse(body.toString('utf-8')) as { model: string };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (parsed.model === 'weak-model') {
        res.end(buildChatCompletionBody("I'm sorry, but I cannot help with that."));
      } else {
        res.end(
          buildChatCompletionBody(
            'Here is a clear, complete, helpful answer with concrete details and context.',
          ),
        );
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

    const content = extractContent(await res.text());
    expect(content.startsWith('[turbocharger]')).toBe(false);
    // Headers still report the escalation
    expect(res.headers.get('x-turbocharger-decision')).toBe('pass');
    expect(res.headers.get('x-turbocharger-escalation-stopped')).toBe('passed');

    expect(logs[0]?.transparency_mode).toBe('silent');
  });

  it('does not prepend a banner when no transparencyConfig is configured (silent default)', async () => {
    startSidecar(); // No transparencyConfig — silent default.

    mock.setHandler((_req, res, body) => {
      const parsed = JSON.parse(body.toString('utf-8')) as { model: string };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (parsed.model === 'weak-model') {
        res.end(buildChatCompletionBody("I'm sorry, but I cannot help."));
      } else {
        res.end(buildChatCompletionBody('A clear, helpful answer with details and context.'));
      }
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'weak-model',
        messages: [{ role: 'user', content: 'help' }],
      }),
    });

    const content = extractContent(await res.text());
    expect(content.startsWith('[turbocharger]')).toBe(false);
    expect(logs[0]?.transparency_mode).toBeUndefined();
  });

  it('emits banner with not_attempted reason when escalation is disabled (maxDepth=0)', async () => {
    sidecar = startServer(
      { port: 0, downstreamBaseUrl: mock.baseUrl },
      {
        logger: (entry) => {
          logs.push(entry as DecisionLogEntry);
        },
        orchestratorConfig: makeOrchestratorConfig(),
        escalationConfig: makeEscalationConfig({ maxDepth: 0 }),
        transparencyConfig: { mode: 'banner' },
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

    const content = extractContent(await res.text());
    expect(content.startsWith('[turbocharger]')).toBe(true);
    expect(content).toContain('escalation is disabled');
    expect(content).toContain('original');
    // The original refusal content is still after the banner
    expect(content).toContain("I'm sorry, I cannot help.");
  });

  it('honors Accept-Language for German banners', async () => {
    startSidecar({ mode: 'banner' });

    mock.setHandler((_req, res, body) => {
      const parsed = JSON.parse(body.toString('utf-8')) as { model: string };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (parsed.model === 'weak-model') {
        res.end(buildChatCompletionBody("I'm sorry, but I cannot help."));
      } else {
        res.end(buildChatCompletionBody('Eine klare, hilfreiche Antwort mit Details.'));
      }
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      },
      body: JSON.stringify({
        model: 'weak-model',
        messages: [{ role: 'user', content: 'Bitte helfen.' }],
      }),
    });

    const content = extractContent(await res.text());
    expect(content.startsWith('[turbocharger] ')).toBe(true);
    expect(content).toContain('stärkeres Modell');
  });
});
