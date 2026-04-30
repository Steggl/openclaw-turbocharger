import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startServer, type DecisionLogEntry, type RunningServer } from '../src/server.js';
import type {
  ChorusConfig,
  EscalationConfig,
  OrchestratorConfig,
  SignalWeights,
  TransparencyConfig,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Test helpers (mirror test/pipeline-card.test.ts)
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
      void Promise.resolve(handler(req, res, Buffer.concat(chunks))).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}/v1`;

  return {
    baseUrl,
    setHandler(h) {
      handler = h;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function makeOrchestratorConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  const weights: SignalWeights = {
    refusal: 1,
    truncation: 1,
    repetition: 1,
    empty: 1,
    tool_error: 1,
    syntax_error: 1,
  };
  return {
    threshold: 0.6,
    weights,
    greyBand: [0.3, 0.6],
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

describe('per-request header overrides (Issue #12)', () => {
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

  function startSidecar(
    opts: {
      defaultAnswerMode?: 'single' | 'chorus';
      chorusConfig?: ChorusConfig;
      transparencyConfig?: TransparencyConfig;
    } = {},
  ): void {
    sidecar = startServer(
      { port: 0, downstreamBaseUrl: mock.baseUrl },
      {
        logger: (entry) => {
          logs.push(entry as DecisionLogEntry);
        },
        orchestratorConfig: makeOrchestratorConfig(),
        escalationConfig: makeEscalationConfig(),
        ...(opts.defaultAnswerMode !== undefined
          ? { defaultAnswerMode: opts.defaultAnswerMode }
          : {}),
        ...(opts.chorusConfig !== undefined ? { chorusConfig: opts.chorusConfig } : {}),
        ...(opts.transparencyConfig !== undefined
          ? { transparencyConfig: opts.transparencyConfig }
          : {}),
      },
    );
    sidecarBaseUrl = `http://127.0.0.1:${sidecar.port}`;
  }

  it('transparency override: card replaces a default banner mode', async () => {
    startSidecar({ transparencyConfig: { mode: 'banner' } });

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
      headers: {
        'content-type': 'application/json',
        'x-turbocharger-transparency': 'card',
      },
      body: JSON.stringify({
        model: 'weak-model',
        messages: [{ role: 'user', content: 'help me' }],
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    const content = extractContent(text);
    // Card marker shows up; banner phrasing does not.
    expect(content).toContain('[turbocharger card]');
    expect(content).not.toContain('A stronger model was used because');
    expect(res.headers.get('x-turbocharger-override-rejected')).toBeNull();
    // Log shows the override.
    const entry = logs.at(-1);
    expect(entry?.transparency_mode).toBe('card');
    expect(entry?.transparency_mode_override).toBe('card');
  });

  it('transparency override: silent suppresses a default banner', async () => {
    startSidecar({ transparencyConfig: { mode: 'banner' } });

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
      headers: {
        'content-type': 'application/json',
        'x-turbocharger-transparency': 'silent',
      },
      body: JSON.stringify({
        model: 'weak-model',
        messages: [{ role: 'user', content: 'help me' }],
      }),
    });

    const content = extractContent(await res.text());
    expect(content).not.toContain('[turbocharger');
    const entry = logs.at(-1);
    expect(entry?.transparency_mode).toBe('silent');
    expect(entry?.transparency_mode_override).toBe('silent');
  });

  it('answer-mode override: chorus is rejected when no chorus is configured', async () => {
    startSidecar({ defaultAnswerMode: 'single' });

    mock.setHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        buildChatCompletionBody(
          'Here is a clear, complete, helpful answer with concrete details and context.',
        ),
      );
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-turbocharger-answer-mode': 'chorus',
      },
      body: JSON.stringify({
        model: 'weak-model',
        messages: [{ role: 'user', content: 'help me' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-turbocharger-override-rejected')).toContain(
      'answer-mode=chorus:chorus-config-missing',
    );
    // Mode header reflects the actual mode used (single).
    expect(res.headers.get('x-turbocharger-answer-mode')).toBe('single');
    const entry = logs.at(-1);
    expect(entry?.answer_mode).toBe('single');
    expect(entry?.answer_mode_override).toBeUndefined();
    expect(entry?.override_rejected).toEqual(['answer-mode=chorus:chorus-config-missing']);
  });

  it('rejects an invalid header value tolerantly: response carries the rejection, request continues', async () => {
    startSidecar({ transparencyConfig: { mode: 'silent' } });

    mock.setHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        buildChatCompletionBody(
          'Here is a clear, complete, helpful answer with concrete details and context.',
        ),
      );
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-turbocharger-transparency': 'flashy',
      },
      body: JSON.stringify({
        model: 'weak-model',
        messages: [{ role: 'user', content: 'help me' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-turbocharger-override-rejected')).toBe(
      'transparency=flashy:invalid-value',
    );
    const entry = logs.at(-1);
    expect(entry?.transparency_mode).toBe('silent');
    expect(entry?.transparency_mode_override).toBeUndefined();
    expect(entry?.override_rejected).toEqual(['transparency=flashy:invalid-value']);
  });

  it('passes through requests without override headers untouched', async () => {
    startSidecar({ transparencyConfig: { mode: 'silent' } });

    mock.setHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        buildChatCompletionBody(
          'Here is a clear, complete, helpful answer with concrete details and context.',
        ),
      );
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'weak-model',
        messages: [{ role: 'user', content: 'help me' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-turbocharger-override-rejected')).toBeNull();
    const entry = logs.at(-1);
    expect(entry?.answer_mode_override).toBeUndefined();
    expect(entry?.transparency_mode_override).toBeUndefined();
    expect(entry?.override_rejected).toBeUndefined();
  });

  it('combines two overrides in one request', async () => {
    startSidecar({ transparencyConfig: { mode: 'silent' } });

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
      headers: {
        'content-type': 'application/json',
        'x-turbocharger-answer-mode': 'single',
        'x-turbocharger-transparency': 'banner',
      },
      body: JSON.stringify({
        model: 'weak-model',
        messages: [{ role: 'user', content: 'help me' }],
      }),
    });

    const content = extractContent(await res.text());
    expect(content).toContain('[turbocharger]');
    const entry = logs.at(-1);
    expect(entry?.answer_mode).toBe('single');
    expect(entry?.answer_mode_override).toBe('single');
    expect(entry?.transparency_mode).toBe('banner');
    expect(entry?.transparency_mode_override).toBe('banner');
  });
});
