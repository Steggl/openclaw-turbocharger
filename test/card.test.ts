import { describe, expect, it } from 'vitest';

import {
  formatCard,
  formatCardPrefix,
  resolveCardLocale,
  type CardLocale,
} from '../src/transparency/card.js';
import type { EscalationTrace, OrchestratorDecision, Signal } from '../src/types.js';

function trace(
  stoppedReason: EscalationTrace['stoppedReason'],
  depth = 0,
  path: readonly string[] = [],
): EscalationTrace {
  return { path, stoppedReason, depth };
}

const REFUSAL_SIGNAL: Signal = {
  category: 'refusal',
  confidence: 0.92,
  reason: 'matched refusal phrase',
};

const TRUNCATION_SIGNAL: Signal = {
  category: 'truncation',
  confidence: 0.85,
  reason: 'finish_reason=length',
};

const ZERO_SIGNAL: Signal = {
  category: 'empty',
  confidence: 0,
  reason: 'no evidence',
};

const PASS_DECISION: OrchestratorDecision = {
  kind: 'pass',
  signals: [],
  aggregate: 0,
};

const ESCALATE_DECISION_HARD: OrchestratorDecision = {
  kind: 'escalate',
  reason: 'hard_signals',
  signals: [REFUSAL_SIGNAL],
  aggregate: 0.853,
};

const ESCALATE_DECISION_LLM: OrchestratorDecision = {
  kind: 'escalate',
  reason: 'llm_verdict',
  signals: [],
  aggregate: 0.45,
  verdict: { verdict: 'fail', confidence: 0.78, reason: 'answer is incomplete' },
};

describe('resolveCardLocale', () => {
  it.each<[string | undefined, CardLocale]>([
    [undefined, 'en'],
    ['', 'en'],
    ['en', 'en'],
    ['en-US', 'en'],
    ['fr', 'en'],
    ['fr-FR', 'en'],
    ['de', 'de'],
    ['de-DE', 'de'],
    ['de-AT', 'de'],
    ['de-CH', 'de'],
    ['DE-DE', 'de'],
    ['de_DE', 'de'],
  ])('resolves %s to %s', (input, expected) => {
    expect(resolveCardLocale(input)).toBe(expected);
  });
});

describe('formatCard — pass decisions, depth-aware', () => {
  it.each<string | undefined>(['en', 'de', undefined])(
    'returns null for pass with depth=0 in locale %s',
    (locale) => {
      expect(formatCard(PASS_DECISION, trace('passed'), 'weak-model', locale)).toBeNull();
      expect(formatCardPrefix(PASS_DECISION, trace('passed'), 'weak-model', locale)).toBeNull();
    },
  );

  it('emits a card for pass with depth>0 (re-query produced a passing answer) — English', () => {
    const card = formatCard(
      PASS_DECISION,
      trace('passed', 1, ['mid-model']),
      'weak-model',
      'en',
    );
    expect(card).toContain('[turbocharger card]');
    expect(card).toContain('Initial model: weak-model');
    expect(card).toContain('Decision: pass (after escalation)');
    expect(card).toContain('Path: weak-model → mid-model');
    expect(card).toContain('Outcome: passed at depth 1');
  });

  it('emits a card for pass with depth>0 — German', () => {
    const card = formatCard(
      PASS_DECISION,
      trace('passed', 1, ['mid-model']),
      'weak-model',
      'de',
    );
    expect(card).toContain('[turbocharger card]');
    expect(card).toContain('Initiales Modell: weak-model');
    expect(card).toContain('Entscheidung: pass (nach Eskalation)');
    expect(card).toContain('Pfad: weak-model → mid-model');
    expect(card).toContain('Ergebnis: passed bei Tiefe 1');
  });
});

