import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/load.js';

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'turbocharger-loadconfig-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(name: string, content: string): string {
    const path = join(tmpDir, name);
    writeFileSync(path, content, 'utf8');
    return path;
  }

  it('loads from env vars only when no file is configured', () => {
    const result = loadConfig({
      TURBOCHARGER_DOWNSTREAM_BASE_URL: 'http://localhost:11434/v1',
    });
    expect(result.appConfig).toEqual({
      port: 11435,
      downstreamBaseUrl: 'http://localhost:11434/v1',
    });
  });

  it('applies the default port when neither env nor file specifies one', () => {
    const result = loadConfig({
      TURBOCHARGER_DOWNSTREAM_BASE_URL: 'http://localhost:11434/v1',
    });
    expect(result.appConfig.port).toBe(11435);
  });

  it('throws an aggregated error when downstreamBaseUrl is missing', () => {
    expect(() => loadConfig({})).toThrow(/Configuration is invalid/);
  });

  it('throws when env port is not a positive integer', () => {
    expect(() =>
      loadConfig({
        TURBOCHARGER_PORT: '99999',
        TURBOCHARGER_DOWNSTREAM_BASE_URL: 'http://localhost:11434/v1',
      }),
    ).toThrow(/port must be in 1\.\.65535/);
  });

  it('strips trailing slashes from downstreamBaseUrl', () => {
    const result = loadConfig({
      TURBOCHARGER_DOWNSTREAM_BASE_URL: 'http://localhost:11434/v1////',
    });
    expect(result.appConfig.downstreamBaseUrl).toBe('http://localhost:11434/v1');
  });

  it('loads a YAML config file (wrapped under turbocharger:)', () => {
    const path = writeFile(
      'config.yaml',
      `
turbocharger:
  port: 11500
  downstream_base_url: http://localhost:11434/v1
  answer_mode: single
`,
    );
    const result = loadConfig({ TURBOCHARGER_CONFIG: path });
    expect(result.appConfig.port).toBe(11500);
    expect(result.defaultAnswerMode).toBe('single');
  });

  it('loads a YAML config file (flat top-level)', () => {
    const path = writeFile(
      'config.yaml',
      `
port: 11500
downstream_base_url: http://localhost:11434/v1
`,
    );
    const result = loadConfig({ TURBOCHARGER_CONFIG: path });
    expect(result.appConfig.port).toBe(11500);
  });

  it('loads a JSON config file', () => {
    const path = writeFile(
      'config.json',
      JSON.stringify({
        turbocharger: {
          port: 11500,
          downstream_base_url: 'http://localhost:11434/v1',
        },
      }),
    );
    const result = loadConfig({ TURBOCHARGER_CONFIG: path });
    expect(result.appConfig.port).toBe(11500);
  });

  it('rejects a config file with an unsupported extension', () => {
    const path = writeFile('config.toml', 'port = 11500\n');
    expect(() => loadConfig({ TURBOCHARGER_CONFIG: path })).toThrow(/unsupported extension/);
  });

  it('rejects a non-existent config file with an actionable message', () => {
    expect(() => loadConfig({ TURBOCHARGER_CONFIG: join(tmpDir, 'no-such-file.yaml') })).toThrow(
      /Failed to read config file/,
    );
  });

  it('rejects a malformed YAML file with the file path included', () => {
    const path = writeFile('broken.yaml', 'port: : :: invalid\n  - what\n');
    expect(() => loadConfig({ TURBOCHARGER_CONFIG: path })).toThrow(/Failed to parse YAML/);
  });

  it('rejects a malformed JSON file with the file path included', () => {
    const path = writeFile('broken.json', '{this is not json}');
    expect(() => loadConfig({ TURBOCHARGER_CONFIG: path })).toThrow(/Failed to parse JSON/);
  });

  it('env values override file values for the same field', () => {
    const path = writeFile(
      'config.yaml',
      `
turbocharger:
  port: 11500
  downstream_base_url: http://from-file:11434/v1
`,
    );
    const result = loadConfig({
      TURBOCHARGER_CONFIG: path,
      TURBOCHARGER_PORT: '11600',
    });
    expect(result.appConfig.port).toBe(11600);
    expect(result.appConfig.downstreamBaseUrl).toBe('http://from-file:11434/v1');
  });

  it('merges nested configs deeply (env adds to what file provided)', () => {
    const path = writeFile(
      'config.yaml',
      `
turbocharger:
  downstream_base_url: http://localhost:11434/v1
  orchestrator:
    threshold: 0.6
    grey_band: [0.3, 0.6]
    weights:
      refusal: 1.0
      truncation: 1.0
      repetition: 1.0
      empty: 1.0
      tool_error: 1.0
      syntax_error: 1.0
`,
    );
    const result = loadConfig({
      TURBOCHARGER_CONFIG: path,
      TURBOCHARGER_ORCHESTRATOR__THRESHOLD: '0.7',
    });
    expect(result.orchestratorConfig?.threshold).toBe(0.7);
    expect(result.orchestratorConfig?.weights.refusal).toBe(1.0);
  });

  it('parses an escalation ladder from env (comma-separated)', () => {
    const result = loadConfig({
      TURBOCHARGER_DOWNSTREAM_BASE_URL: 'http://localhost:11434/v1',
      TURBOCHARGER_ESCALATION__MODE: 'ladder',
      TURBOCHARGER_ESCALATION__LADDER: 'weak,mid,strong',
      TURBOCHARGER_ESCALATION__MAX_DEPTH: '2',
    });
    expect(result.escalationConfig?.mode).toBe('ladder');
    expect(result.escalationConfig?.ladder).toEqual(['weak', 'mid', 'strong']);
    expect(result.escalationConfig?.maxDepth).toBe(2);
  });

  it('rejects answerMode=chorus without a chorus.endpoint', () => {
    expect(() =>
      loadConfig({
        TURBOCHARGER_DOWNSTREAM_BASE_URL: 'http://localhost:11434/v1',
        TURBOCHARGER_ANSWER_MODE: 'chorus',
      }),
    ).toThrow(/chorus mode requires/);
  });

  it('accepts answerMode=chorus with a chorus.endpoint', () => {
    const result = loadConfig({
      TURBOCHARGER_DOWNSTREAM_BASE_URL: 'http://localhost:11434/v1',
      TURBOCHARGER_ANSWER_MODE: 'chorus',
      TURBOCHARGER_CHORUS__ENDPOINT: 'http://localhost:11436/v1/chat/completions',
    });
    expect(result.defaultAnswerMode).toBe('chorus');
    expect(result.chorusConfig?.endpoint).toBe('http://localhost:11436/v1/chat/completions');
  });

  it('aggregates multiple errors in one Error message', () => {
    try {
      loadConfig({
        TURBOCHARGER_PORT: '99999',
        TURBOCHARGER_DOWNSTREAM_BASE_URL: 'not a url',
      });
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toMatch(/port/);
      expect(msg).toMatch(/downstreamBaseUrl/);
      expect(msg.split('\n').length).toBeGreaterThanOrEqual(3);
    }
  });
});
