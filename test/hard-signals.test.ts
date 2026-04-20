import { describe, expect, it } from 'vitest';

import {
  collectHardSignals,
  emptyDetector,
  HARD_SIGNAL_DETECTORS,
  refusalDetector,
  repetitionDetector,
  syntaxErrorDetector,
  toolErrorDetector,
  truncationDetector,
} from '../src/critic/index.js';
import type { DetectorInput, Signal } from '../src/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a DetectorInput with sensible defaults; spread overrides to tune
 * specific cases. The default user prompt is intentionally long enough
 * that the empty/short detector stays silent unless a test targets it
 * explicitly.
 */
function makeInput(overrides: Partial<DetectorInput> = {}): DetectorInput {
  const base: DetectorInput = {
    response: 'Default response text with enough content to not trip the empty detector.',
    userPrompt:
      'Please write a short friendly greeting. The prompt is deliberately long so that ' +
      'the empty-response detector stays silent unless a test targets it.',
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// refusalDetector
// ---------------------------------------------------------------------------

describe('refusalDetector', () => {
  it('flags explicit English refusal with high confidence', () => {
    const signal = refusalDetector(
      makeInput({ response: "I'm sorry, but I cannot help with that request." }),
    );
    expect(signal).not.toBeNull();
    expect(signal?.category).toBe('refusal');
    expect(signal?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('flags explicit German refusal with high confidence', () => {
    const signal = refusalDetector(
      makeInput({
        response: 'Leider, aber ich kann dir nicht helfen, das ist nicht möglich.',
        locale: 'de',
      }),
    );
    expect(signal).not.toBeNull();
    expect(signal?.category).toBe('refusal');
    expect(signal?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('flags AI-disclaimer boilerplate at medium confidence when no stronger match is present', () => {
    const signal = refusalDetector(
      makeInput({
        response: 'As an AI language model, here is some general guidance on the topic.',
      }),
    );
    expect(signal).not.toBeNull();
    expect(signal?.confidence).toBeCloseTo(0.7, 1);
  });

  it('flags soft hedging at low confidence', () => {
    const signal = refusalDetector(
      makeInput({
        response:
          'I would advise caution when interpreting these numbers because the data has gaps.',
      }),
    );
    expect(signal).not.toBeNull();
    expect(signal?.confidence).toBeCloseTo(0.4, 1);
  });

  it('returns null for an adequate response', () => {
    const signal = refusalDetector(
      makeInput({ response: 'Here is a helpful answer to your question with concrete details.' }),
    );
    expect(signal).toBeNull();
  });

  it('falls back to English patterns when the hinted locale is unknown', () => {
    const signal = refusalDetector(
      makeInput({ response: "I'm sorry, but I cannot help with that.", locale: 'fr' }),
    );
    expect(signal).not.toBeNull();
  });

  it('reports the highest-confidence match when multiple patterns fire', () => {
    const signal = refusalDetector(
      makeInput({
        response:
          "As an AI language model, I have concerns about this. I'm sorry, but I cannot help.",
      }),
    );
    expect(signal?.confidence).toBeGreaterThanOrEqual(0.95);
  });
});

// ---------------------------------------------------------------------------
// truncationDetector
// ---------------------------------------------------------------------------

describe('truncationDetector', () => {
  it('returns null when finish_reason is not "length"', () => {
    const signal = truncationDetector(
      makeInput({ response: 'Complete answer here.', finishReason: 'stop' }),
    );
    expect(signal).toBeNull();
  });

  it('high confidence when text ends mid-thought', () => {
    const signal = truncationDetector(
      makeInput({ response: 'The capital of France is Par', finishReason: 'length' }),
    );
    expect(signal?.category).toBe('truncation');
    expect(signal?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('medium confidence when text ends with a natural terminator', () => {
    const signal = truncationDetector(
      makeInput({
        response: 'The capital of France is Paris. It is a large city.',
        finishReason: 'length',
      }),
    );
    expect(signal?.category).toBe('truncation');
    expect(signal?.confidence).toBeLessThan(0.85);
    expect(signal?.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('recognises German sentence terminators', () => {
    const signal = truncationDetector(
      makeInput({
        response: 'Die Hauptstadt Frankreichs ist Paris.',
        finishReason: 'length',
        locale: 'de',
      }),
    );
    expect(signal?.confidence).toBeLessThan(0.85);
  });

  it('ignores trailing whitespace and closing quotes when checking terminator', () => {
    const signal = truncationDetector(
      makeInput({ response: '"The answer is yes."   ', finishReason: 'length' }),
    );
    expect(signal?.confidence).toBeLessThan(0.85);
  });

  it('returns null when length=finish_reason but response is empty (emptyDetector handles that)', () => {
    const signal = truncationDetector(makeInput({ response: '', finishReason: 'length' }));
    expect(signal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// repetitionDetector
// ---------------------------------------------------------------------------

describe('repetitionDetector', () => {
  it('returns null for short responses (below MIN_TOKENS)', () => {
    const signal = repetitionDetector(
      makeInput({ response: 'Hello world, hello world, hello world.' }),
    );
    expect(signal).toBeNull();
  });

  it('returns null for responses without sufficient repetition', () => {
    const response =
      'This response has enough tokens to clear the minimum threshold but ' +
      'does not contain any repeated four-word sequences anywhere within its ' +
      'otherwise perfectly reasonable textual content that continues onwards.';
    expect(repetitionDetector(makeInput({ response }))).toBeNull();
  });

  it('flags clearly degenerate repetition loops', () => {
    const phrase = 'the system is ready';
    const response = Array.from({ length: 10 }, () => phrase).join(' ') + ' end of response.';
    const signal = repetitionDetector(makeInput({ response }));
    expect(signal?.category).toBe('repetition');
    expect(signal?.confidence).toBeGreaterThanOrEqual(0.4);
  });

  it('assigns higher confidence when repetition dominates the text', () => {
    const loopy = Array.from({ length: 20 }, () => 'ok ok ok ok').join(' ');
    const sparse =
      Array.from({ length: 3 }, () => 'same phrase repeats here').join(' ') +
      ' ' +
      'followed by a long stretch of unique and non-repeating text that fills the rest.';

    const loopySignal = repetitionDetector(makeInput({ response: loopy }));
    const sparseSignal = repetitionDetector(makeInput({ response: sparse }));

    expect(loopySignal).not.toBeNull();
    if (loopySignal !== null && sparseSignal !== null) {
      expect(loopySignal.confidence).toBeGreaterThanOrEqual(sparseSignal.confidence);
    }
  });
});

// ---------------------------------------------------------------------------
// emptyDetector
// ---------------------------------------------------------------------------

describe('emptyDetector', () => {
  it('flags a fully empty response', () => {
    const signal = emptyDetector(makeInput({ response: '' }));
    expect(signal?.category).toBe('empty');
    expect(signal?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('flags a very short response to a non-trivial prompt', () => {
    const signal = emptyDetector(
      makeInput({
        response: 'ok',
        userPrompt:
          'Please explain the key differences between TCP and UDP protocols in networking.',
      }),
    );
    expect(signal?.category).toBe('empty');
    expect(signal?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('returns null when response is proportional to a short prompt', () => {
    const signal = emptyDetector(
      makeInput({ response: 'Here is a reasonable answer.', userPrompt: 'Short question?' }),
    );
    expect(signal).toBeNull();
  });

  it('medium confidence for a short response to a long prompt', () => {
    const signal = emptyDetector(
      makeInput({
        response: 'Yes, that is correct.',
        userPrompt:
          'Could you please provide a detailed overview of the historical development of ' +
          'quantum mechanics, starting with the early work of Planck and Einstein, moving ' +
          'through the Bohr model, and culminating in the formulation by Heisenberg, ' +
          'Schrödinger, and Dirac? Please include the key experimental evidence that ' +
          'supported each step of the way.',
      }),
    );
    expect(signal?.category).toBe('empty');
    expect(signal?.confidence).toBeCloseTo(0.6, 1);
  });
});

// ---------------------------------------------------------------------------
// toolErrorDetector
// ---------------------------------------------------------------------------

describe('toolErrorDetector', () => {
  it('flags a Python-style traceback', () => {
    const response = [
      'I tried to run that for you but got:',
      'Traceback (most recent call last):',
      '  File "<stdin>", line 1, in <module>',
      "TypeError: unsupported operand type(s) for +: 'int' and 'str'",
    ].join('\n');
    const signal = toolErrorDetector(makeInput({ response }));
    expect(signal?.category).toBe('tool_error');
    expect(signal?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('flags a generic Error marker at line start', () => {
    const signal = toolErrorDetector(
      makeInput({ response: 'Let me try that:\nError: connection refused.' }),
    );
    expect(signal?.category).toBe('tool_error');
  });

  it('does not flag the word "error" used in prose', () => {
    const signal = toolErrorDetector(
      makeInput({
        response:
          'One common error when learning TypeScript is thinking it runs at runtime; it does not.',
      }),
    );
    expect(signal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// syntaxErrorDetector — JSON only per ADR-0008
// ---------------------------------------------------------------------------

describe('syntaxErrorDetector', () => {
  it('returns null when the response has no JSON fence', () => {
    const signal = syntaxErrorDetector(
      makeInput({ response: 'Here is a textual answer with no code fences at all.' }),
    );
    expect(signal).toBeNull();
  });

  it('returns null when every JSON fence parses cleanly', () => {
    const response = 'Here you go:\n```json\n{"ok": true, "count": 42}\n```\nEnjoy!';
    expect(syntaxErrorDetector(makeInput({ response }))).toBeNull();
  });

  it('flags a JSON fence that fails to parse', () => {
    const response = 'Here you go:\n```json\n{"ok": true, "count": 42,}\n```';
    const signal = syntaxErrorDetector(makeInput({ response }));
    expect(signal?.category).toBe('syntax_error');
    expect(signal?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('ignores untagged fences even when their content is not JSON', () => {
    const response = 'Here is some code:\n```\nnot valid json {\n```';
    expect(syntaxErrorDetector(makeInput({ response }))).toBeNull();
  });

  it('reports the failure when any of several JSON blocks is malformed', () => {
    const response = 'First:\n```json\n{"a":1}\n```\nSecond:\n```json\n{broken json}\n```';
    const signal = syntaxErrorDetector(makeInput({ response }));
    expect(signal).not.toBeNull();
    expect(signal?.reason).toContain('1 of 2');
  });
});

// ---------------------------------------------------------------------------
// collectHardSignals — composition
// ---------------------------------------------------------------------------

describe('collectHardSignals', () => {
  it('returns an empty list when the response is adequate', () => {
    const signals = collectHardSignals(
      makeInput({
        response:
          'Sure — here is a friendly greeting: "Hello, nice to meet you. How may I help you today?"',
      }),
    );
    expect(signals).toEqual([]);
  });

  it('collects signals from multiple categories when several detectors fire', () => {
    const input = makeInput({
      response: "I'm sorry, but I cannot",
      userPrompt:
        'Please explain the Ship of Theseus paradox in three paragraphs with historical references.',
      finishReason: 'length',
    });
    const signals = collectHardSignals(input);
    const categories = new Set(signals.map((s: Signal) => s.category));
    expect(categories.has('refusal')).toBe(true);
    expect(categories.has('truncation')).toBe(true);
  });

  it('preserves the canonical detector order in its output', () => {
    // Refusal fires at index 0 in HARD_SIGNAL_DETECTORS; syntax_error fires at
    // index 5. If both are present, refusal must appear first in the result.
    const input = makeInput({
      response: 'I cannot help with that.\n```json\n{broken}\n```',
      userPrompt:
        'Please explain how to implement a JSON parser in Python and include an example payload.',
    });
    const signals = collectHardSignals(input);
    const refusalIdx = signals.findIndex((s: Signal) => s.category === 'refusal');
    const syntaxIdx = signals.findIndex((s: Signal) => s.category === 'syntax_error');
    expect(refusalIdx).toBeGreaterThanOrEqual(0);
    expect(syntaxIdx).toBeGreaterThanOrEqual(0);
    expect(refusalIdx).toBeLessThan(syntaxIdx);
  });

  it('exposes the expected number of detectors', () => {
    // Sentinel: when a detector is added, this test reminds the author to
    // update the SignalCategory union and the suites above.
    expect(HARD_SIGNAL_DETECTORS).toHaveLength(6);
  });
});