describe('formatCard — escalate (hard_signals)', () => {
  it('emits a full card with all fields — English', () => {
    const card = formatCard(
      ESCALATE_DECISION_HARD,
      trace('passed', 1, ['mid-model']),
      'weak-model',
      'en',
    );
    expect(card).toBe(
      [
        '[turbocharger card]',
        '- Initial model: weak-model',
        '- Decision: escalate (hard_signals)',
        '- Signals: refusal (0.92)',
        '- Aggregate: 0.853',
        '- Path: weak-model → mid-model',
        '- Outcome: passed at depth 1',
      ].join('\n'),
    );
  });

  it('emits a full card — German', () => {
    const card = formatCard(
      ESCALATE_DECISION_HARD,
      trace('passed', 1, ['mid-model']),
      'weak-model',
      'de',
    );
    expect(card).toBe(
      [
        '[turbocharger card]',
        '- Initiales Modell: weak-model',
        '- Entscheidung: escalate (hard_signals)',
        '- Signale: refusal (0.92)',
        '- Aggregat: 0.853',
        '- Pfad: weak-model → mid-model',
        '- Ergebnis: passed bei Tiefe 1',
      ].join('\n'),
    );
  });

  it('lists multiple signals comma-separated', () => {
    const decision: OrchestratorDecision = {
      kind: 'escalate',
      reason: 'hard_signals',
      signals: [REFUSAL_SIGNAL, TRUNCATION_SIGNAL],
      aggregate: 0.95,
    };
    const card = formatCard(decision, trace('passed', 1, ['mid-model']), 'weak-model', 'en');
    expect(card).toContain('Signals: refusal (0.92), truncation (0.85)');
  });

  it('omits signals with confidence === 0 from the list', () => {
    const decision: OrchestratorDecision = {
      kind: 'escalate',
      reason: 'hard_signals',
      signals: [REFUSAL_SIGNAL, ZERO_SIGNAL],
      aggregate: 0.92,
    };
    const card = formatCard(decision, trace('passed', 1, ['mid-model']), 'weak-model', 'en');
    expect(card).toContain('Signals: refusal (0.92)');
    expect(card).not.toContain('empty');
  });

  it('omits the Signals line entirely when all signals have confidence 0', () => {
    const decision: OrchestratorDecision = {
      kind: 'escalate',
      reason: 'hard_signals',
      signals: [ZERO_SIGNAL],
      aggregate: 0.0,
    };
    const card = formatCard(decision, trace('passed', 1, ['mid-model']), 'weak-model', 'en');
    expect(card).not.toContain('Signals');
    expect(card).not.toContain('Signale');
  });

  it('omits the Signals line when signals is empty', () => {
    const decision: OrchestratorDecision = {
      kind: 'escalate',
      reason: 'hard_signals',
      signals: [],
      aggregate: 0.0,
    };
    const card = formatCard(decision, trace('passed', 1, ['mid-model']), 'weak-model', 'en');
    expect(card).not.toContain('Signals');
  });
});

describe('formatCard — escalate (llm_verdict)', () => {
  it('includes an LLM verdict line when verdict is present — English', () => {
    const card = formatCard(
      ESCALATE_DECISION_LLM,
      trace('passed', 1, ['mid-model']),
      'weak-model',
      'en',
    );
    expect(card).toContain('Decision: escalate (llm_verdict)');
    expect(card).toContain('LLM verdict: fail (0.78)');
  });

  it('includes the LLM verdict line in German', () => {
    const card = formatCard(
      ESCALATE_DECISION_LLM,
      trace('passed', 1, ['mid-model']),
      'weak-model',
      'de',
    );
    expect(card).toContain('LLM-Verdict: fail (0.78)');
  });

  it('does not include the LLM verdict line when verdict is absent', () => {
    const card = formatCard(
      ESCALATE_DECISION_HARD,
      trace('passed', 1, ['mid-model']),
      'weak-model',
      'en',
    );
    expect(card).not.toContain('LLM verdict');
    expect(card).not.toContain('LLM-Verdict');
  });
});

