import { describe, expect, it } from 'vitest';
import { requireStreamingPublisherCapability } from './register-routes.js';

describe('streaming event publisher capability', () => {
  it('rejects an ordinary authenticated member', () => {
    expect(() =>
      requireStreamingPublisherCapability({
        user: { user_id: 'member-1', role: 'member' },
        authentication: { payload: { type: 'access' } },
      } as never)
    ).toThrow('Streaming events require an executor-scoped token');
  });

  it('accepts only full service or task-scoped executor principals', () => {
    expect(() =>
      requireStreamingPublisherCapability({
        user: { user_id: 'executor-service', role: 'service', _isServiceAccount: true },
      } as never)
    ).not.toThrow();
    expect(() =>
      requireStreamingPublisherCapability({
        user: { user_id: 'creator-1', role: 'member' },
        authentication: {
          payload: {
            type: 'executor-session',
            purpose: 'executor-task',
            task_id: 'task-1',
          },
        },
      } as never)
    ).not.toThrow();
  });
});
