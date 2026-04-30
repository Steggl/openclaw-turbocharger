import { describe, expect, it } from 'vitest';

import { formatRejectedHeader, parseRequestOverrides } from '../src/config/overrides.js';
import type { ChorusConfig } from '../src/types.js';

const chorusConfigured: ChorusConfig = {
  endpoint: 'http://localhost:11436/v1/chat/completions',
};

describe('parseRequestOverrides', () => {
  it('returns no overrides and empty rejected list when no headers are set', () => {
    const result = parseRequestOverrides(new Headers(), chorusConfigured);
    expect(result.answerMode).toBeUndefined();
    expect(result.transparencyMode).toBeUndefined();
    expect(result.rejected).toEqual([]);
  });

  it('parses X-Turbocharger-Answer-Mode: single', () => {
    const headers = new Headers({ 'x-turbocharger-answer-mode': 'single' });
    const result = parseRequestOverrides(headers, chorusConfigured);
    expect(result.answerMode).toBe('single');
    expect(result.rejected).toEqual([]);
  });

  it('parses X-Turbocharger-Answer-Mode: chorus when chorus is configured', () => {
    const headers = new Headers({ 'x-turbocharger-answer-mode': 'chorus' });
    const result = parseRequestOverrides(headers, chorusConfigured);
    expect(result.answerMode).toBe('chorus');
    expect(result.rejected).toEqual([]);
  });

  it('rejects chorus override when chorus is not configured', () => {
    const headers = new Headers({ 'x-turbocharger-answer-mode': 'chorus' });
    const result = parseRequestOverrides(headers, undefined);
    expect(result.answerMode).toBeUndefined();
    expect(result.rejected).toEqual([
      { field: 'answer-mode', value: 'chorus', reason: 'chorus-config-missing' },
    ]);
  });

  it('rejects an unrecognised answer-mode value', () => {
    const headers = new Headers({ 'x-turbocharger-answer-mode': 'dance' });
    const result = parseRequestOverrides(headers, chorusConfigured);
    expect(result.answerMode).toBeUndefined();
    expect(result.rejected).toEqual([
      { field: 'answer-mode', value: 'dance', reason: 'invalid-value' },
    ]);
  });

  it.each(['silent', 'banner', 'card'] as const)(
    'parses X-Turbocharger-Transparency: %s',
    (mode) => {
      const headers = new Headers({ 'x-turbocharger-transparency': mode });
      const result = parseRequestOverrides(headers, chorusConfigured);
      expect(result.transparencyMode).toBe(mode);
      expect(result.rejected).toEqual([]);
    },
  );

  it('rejects an unrecognised transparency value', () => {
    const headers = new Headers({ 'x-turbocharger-transparency': 'flashy' });
    const result = parseRequestOverrides(headers, chorusConfigured);
    expect(result.transparencyMode).toBeUndefined();
    expect(result.rejected).toEqual([
      { field: 'transparency', value: 'flashy', reason: 'invalid-value' },
    ]);
  });

  it('parses both headers together', () => {
    const headers = new Headers({
      'x-turbocharger-answer-mode': 'single',
      'x-turbocharger-transparency': 'card',
    });
    const result = parseRequestOverrides(headers, chorusConfigured);
    expect(result.answerMode).toBe('single');
    expect(result.transparencyMode).toBe('card');
    expect(result.rejected).toEqual([]);
  });

  it('aggregates multiple rejections into one list', () => {
    const headers = new Headers({
      'x-turbocharger-answer-mode': 'dance',
      'x-turbocharger-transparency': 'flashy',
    });
    const result = parseRequestOverrides(headers, chorusConfigured);
    expect(result.answerMode).toBeUndefined();
    expect(result.transparencyMode).toBeUndefined();
    expect(result.rejected).toHaveLength(2);
  });

  it('treats header values case-insensitively', () => {
    const headers = new Headers({
      'x-turbocharger-answer-mode': 'CHORUS',
      'x-turbocharger-transparency': 'Banner',
    });
    const result = parseRequestOverrides(headers, chorusConfigured);
    expect(result.answerMode).toBe('chorus');
    expect(result.transparencyMode).toBe('banner');
  });

  it('trims whitespace around header values', () => {
    const headers = new Headers({ 'x-turbocharger-answer-mode': '  single  ' });
    const result = parseRequestOverrides(headers, chorusConfigured);
    expect(result.answerMode).toBe('single');
  });

  it('silently ignores empty-string header values (likely client bug)', () => {
    const headers = new Headers({
      'x-turbocharger-answer-mode': '   ',
      'x-turbocharger-transparency': '',
    });
    const result = parseRequestOverrides(headers, chorusConfigured);
    expect(result.answerMode).toBeUndefined();
    expect(result.transparencyMode).toBeUndefined();
    expect(result.rejected).toEqual([]);
  });
});

describe('formatRejectedHeader', () => {
  it('returns null when nothing was rejected', () => {
    expect(formatRejectedHeader([])).toBeNull();
  });

  it('renders one rejection as field=value:reason', () => {
    expect(
      formatRejectedHeader([{ field: 'answer-mode', value: 'dance', reason: 'invalid-value' }]),
    ).toBe('answer-mode=dance:invalid-value');
  });

  it('joins multiple rejections with comma-space', () => {
    expect(
      formatRejectedHeader([
        { field: 'answer-mode', value: 'dance', reason: 'invalid-value' },
        { field: 'transparency', value: 'flashy', reason: 'invalid-value' },
      ]),
    ).toBe('answer-mode=dance:invalid-value, transparency=flashy:invalid-value');
  });

  it('preserves the chorus-config-missing reason in the output', () => {
    expect(
      formatRejectedHeader([
        { field: 'answer-mode', value: 'chorus', reason: 'chorus-config-missing' },
      ]),
    ).toBe('answer-mode=chorus:chorus-config-missing');
  });
});
