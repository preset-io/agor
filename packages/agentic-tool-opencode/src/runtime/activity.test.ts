import { describe, expect, it } from 'vitest';
import { mapOpenCodeActivity } from './activity';

describe('mapOpenCodeActivity', () => {
  it('maps native event vocabulary without leaking unbounded detail', () => {
    expect(mapOpenCodeActivity('message.part.updated')).toEqual({
      kind: 'progress',
      detail: 'message.part.updated',
    });
    const unknown = mapOpenCodeActivity('future event/'.repeat(30));
    expect(unknown?.kind).toBe('unknown_activity');
    expect(unknown?.detail).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(unknown?.detail).toHaveLength(128);
  });

  it('ignores transport heartbeats', () => {
    expect(mapOpenCodeActivity('server.heartbeat')).toBeUndefined();
  });
});
