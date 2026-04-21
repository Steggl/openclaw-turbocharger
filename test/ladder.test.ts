import { describe, expect, it } from 'vitest';

import { nextLadderStep, remainingLadderSteps } from '../src/escalation/ladder.js';

describe('nextLadderStep', () => {
  const ladder = [
    'anthropic/claude-haiku-4-5',
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-opus-4-7',
  ];

  it('returns the next model when the current is at the bottom', () => {
    expect(nextLadderStep('anthropic/claude-haiku-4-5', ladder)).toBe(
      'anthropic/claude-sonnet-4-6',
    );
  });

  it('returns the next model from the middle of the ladder', () => {
    expect(nextLadderStep('anthropic/claude-sonnet-4-6', ladder)).toBe(
      'anthropic/claude-opus-4-7',
    );
  });

  it('returns null when the current model is the top rung', () => {
    expect(nextLadderStep('anthropic/claude-opus-4-7', ladder)).toBeNull();
  });

  it('returns null when the current model is not on the ladder', () => {
    expect(nextLadderStep('openai/gpt-4o', ladder)).toBeNull();
  });

  it('returns null for an empty ladder', () => {
    expect(nextLadderStep('anything', [])).toBeNull();
  });

  it('is case-sensitive on model IDs', () => {
    // Uppercase variant should not match the lowercase ladder entry.
    expect(nextLadderStep('ANTHROPIC/CLAUDE-HAIKU-4-5', ladder)).toBeNull();
  });

  it('handles single-element ladders (top rung, no next)', () => {
    expect(nextLadderStep('only-model', ['only-model'])).toBeNull();
  });
});

describe('remainingLadderSteps', () => {
  const ladder = ['a', 'b', 'c', 'd'];

  it('counts steps above the bottom', () => {
    expect(remainingLadderSteps('a', ladder)).toBe(3);
  });

  it('counts steps above the middle', () => {
    expect(remainingLadderSteps('b', ladder)).toBe(2);
  });

  it('returns 0 at the top', () => {
    expect(remainingLadderSteps('d', ladder)).toBe(0);
  });

  it('returns 0 for a model not on the ladder', () => {
    expect(remainingLadderSteps('z', ladder)).toBe(0);
  });

  it('returns 0 for an empty ladder', () => {
    expect(remainingLadderSteps('a', [])).toBe(0);
  });
});
