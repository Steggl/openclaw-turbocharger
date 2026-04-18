import { describe, it } from 'vitest';

describe('proxy', () => {
  it.todo('forwards a chat/completions request to the configured downstream (issue #2)');
  it.todo('preserves request-id header on forward (issue #2)');
  it.todo(
    'streams the response back without buffering when the client asked for stream (issue #2)',
  );
});
