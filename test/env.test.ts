import { describe, expect, it } from 'vitest';

import { loadEnvConfig, parseEnvVars } from '../src/config/env.js';

describe('parseEnvVars', () => {
  it('returns empty object when no TURBOCHARGER_* vars are set', () => {
    expect(parseEnvVars({})).toEqual({});
  });

  it('ignores variables without the TURBOCHARGER_ prefix', () => {
    expect(parseEnvVars({ HOME: '/root', PATH: '/bin', NODE_ENV: 'test' })).toEqual({});
  });

  it('parses top-level scalars', () => {
    expect(
      parseEnvVars({
        TURBOCHARGER_PORT: '11500',
        TURBOCHARGER_DOWNSTREAM_BASE_URL: 'http://localhost:11434/v1',
      }),
    ).toEqual({
      port: 11500,
      downstreamBaseUrl: 'http://localhost:11434/v1',
    });
  });

  it('coerces numeric strings to numbers', () => {
    expect(parseEnvVars({ TURBOCHARGER_PORT: '11500' })).toEqual({ port: 11500 });
  });

  it('keeps non-numeric strings as strings', () => {
    expect(parseEnvVars({ TURBOCHARGER_DOWNSTREAM_API_KEY: 'sk-test-key' })).toEqual({
      downstreamApiKey: 'sk-test-key',
    });
  });

  it('coerces "true"/"false" to booleans (case-insensitive)', () => {
    const out = parseEnvVars({ TURBOCHARGER_FOO: 'TRUE', TURBOCHARGER_BAR: 'False' });
    expect(out).toEqual({ foo: true, bar: false });
  });

  it('parses nested keys with double-underscore separator', () => {
    expect(
      parseEnvVars({
        TURBOCHARGER_ORCHESTRATOR__THRESHOLD: '0.6',
      }),
    ).toEqual({
      orchestrator: { threshold: 0.6 },
    });
  });

  it('parses deeply nested keys', () => {
    expect(
      parseEnvVars({
        TURBOCHARGER_ORCHESTRATOR__WEIGHTS__REFUSAL: '1.0',
        TURBOCHARGER_ORCHESTRATOR__WEIGHTS__TRUNCATION: '0.8',
      }),
    ).toEqual({
      orchestrator: {
        weights: { refusal: 1.0, truncation: 0.8 },
      },
    });
  });

  it('converts SNAKE_CASE segments to camelCase', () => {
    expect(
      parseEnvVars({
        TURBOCHARGER_DOWNSTREAM_BASE_URL: 'http://localhost/v1',
        TURBOCHARGER_ESCALATION__MAX_DEPTH: '2',
      }),
    ).toEqual({
      downstreamBaseUrl: 'http://localhost/v1',
      escalation: { maxDepth: 2 },
    });
  });

  it('splits ESCALATION__LADDER on commas', () => {
    expect(
      parseEnvVars({
        TURBOCHARGER_ESCALATION__LADDER: 'ollama/qwen2.5:7b,anthropic/claude-haiku-4-5',
      }),
    ).toEqual({
      escalation: { ladder: ['ollama/qwen2.5:7b', 'anthropic/claude-haiku-4-5'] },
    });
  });

  it('splits ORCHESTRATOR__GREY_BAND on commas and coerces to numbers', () => {
    expect(parseEnvVars({ TURBOCHARGER_ORCHESTRATOR__GREY_BAND: '0.3,0.6' })).toEqual({
      orchestrator: { greyBand: [0.3, 0.6] },
    });
  });

  it('skips TURBOCHARGER_CONFIG (meta-variable, consumed by loader)', () => {
    expect(parseEnvVars({ TURBOCHARGER_CONFIG: '/etc/turbocharger.yaml' })).toEqual({});
  });

  it('skips empty-string values', () => {
    expect(parseEnvVars({ TURBOCHARGER_PORT: '   ' })).toEqual({});
  });

  it('skips undefined values', () => {
    expect(parseEnvVars({ TURBOCHARGER_PORT: undefined })).toEqual({});
  });
});

describe('loadEnvConfig (legacy shim)', () => {
  it('reads the three core env vars', () => {
    expect(
      loadEnvConfig({
        TURBOCHARGER_PORT: '11500',
        TURBOCHARGER_DOWNSTREAM_BASE_URL: 'http://localhost:11434/v1',
        TURBOCHARGER_DOWNSTREAM_API_KEY: 'sk-key',
      }),
    ).toEqual({
      port: 11500,
      downstreamBaseUrl: 'http://localhost:11434/v1',
      downstreamApiKey: 'sk-key',
    });
  });

  it('strips trailing slashes from downstreamBaseUrl', () => {
    expect(
      loadEnvConfig({
        TURBOCHARGER_DOWNSTREAM_BASE_URL: 'http://localhost:11434/v1////',
      }).downstreamBaseUrl,
    ).toBe('http://localhost:11434/v1');
  });

  it('defaults the port to 11435 when not set', () => {
    expect(
      loadEnvConfig({
        TURBOCHARGER_DOWNSTREAM_BASE_URL: 'http://localhost:11434/v1',
      }).port,
    ).toBe(11435);
  });

  it('throws when downstreamBaseUrl is missing', () => {
    expect(() => loadEnvConfig({})).toThrow(/TURBOCHARGER_DOWNSTREAM_BASE_URL is required/);
  });

  it('throws when downstreamBaseUrl is not a valid URL', () => {
    expect(() => loadEnvConfig({ TURBOCHARGER_DOWNSTREAM_BASE_URL: 'not a url' })).toThrow(
      /not a valid URL/,
    );
  });

  it('throws when downstreamBaseUrl uses a non-http(s) protocol', () => {
    expect(() =>
      loadEnvConfig({ TURBOCHARGER_DOWNSTREAM_BASE_URL: 'ftp://example.com/v1' }),
    ).toThrow(/must use http or https/);
  });

  it('throws when port is out of range', () => {
    expect(() =>
      loadEnvConfig({
        TURBOCHARGER_DOWNSTREAM_BASE_URL: 'http://localhost:11434/v1',
        TURBOCHARGER_PORT: '99999',
      }),
    ).toThrow(/integer in 1..65535/);
  });

  it('rejects the legacy TURBO_ prefix (hard rename per ADR-0024)', () => {
    expect(() =>
      loadEnvConfig({
        TURBO_DOWNSTREAM_BASE_URL: 'http://localhost:11434/v1',
      }),
    ).toThrow(/TURBOCHARGER_DOWNSTREAM_BASE_URL is required/);
  });
});
