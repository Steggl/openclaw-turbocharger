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
// Test helpers (mirror test/pipeline-banner.test.ts)
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

describe('pipeline transparency (card)', () => {
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

  it('prepends a card to the assistant content when escalation succeeded', async () => {
    startSidecar({ mode: 'card' });

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
    const content = extractContent(await res.text());
    expect(content.startsWith('[turbocharger card]')).toBe(true);
    expect(content).toContain('Initial model: weak-model');
    expect(content).toContain('Decision: pass (after escalation)');
    expect(content).toContain('Path: weak-model → mid-model');
    expect(content).toContain('Outcome: passed at depth 1');
    expect(content).toContain('\n\n---\n\n');
    // Original content is preserved AFTER the card.
    expect(content).toContain('clear, complete, helpful answer');

    expect(logs[0]?.transparency_mode).toBe('card');
  });

  it('does not prepend a card when the first response passes', async () => {
    startSidecar({ mode: 'card' });

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
    expect(content.startsWith('[turbocharger')).toBe(false);
    expect(content.startsWith('Here is a clear')).toBe(true);
  });

  it('does not prepend a card when transparency mode is silent', async () => {
    startSidecar({ mode: 'silent' });

    mock.setHandler((_req, res, body) => {
      const parsed = JSON.parse(body.toString('utf-8')) as { model: string };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (parsed.model === 'weak-model') {
        res.end(buildChatCompletionBody("I'm sorry, but I cannot help with that."));
      } else {
        res.end(buildChatCompletionBody('A complete and useful answer with relevant details.'));
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
    expect(content.startsWith('[turbocharger')).toBe(false);
  });

  it('does not prepend a card when no transparencyConfig is configured (silent default)', async () => {
    startSidecar();

    mock.setHandler((_req, res, body) => {
      const parsed = JSON.parse(body.toString('utf-8')) as { model: string };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (parsed.model === 'weak-model') {
        res.end(buildChatCompletionBody("I'm sorry, but I cannot help with that."));
      } else {
        res.end(buildChatCompletionBody('A complete and useful answer with relevant details.'));
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
    expect(content.startsWith('[turbocharger')).toBe(false);
    expect(logs[0]?.transparency_mode).toBeUndefined();
  });

  it('emits a card with not_attempted outcome when escalation is disabled (maxDepth=0)', async () => {
    sidecar = startServer(
      { port: 0, downstreamBaseUrl: mock.baseUrl },
      {
        logger: (entry) => {
          logs.push(entry as DecisionLogEntry);
        },
        orchestratorConfig: makeOrchestratorConfig(),
        escalationConfig: makeEscalationConfig({ maxDepth: 0 }),
        transparencyConfig: { mode: 'card' },
      },
    );
    sidecarBaseUrl = `http://127.0.0.1:${sidecar.port}`;

    mock.setHandler((_req, res, _body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(buildChatCompletionBody("I'm sorry, but I cannot help with that."));
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
    expect(content.startsWith('[turbocharger card]')).toBe(true);
    expect(content).toContain('Decision: escalate (hard_signals)');
    expect(content).toContain('Outcome: no escalation attempted (disabled)');
    // Path line is omitted because path is empty.
    expect(content).not.toContain('\n- Path:');
  });

  it('honors Accept-Language for German cards', async () => {
    startSidecar({ mode: 'card' });

    mock.setHandler((_req, res, body) => {
      const parsed = JSON.parse(body.toString('utf-8')) as { model: string };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (parsed.model === 'weak-model') {
        // Refusal phrasing in English so the en-pattern fallback catches it.
        // The hard-signal detector resolves locales by exact key, so 'de-DE'
        // misses the 'de' bucket and only the en-fallback patterns run.
        // The banner DE test takes the same approach.
        res.end(buildChatCompletionBody("I'm sorry, but I cannot help with that."));
      } else {
        res.end(
          buildChatCompletionBody(
            'Hier ist eine klare und vollständige Antwort mit konkreten Details und Kontext.',
          ),
        );
      }
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7',
      },
      body: JSON.stringify({
        model: 'weak-model',
        messages: [{ role: 'user', content: 'Bitte hilf mir.' }],
      }),
    });

    const content = extractContent(await res.text());
    expect(content.startsWith('[turbocharger card]')).toBe(true);
    expect(content).toContain('Initiales Modell: weak-model');
    expect(content).toContain('Pfad: weak-model → mid-model');
    expect(content).toContain('Ergebnis: passed bei Tiefe 1');
  });
});
