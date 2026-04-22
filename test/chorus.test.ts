import { describe, expect, it } from 'vitest';

import { dispatchChorus } from '../src/escalation/chorus.js';
import { DEFAULT_CHORUS_TIMEOUT_MS, type EscalationConfig } from '../src/types.js';

function makeConfig(overrides: Partial<EscalationConfig> = {}): EscalationConfig {
  return {
    mode: 'chorus',
    ladder: [],
    maxDepth: 1,
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<Parameters<typeof dispatchChorus>[1]> = {},
): Parameters<typeof dispatchChorus>[1] {
  return {
    bodyBytes: '{"messages":[{"role":"user","content":"hi"}]}',
    clientHeaders: new Headers({ 'content-type': 'application/json' }),
    contextHeaders: {},
    ...overrides,
  };
}

describe('dispatchChorus', () => {
  it('returns endpoint_not_set when chorusEndpoint is undefined', async () => {
    const result = await dispatchChorus(makeConfig(), makeInput());
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('endpoint_not_set');
    }
  });

  it('returns endpoint_not_set when chorusEndpoint is an empty string', async () => {
    const result = await dispatchChorus(makeConfig({ chorusEndpoint: '' }), makeInput());
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('endpoint_not_set');
    }
  });

  it('returns ok when the endpoint responds 200', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{"id":"1"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const result = await dispatchChorus(
      makeConfig({ chorusEndpoint: 'http://example.test/v1/chat/completions' }),
      makeInput({ fetchImpl }),
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.response.status).toBe(200);
    }
  });

  it('returns non_ok_status when the endpoint responds 500', async () => {
    const fetchImpl: typeof fetch = async () => new Response('boom', { status: 500 });
    const result = await dispatchChorus(
      makeConfig({ chorusEndpoint: 'http://example.test/v1/chat/completions' }),
      makeInput({ fetchImpl }),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('non_ok_status');
      expect(result.detail).toContain('500');
    }
  });

  it('classifies network/DNS errors as unreachable', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError('fetch failed: getaddrinfo ENOTFOUND example.invalid');
    };
    const result = await dispatchChorus(
      makeConfig({ chorusEndpoint: 'http://example.invalid/' }),
      makeInput({ fetchImpl }),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('unreachable');
      expect(result.detail).toContain('ENOTFOUND');
    }
  });

  it('classifies AbortError as timeout', async () => {
    const fetchImpl: typeof fetch = async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };
    const result = await dispatchChorus(
      makeConfig({ chorusEndpoint: 'http://example.test/', chorusTimeoutMs: 10 }),
      makeInput({ fetchImpl }),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('timeout');
      expect(result.detail).toContain('10ms');
    }
  });

  it('uses DEFAULT_CHORUS_TIMEOUT_MS when chorusTimeoutMs is unset', async () => {
    // We cannot easily assert the actual setTimeout delay without
    // time-travel, so verify indirectly: the detail for a timeout
    // error reports the default value when no override is set.
    const fetchImpl: typeof fetch = async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };
    const result = await dispatchChorus(
      makeConfig({ chorusEndpoint: 'http://example.test/' }),
      makeInput({ fetchImpl }),
    );
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toBe('timeout');
      expect(result.detail).toContain(String(DEFAULT_CHORUS_TIMEOUT_MS));
    }
  });

  it('forwards context headers on top of client headers', async () => {
    let captured: Headers | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      captured = new Headers(init?.headers as HeadersInit);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    await dispatchChorus(
      makeConfig({ chorusEndpoint: 'http://example.test/' }),
      makeInput({
        clientHeaders: new Headers({
          'content-type': 'application/json',
          authorization: 'Bearer xyz',
        }),
        contextHeaders: {
          'x-turbocharger-reason': 'hard_signals',
          'x-turbocharger-aggregate': '0.712',
        },
        fetchImpl,
      }),
    );

    expect(captured?.get('authorization')).toBe('Bearer xyz');
    expect(captured?.get('x-turbocharger-reason')).toBe('hard_signals');
    expect(captured?.get('x-turbocharger-aggregate')).toBe('0.712');
  });

  it('strips hop-by-hop headers per RFC 7230', async () => {
    let captured: Headers | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      captured = new Headers(init?.headers as HeadersInit);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    await dispatchChorus(
      makeConfig({ chorusEndpoint: 'http://example.test/' }),
      makeInput({
        clientHeaders: new Headers({
          'content-type': 'application/json',
          connection: 'keep-alive',
          'transfer-encoding': 'chunked',
          'keep-alive': 'timeout=5',
        }),
        fetchImpl,
      }),
    );

    expect(captured?.get('connection')).toBeNull();
    expect(captured?.get('transfer-encoding')).toBeNull();
    expect(captured?.get('keep-alive')).toBeNull();
    expect(captured?.get('content-type')).toBe('application/json');
  });
});
