import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  buildModelDefinition,
  normalizeBaseUrl,
  parseModelIds,
  validateBaseUrl,
} from '../wizard.js';

describe('normalizeBaseUrl', () => {
  it('returns the default when input is empty or whitespace', () => {
    expect(normalizeBaseUrl('')).toBe(DEFAULT_BASE_URL);
    expect(normalizeBaseUrl('   ')).toBe(DEFAULT_BASE_URL);
  });

  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('http://localhost:11435/v1/')).toBe('http://localhost:11435/v1');
    expect(normalizeBaseUrl('http://localhost:11435/v1///')).toBe('http://localhost:11435/v1');
  });

  it('appends /v1 when missing', () => {
    expect(normalizeBaseUrl('http://localhost:11435')).toBe('http://localhost:11435/v1');
    expect(normalizeBaseUrl('http://localhost:11435/')).toBe('http://localhost:11435/v1');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeBaseUrl('  http://localhost:11435/v1  ')).toBe('http://localhost:11435/v1');
  });
});

describe('validateBaseUrl', () => {
  it('returns undefined for valid URLs', () => {
    expect(validateBaseUrl('http://localhost:11435')).toBeUndefined();
    expect(validateBaseUrl('https://example.com/v1')).toBeUndefined();
  });

  it('returns an error message for clearly invalid URLs', () => {
    expect(validateBaseUrl('not a url at all')).toBe('Enter a valid URL');
  });
});

describe('parseModelIds', () => {
  it('splits on commas and newlines', () => {
    expect(parseModelIds('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(parseModelIds('a\nb\nc')).toEqual(['a', 'b', 'c']);
    expect(parseModelIds('a,b\nc')).toEqual(['a', 'b', 'c']);
  });

  it('trims whitespace and filters empty entries', () => {
    expect(parseModelIds('a, b , c,')).toEqual(['a', 'b', 'c']);
    expect(parseModelIds(',,a,,b,,')).toEqual(['a', 'b']);
  });

  it('deduplicates entries while preserving first-occurrence order', () => {
    expect(parseModelIds('a,a,b,b,c')).toEqual(['a', 'b', 'c']);
    expect(parseModelIds('c,a,b,a,c')).toEqual(['c', 'a', 'b']);
  });
});

describe('buildModelDefinition', () => {
  it('returns a definition with the expected shape', () => {
    const def = buildModelDefinition('anthropic/claude-haiku-4-5');
    expect(def).toEqual({
      id: 'anthropic/claude-haiku-4-5',
      name: 'anthropic/claude-haiku-4-5',
      api: 'openai-completions',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
  });

  it('preserves the model id verbatim', () => {
    expect(buildModelDefinition('qwen2.5:7b').id).toBe('qwen2.5:7b');
    expect(buildModelDefinition('openai/gpt-5-mini').id).toBe('openai/gpt-5-mini');
  });
});
