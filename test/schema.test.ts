import { describe, expect, it } from 'vitest';

import {
  AppConfigSchema,
  ChorusConfigSchema,
  EscalationConfigSchema,
  OrchestratorConfigSchema,
  TransparencyConfigSchema,
  TurbochargerConfigSchema,
} from '../src/config/schema.js';

describe('AppConfigSchema', () => {
  it('accepts a minimal valid config', () => {
    const result = AppConfigSchema.safeParse({
      port: 11435,
      downstreamBaseUrl: 'http://localhost:11434/v1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-integer port', () => {
    const result = AppConfigSchema.safeParse({
      port: 11435.5,
      downstreamBaseUrl: 'http://localhost:11434/v1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative port', () => {
    const result = AppConfigSchema.safeParse({
      port: -1,
      downstreamBaseUrl: 'http://localhost:11434/v1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-http downstreamBaseUrl', () => {
    const result = AppConfigSchema.safeParse({
      port: 11435,
      downstreamBaseUrl: 'ftp://localhost/v1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown top-level fields (strict)', () => {
    const result = AppConfigSchema.safeParse({
      port: 11435,
      downstreamBaseUrl: 'http://localhost:11434/v1',
      typo_field: 'whatever',
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional downstreamApiKey', () => {
    const result = AppConfigSchema.safeParse({
      port: 11435,
      downstreamBaseUrl: 'http://localhost:11434/v1',
      downstreamApiKey: 'sk-test',
    });
    expect(result.success).toBe(true);
  });
});

describe('OrchestratorConfigSchema', () => {
  const validBase = {
    threshold: 0.6,
    weights: {
      refusal: 1,
      truncation: 1,
      repetition: 1,
      empty: 1,
      tool_error: 1,
      syntax_error: 1,
    },
    greyBand: [0.3, 0.6] as [number, number],
  };

  it('accepts a valid orchestrator config', () => {
    expect(OrchestratorConfigSchema.safeParse(validBase).success).toBe(true);
  });

  it('rejects threshold outside [0, 1]', () => {
    expect(OrchestratorConfigSchema.safeParse({ ...validBase, threshold: 1.5 }).success).toBe(
      false,
    );
  });

  it('rejects greyBand with lower > upper', () => {
    expect(
      OrchestratorConfigSchema.safeParse({
        ...validBase,
        greyBand: [0.7, 0.3] as [number, number],
      }).success,
    ).toBe(false);
  });

  it('rejects missing weight categories (strict)', () => {
    const partialWeights = {
      refusal: 1,
    };
    expect(
      OrchestratorConfigSchema.safeParse({ ...validBase, weights: partialWeights }).success,
    ).toBe(false);
  });

  it('rejects unknown weight category (strict)', () => {
    expect(
      OrchestratorConfigSchema.safeParse({
        ...validBase,
        weights: { ...validBase.weights, unknown_category: 1 },
      }).success,
    ).toBe(false);
  });
});

describe('EscalationConfigSchema', () => {
  it('accepts ladder mode without maxModel', () => {
    expect(
      EscalationConfigSchema.safeParse({
        mode: 'ladder',
        ladder: ['weak', 'mid', 'strong'],
        maxDepth: 2,
      }).success,
    ).toBe(true);
  });

  it('rejects max mode without maxModel', () => {
    const result = EscalationConfigSchema.safeParse({
      mode: 'max',
      ladder: [],
      maxDepth: 2,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/max-mode/);
    }
  });

  it('accepts max mode with maxModel', () => {
    expect(
      EscalationConfigSchema.safeParse({
        mode: 'max',
        ladder: [],
        maxModel: 'strong',
        maxDepth: 2,
      }).success,
    ).toBe(true);
  });

  it('rejects negative maxDepth', () => {
    expect(
      EscalationConfigSchema.safeParse({
        mode: 'ladder',
        ladder: ['weak'],
        maxDepth: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown mode', () => {
    expect(
      EscalationConfigSchema.safeParse({
        mode: 'chorus',
        ladder: [],
        maxDepth: 2,
      }).success,
    ).toBe(false);
  });
});

describe('ChorusConfigSchema', () => {
  it('accepts a valid chorus config', () => {
    expect(
      ChorusConfigSchema.safeParse({
        endpoint: 'http://localhost:11436/v1/chat/completions',
      }).success,
    ).toBe(true);
  });

  it('rejects a non-http endpoint', () => {
    expect(ChorusConfigSchema.safeParse({ endpoint: 'not a url' }).success).toBe(false);
  });

  it('accepts optional timeoutMs', () => {
    expect(
      ChorusConfigSchema.safeParse({
        endpoint: 'http://localhost:11436/v1/chat/completions',
        timeoutMs: 60000,
      }).success,
    ).toBe(true);
  });

  it('rejects non-positive timeoutMs', () => {
    expect(
      ChorusConfigSchema.safeParse({
        endpoint: 'http://localhost:11436/v1/chat/completions',
        timeoutMs: 0,
      }).success,
    ).toBe(false);
  });
});

describe('TransparencyConfigSchema', () => {
  it.each(['banner', 'silent', 'card'])('accepts mode=%s', (mode) => {
    expect(TransparencyConfigSchema.safeParse({ mode }).success).toBe(true);
  });

  it('rejects an unknown mode', () => {
    expect(TransparencyConfigSchema.safeParse({ mode: 'flashy' }).success).toBe(false);
  });
});

describe('TurbochargerConfigSchema (top-level)', () => {
  it('accepts a minimal config (just AppConfig fields)', () => {
    expect(
      TurbochargerConfigSchema.safeParse({
        port: 11435,
        downstreamBaseUrl: 'http://localhost:11434/v1',
      }).success,
    ).toBe(true);
  });

  it('rejects answerMode=chorus without chorus config', () => {
    const result = TurbochargerConfigSchema.safeParse({
      port: 11435,
      downstreamBaseUrl: 'http://localhost:11434/v1',
      answerMode: 'chorus',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/chorus mode requires/);
    }
  });

  it('accepts answerMode=chorus with chorus config', () => {
    expect(
      TurbochargerConfigSchema.safeParse({
        port: 11435,
        downstreamBaseUrl: 'http://localhost:11434/v1',
        answerMode: 'chorus',
        chorus: { endpoint: 'http://localhost:11436/v1/chat/completions' },
      }).success,
    ).toBe(true);
  });

  it('aggregates multiple validation errors (does not short-circuit)', () => {
    const result = TurbochargerConfigSchema.safeParse({
      port: -1,
      downstreamBaseUrl: 'not a url',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});
