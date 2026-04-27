import { describe, expect, it } from 'vitest';

import {
  formatBanner,
  formatBannerPrefix,
  resolveBannerLocale,
  type BannerLocale,
} from '../src/transparency/banner.js';
import type { EscalationTrace, OrchestratorDecision } from '../src/types.js';

function trace(
  stoppedReason: EscalationTrace['stoppedReason'],
  depth = 0,
  path: readonly string[] = [],
): EscalationTrace {
  return { path, stoppedReason, depth };
}

const PASS_DECISION: OrchestratorDecision = {
  kind: 'pass',
  signals: [],
  aggregate: 0,
};

const ESCALATE_DECISION: OrchestratorDecision = {
  kind: 'escalate',
  reason: 'hard_signals',
  signals: [],
  aggregate: 0.8,
};

describe('resolveBannerLocale', () => {
  it.each<[string | undefined, BannerLocale]>([
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
    ['deutsch', 'en'],
  ])('locale %s resolves to %s', (input, expected) => {
    expect(resolveBannerLocale(input)).toBe(expected);
  });
});

describe('formatBanner — pass decisions, depth-aware', () => {
  it.each<string | undefined>(['en', 'de', undefined])(
    'returns null for pass with depth=0 in locale %s',
    (locale) => {
      expect(formatBanner(PASS_DECISION, trace('passed'), locale)).toBeNull();
      expect(formatBannerPrefix(PASS_DECISION, trace('passed'), locale)).toBeNull();
    },
  );

  it('emits a banner for pass with depth>0 (re-query produced a passing answer) — English', () => {
    const banner = formatBanner(PASS_DECISION, trace('passed', 1, ['mid-model']), 'en');
    expect(banner).toContain('[turbocharger]');
    expect(banner).toContain('stronger model was used');
  });

  it('emits a banner for pass with depth>0 — German', () => {
    const banner = formatBanner(PASS_DECISION, trace('passed', 1, ['mid-model']), 'de');
    expect(banner).toContain('[turbocharger]');
    expect(banner).toContain('stärkeres Modell wurde verwendet');
  });
});

describe('formatBanner — escalate decisions, English', () => {
  it('passed: tells user a stronger model was used', () => {
    const banner = formatBanner(ESCALATE_DECISION, trace('passed', 1, ['mid-model']), 'en');
    expect(banner).toContain('[turbocharger]');
    expect(banner).toContain('stronger model was used');
    expect(banner).toContain('first answer looked incomplete');
  });

  it('max_depth_reached: tells user the last attempt was also flagged', () => {
    const banner = formatBanner(
      ESCALATE_DECISION,
      trace('max_depth_reached', 2, ['mid-model', 'strong-model']),
      'en',
    );
    expect(banner).toContain('[turbocharger]');
    expect(banner).toContain('its answer was also flagged');
  });

  it('ladder_exhausted: tells user the strongest model was tried', () => {
    const banner = formatBanner(
      ESCALATE_DECISION,
      trace('ladder_exhausted', 1, ['top-model']),
      'en',
    );
    expect(banner).toContain('[turbocharger]');
    expect(banner).toContain('strongest available model');
  });

  it('model_not_on_ladder: tells user no stronger model is configured', () => {
    const banner = formatBanner(ESCALATE_DECISION, trace('model_not_on_ladder'), 'en');
    expect(banner).toContain('[turbocharger]');
    expect(banner).toContain('no stronger model is configured');
  });

  it('max_model_not_set: tells user max-mode has no target', () => {
    const banner = formatBanner(ESCALATE_DECISION, trace('max_model_not_set'), 'en');
    expect(banner).toContain('[turbocharger]');
    expect(banner).toContain('max-mode escalation has no target');
  });

  it('not_attempted: tells user escalation is disabled', () => {
    const banner = formatBanner(ESCALATE_DECISION, trace('not_attempted'), 'en');
    expect(banner).toContain('[turbocharger]');
    expect(banner).toContain('escalation is disabled');
  });
});

describe('formatBanner — escalate decisions, German', () => {
  it('passed: deutscher Text', () => {
    const banner = formatBanner(ESCALATE_DECISION, trace('passed', 1, ['mid-model']), 'de');
    expect(banner).toContain('[turbocharger]');
    expect(banner).toContain('stärkeres Modell wurde verwendet');
  });

  it('max_depth_reached: deutscher Text', () => {
    const banner = formatBanner(
      ESCALATE_DECISION,
      trace('max_depth_reached', 2, ['mid-model', 'strong-model']),
      'de-DE',
    );
    expect(banner).toContain('[turbocharger]');
    expect(banner).toContain('als unzureichend markiert');
  });

  it('ladder_exhausted: deutscher Text', () => {
    const banner = formatBanner(ESCALATE_DECISION, trace('ladder_exhausted'), 'de-AT');
    expect(banner).toContain('[turbocharger]');
    expect(banner).toContain('stärkste verfügbare Modell');
  });

  it('not_attempted: deutscher Text', () => {
    const banner = formatBanner(ESCALATE_DECISION, trace('not_attempted'), 'de');
    expect(banner).toContain('[turbocharger]');
    expect(banner).toContain('Eskalation ist für diese Anfrage deaktiviert');
  });
});

describe('formatBanner — skipped decisions', () => {
  it('non_ok_status (en): tells user about downstream error', () => {
    const decision: OrchestratorDecision = { kind: 'skipped', reason: 'non_ok_status' };
    const banner = formatBanner(decision, trace('not_attempted'), 'en');
    expect(banner).toContain('[turbocharger]');
    expect(banner).toContain('error response');
  });

  it('non_ok_status (de): deutsche Fehlermeldung', () => {
    const decision: OrchestratorDecision = { kind: 'skipped', reason: 'non_ok_status' };
    const banner = formatBanner(decision, trace('not_attempted'), 'de');
    expect(banner).toContain('[turbocharger]');
    expect(banner).toContain('Fehlerantwort');
  });

  it('non_json_content_type (en): tells user response could not be evaluated', () => {
    const decision: OrchestratorDecision = { kind: 'skipped', reason: 'non_json_content_type' };
    const banner = formatBanner(decision, trace('not_attempted'), 'en');
    expect(banner).toContain('[turbocharger]');
    expect(banner).toContain('could not be evaluated');
  });

  it('streaming: returns null because banner does not apply to streamed responses', () => {
    // The pipeline never calls formatBanner for streaming responses
    // (ADR-0013 short-circuits before transparency injection runs),
    // but the function defends against accidental calls by returning
    // null for the streaming reason.
    const decision: OrchestratorDecision = { kind: 'skipped', reason: 'streaming' };
    expect(formatBanner(decision, trace('not_attempted'), 'en')).toBeNull();
    expect(formatBanner(decision, trace('not_attempted'), 'de')).toBeNull();
  });
});

describe('formatBannerPrefix', () => {
  it('appends a blank line separator after the banner text', () => {
    const prefix = formatBannerPrefix(ESCALATE_DECISION, trace('passed', 1, ['mid-model']), 'en');
    expect(prefix).not.toBeNull();
    expect(prefix!.endsWith('\n\n')).toBe(true);
  });

  it('returns null for pass decision', () => {
    expect(formatBannerPrefix(PASS_DECISION, trace('passed'), 'en')).toBeNull();
  });
});
