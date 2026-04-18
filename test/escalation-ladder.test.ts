import { describe, it } from 'vitest';

describe('escalation: ladder', () => {
  it.todo('escalates one step on the configured chain on critic fail (issue #6)');
  it.todo(
    'can escalate multiple steps on repeated failure, bounded by max_escalation_depth (issue #6)',
  );
  it.todo('stops at the top of the ladder and surfaces that fact (issue #6)');
});
