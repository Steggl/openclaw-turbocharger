import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../src/server.js';

type MockHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
) => void | Promise<void>;

interface MockDownstream {
  /** Base URL the sidecar should be configured to forward to. No trailing slash. */
  readonly baseUrl: string;
  /** Replace the per-request handler. The default returns 200 with `{}`. */
  setHandler(handler: MockHandler): void;
  /** Most recently received raw request body. */
  lastBody(): Buffer | undefined;
  close(): Promise<void>;
}

async function startMockDownstream(): Promise<MockDownstream> {
  let handler: MockHandler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  };
  const bodies: Buffer[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      bodies.push(body);
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
    lastBody() {
      return bodies[bodies.length - 1];
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe('proxy', () => {
  let mock: MockDownstream;
  let sidecar: RunningServer;
  let sidecarBaseUrl: string;

  beforeEach(async () => {
    mock = await startMockDownstream();
    sidecar = startServer({
      port: 0,
      downstreamBaseUrl: mock.baseUrl,
    });
    sidecarBaseUrl = `http://127.0.0.1:${sidecar.port}`;
  });

  afterEach(async () => {
    await sidecar.close();
    await mock.close();
  });

  it('forwards a non-streaming chat/completions request and returns the downstream response unchanged', async () => {
    const downstreamBody = JSON.stringify({
      id: 'chatcmpl-test-1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hi' },
          finish_reason: 'stop',
        },
      ],
    });
    mock.setHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(downstreamBody);
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
    expect(res.headers.get('content-type')).toBe('application/json');
    const text = await res.text();
    expect(text).toBe(downstreamBody);
  });

  it('streams response chunks back to the client without buffering when stream: true', async () => {
    // Strict streaming check: the mock sends frame 1, then awaits an external
    // signal before sending frame 2. The test reads from the sidecar's
    // response stream until it observes frame 1, only then resolves the
    // signal. If anything in the chain (Hono, @hono/node-server, undici)
    // buffered the whole response before forwarding, the client would never
    // see frame 1, the test would never call releaseFrame2(), the mock would
    // hang on the await, and the AbortSignal.timeout below would fail the
    // test. Reading frame 1 strictly before frame 2 is sent is the property.
    let releaseFrame2!: () => void;
    const frame2Released = new Promise<void>((resolve) => {
      releaseFrame2 = resolve;
    });

    mock.setHandler(async (_req, res, _body) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      res.write('data: {"id":"1","choices":[{"delta":{"content":"hel"}}]}\n\n');
      // Block until the test confirms frame 1 reached the client.
      await frame2Released;
      res.write('data: {"id":"2","choices":[{"delta":{"content":"lo"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-mini',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(7000),
    });

    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Chunks may not align with our SSE frame boundaries (TCP / undici can
    // split or coalesce). Accumulate until we see the marker for frame 1.
    let buf = '';
    while (!buf.includes('"id":"1"')) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error(`stream ended before frame 1 was observed; got: ${JSON.stringify(buf)}`);
      }
      buf += decoder.decode(value, { stream: true });
    }

    // Frame 1 is observably on the client side. Only now do we let the mock
    // emit frame 2. Reaching this line proves the response was not buffered.
    releaseFrame2();

    while (!buf.includes('"id":"2"')) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error(`stream ended before frame 2 was observed; got: ${JSON.stringify(buf)}`);
      }
      buf += decoder.decode(value, { stream: true });
    }
    while (!buf.includes('[DONE]')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }

    expect(buf).toContain('"id":"1"');
    expect(buf).toContain('"id":"2"');
    expect(buf).toContain('[DONE]');
  }, 10_000);

  it('forwards downstream HTTP errors verbatim instead of inventing its own', async () => {
    const errorBody = JSON.stringify({
      error: { message: 'internal model error', type: 'server_error' },
    });
    mock.setHandler((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(errorBody);
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
    expect(res.headers.get('content-type')).toBe('application/json');
    const text = await res.text();
    expect(text).toBe(errorBody);
  });

  it('passes the request body through byte-for-byte without modification', async () => {
    // Includes non-ASCII characters and a fixed property order so any
    // round-trip through JSON.parse / JSON.stringify on the way through the
    // sidecar would be visible as a diff.
    const reqBody = JSON.stringify({
      model: 'gpt-mini',
      messages: [{ role: 'user', content: 'count from 1 to 5' }],
      temperature: 0.7,
      stream: false,
      seed: 42,
      meta: { lang: 'de-DE', emoji: 'ä-ö-ü-ß-€' },
    });
    mock.setHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });

    const res = await fetch(`${sidecarBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: reqBody,
    });
    expect(res.status).toBe(200);

    const received = mock.lastBody();
    expect(received).toBeDefined();
    expect(received!.equals(Buffer.from(reqBody, 'utf-8'))).toBe(true);
  });
});
