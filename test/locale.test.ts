import { describe, expect, it } from 'vitest';

import { resolveLocale } from '../src/locale.js';

const ALLOWED = ['en', 'de'] as const;

describe('resolveLocale', () => {
  it('returns the bare match when input equals an allowed entry', () => {
    expect(resolveLocale('en', ALLOWED, 'en')).toBe('en');
    expect(resolveLocale('de', ALLOWED, 'en')).toBe('de');
  });

  it('matches BCP-47 region subtags via the dash separator', () => {
    expect(resolveLocale('de-DE', ALLOWED, 'en')).toBe('de');
    expect(resolveLocale('de-AT', ALLOWED, 'en')).toBe('de');
    expect(resolveLocale('de-CH', ALLOWED, 'en')).toBe('de');
    expect(resolveLocale('en-US', ALLOWED, 'en')).toBe('en');
  });

  it('matches Java-style locale tags via the underscore separator', () => {
    expect(resolveLocale('de_DE', ALLOWED, 'en')).toBe('de');
    expect(resolveLocale('en_US', ALLOWED, 'en')).toBe('en');
  });

  it('is case-insensitive on both sides', () => {
    expect(resolveLocale('DE', ALLOWED, 'en')).toBe('de');
    expect(resolveLocale('De-De', ALLOWED, 'en')).toBe('de');
    expect(resolveLocale('EN-us', ALLOWED, 'en')).toBe('en');
  });

  it('returns the fallback when input does not match any entry', () => {
    expect(resolveLocale('fr', ALLOWED, 'en')).toBe('en');
    expect(resolveLocale('fr-FR', ALLOWED, 'en')).toBe('en');
    expect(resolveLocale('zh-CN', ALLOWED, 'en')).toBe('en');
  });

  it('returns the fallback for undefined or empty input', () => {
    expect(resolveLocale(undefined, ALLOWED, 'en')).toBe('en');
    expect(resolveLocale('', ALLOWED, 'en')).toBe('en');
  });

  it('does not match when the prefix is followed by other letters', () => {
    // 'de' is in allowed; 'denmark' should NOT resolve to 'de' because
    // 'denmark' is not a BCP-47 extension of the language tag 'de'.
    expect(resolveLocale('denmark', ALLOWED, 'en')).toBe('en');
    // Same logic with mixed case to confirm the boundary check is
    // structural, not casing-sensitive.
    expect(resolveLocale('DEnmark', ALLOWED, 'en')).toBe('en');
  });

  it('respects longest-prefix precedence when buckets overlap', () => {
    // Synthetic: caller declares both a regional bucket and the bare
    // language. The regional one should win when the input matches it.
    const overlap = ['pt-BR', 'pt'] as const;
    expect(resolveLocale('pt-BR', overlap, 'pt')).toBe('pt-BR');
    expect(resolveLocale('pt-BR-x-foo', overlap, 'pt')).toBe('pt-BR');
    expect(resolveLocale('pt-PT', overlap, 'pt')).toBe('pt');
    expect(resolveLocale('pt', overlap, 'pt')).toBe('pt');
  });
});