describe('formatCard — outcomes', () => {
  it.each<[EscalationTrace['stoppedReason'], string]>([
    ['max_depth_reached', 'stopped after reaching max depth'],
    ['ladder_exhausted', 'stopped after exhausting the ladder'],
    ['model_not_on_ladder', 'stopped because no stronger model is configured'],
    ['max_model_not_set', 'stopped because max-mode has no target model'],
    ['not_attempted', 'no escalation attempted (disabled)'],
  ])('renders outcome for %s in English', (stoppedReason, expectedText) => {
    const card = formatCard(
      ESCALATE_DECISION_HARD,
      trace(stoppedReason, 0, []),
      'weak-model',
      'en',
    );
    expect(card).toContain(`Outcome: ${expectedText}`);
  });

  it.each<[EscalationTrace['stoppedReason'], string]>([
    ['max_depth_reached', 'gestoppt nach Erreichen der Max-Tiefe'],
    ['ladder_exhausted', 'gestoppt nach Aufbrauch der Ladder'],
    ['model_not_on_ladder', 'gestoppt, weil kein stärkeres Modell konfiguriert ist'],
    ['max_model_not_set', 'gestoppt, weil Max-Mode kein Zielmodell hat'],
    ['not_attempted', 'keine Eskalation versucht (deaktiviert)'],
  ])('renders outcome for %s in German', (stoppedReason, expectedText) => {
    const card = formatCard(
      ESCALATE_DECISION_HARD,
      trace(stoppedReason, 0, []),
      'weak-model',
      'de',
    );
    expect(card).toContain(`Ergebnis: ${expectedText}`);
  });

  it('omits the Path line when path is empty (e.g. not_attempted)', () => {
    const card = formatCard(
      ESCALATE_DECISION_HARD,
      trace('not_attempted', 0, []),
      'weak-model',
      'en',
    );
    expect(card).not.toContain('Path:');
    expect(card).toContain('Outcome: no escalation attempted (disabled)');
  });
});

describe('formatCard — skipped decisions', () => {
  it('emits a short card for non_ok_status — English', () => {
    const decision: OrchestratorDecision = {
      kind: 'skipped',
      reason: 'non_ok_status',
      detail: '502 Bad Gateway',
    };
    const card = formatCard(decision, trace('not_attempted'), 'weak-model', 'en');
    expect(card).toBe(
      [
        '[turbocharger card]',
        '- Initial model: weak-model',
        '- Decision: skipped (non_ok_status)',
        '- Detail: 502 Bad Gateway',
      ].join('\n'),
    );
  });

  it('emits a short card for non_json_content_type — German', () => {
    const decision: OrchestratorDecision = {
      kind: 'skipped',
      reason: 'non_json_content_type',
    };
    const card = formatCard(decision, trace('not_attempted'), 'weak-model', 'de');
    expect(card).toBe(
      [
        '[turbocharger card]',
        '- Initiales Modell: weak-model',
        '- Entscheidung: skipped (non_json_content_type)',
      ].join('\n'),
    );
  });

  it('returns null for streaming-skipped (no card mapping)', () => {
    const decision: OrchestratorDecision = {
      kind: 'skipped',
      reason: 'streaming',
    };
    expect(formatCard(decision, trace('not_attempted'), 'weak-model', 'en')).toBeNull();
  });

  it('omits the Detail line when detail is undefined', () => {
    const decision: OrchestratorDecision = {
      kind: 'skipped',
      reason: 'non_ok_status',
    };
    const card = formatCard(decision, trace('not_attempted'), 'weak-model', 'en');
    expect(card).not.toContain('Detail');
  });

  it('omits the Detail line when detail is the empty string', () => {
    const decision: OrchestratorDecision = {
      kind: 'skipped',
      reason: 'non_ok_status',
      detail: '',
    };
    const card = formatCard(decision, trace('not_attempted'), 'weak-model', 'en');
    expect(card).not.toContain('Detail');
  });
});

describe('formatCardPrefix', () => {
  it('appends a separator and trailing blank line', () => {
    const prefix = formatCardPrefix(
      ESCALATE_DECISION_HARD,
      trace('passed', 1, ['mid-model']),
      'weak-model',
      'en',
    );
    expect(prefix).not.toBeNull();
    expect(prefix!.endsWith('\n\n---\n\n')).toBe(true);
  });

  it('returns null for pass + depth=0', () => {
    expect(formatCardPrefix(PASS_DECISION, trace('passed'), 'weak-model', 'en')).toBeNull();
  });
});
