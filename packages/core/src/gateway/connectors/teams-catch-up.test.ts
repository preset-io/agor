import { describe, expect, it } from 'vitest';
import { boundTeamsCatchUp } from './teams-catch-up';

const row = (text: string, activityId = 'activity-1') => ({
  activityId,
  timestamp: '2026-08-27T12:00:00.000Z',
  actorLabel: 'Ada',
  text,
  isBot: false,
  isMention: false,
});

describe('boundTeamsCatchUp', () => {
  it('bounds by message count and prompt bytes without reordering', () => {
    expect(
      boundTeamsCatchUp([row('one'), row('two', 'activity-2')], {
        maxMessages: 1,
        maxPromptBytes: 100,
      })
    ).toEqual({
      activities: [row('one')],
      complete: false,
      reason: 'truncated',
    });
    expect(boundTeamsCatchUp([row('é')], { maxMessages: 10, maxPromptBytes: 1 }).reason).toBe(
      'truncated'
    );
  });

  it('rejects invalid bounds and malformed provider history', () => {
    expect(boundTeamsCatchUp([row('ok')], { maxMessages: 0, maxPromptBytes: 10 }).reason).toBe(
      'invalid'
    );
    expect(
      boundTeamsCatchUp([{ ...row(''), activityId: 'activity-1' }], {
        maxMessages: 10,
        maxPromptBytes: 10,
      }).reason
    ).toBe('invalid');
  });
});
