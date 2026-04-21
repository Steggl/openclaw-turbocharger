import { describe, expect, it } from 'vitest';

import { maxStep } from '../src/escalation/max.js';
import type { EscalationConfig } from '../src/types.js';

function makeConfig(overrides: Partial<EscalationConfig> = {}): EscalationConfig {
  return {
    mode: 'max',
    ladder: [],
    maxDepth: 1,
    ...overrides,
  };
}

describe('maxStep', () => {
  it('returns maxModel when it is set', () => {
    expect(maxStep(makeConfig({ maxModel: 'anthropic/claude-opus-4-7' }))).toBe(
      'anthropic/claude-opus-4-7',
    );
  });

  it('returns null when maxModel is undefined', () => {
    expect(maxStep(makeConfig())).toBeNull();
  });

  it('returns null when maxModel is an empty string', () => {
    // Empty string reflects a caller who built the config imperatively
    // and accidentally assigned '' — we do not want to treat that as
    // a valid target.
    expect(maxStep(makeConfig({ maxModel: '' }))).toBeNull();
  });

  it('is agnostic to ladder contents', () => {
    // Max-mode is deliberately not a "top-of-ladder" fallback: the
    // function reads maxModel and only maxModel. A non-empty ladder
    // with an unset maxModel still yields null.
    expect(
      maxStep(
        makeConfig({
          ladder: ['weak', 'mid', 'strong'],
          // maxModel intentionally omitted
        }),
      ),
    ).toBeNull();
  });

  it('returns maxModel even when ladder is empty', () => {
    expect(
      maxStep(
        makeConfig({
          ladder: [],
          maxModel: 'only-model',
        }),
      ),
    ).toBe('only-model');
  });
});
