import { describe, expect, it } from 'vitest';
import { requireStreamingPublisherCapability } from './register-routes.js';

describe('streaming event publisher capability', () => {
  it('rejects an ordinary authenticated member', () => {
    expect(() =>
      requireStreamingPublisherCapability(
        {
          user: { user_id: 'member-1', role: 'member' },
          authentication: { payload: { type: 'access' } },
        } as never,
        { task_id: 'task-1', session_id: 'session-1' }
      )
    ).toThrow('Streaming events require an executor-scoped token');
  });

  it('accepts only full service or task-scoped executor principals', () => {
    expect(() =>
      requireStreamingPublisherCapability(
        {
          user: { user_id: 'executor-service', role: 'service', _isServiceAccount: true },
        } as never,
        {}
      )
    ).not.toThrow();
    expect(() =>
      requireStreamingPublisherCapability(
        {
          user: { user_id: 'creator-1', role: 'member' },
          authentication: {
            strategy: 'jwt',
            payload: {
              type: 'executor-session',
              purpose: 'executor-task',
              task_id: 'task-1',
              session_id: 'session-1',
            },
          },
        } as never,
        { task_id: 'task-1', session_id: 'session-1' }
      )
    ).not.toThrow();
  });

  it('rejects task and session attribution outside the verified executor lease', () => {
    const params = {
      user: { user_id: 'creator-1', role: 'member' },
      authentication: {
        strategy: 'jwt',
        payload: {
          type: 'executor-session',
          purpose: 'executor-task',
          task_id: 'task-1',
          session_id: 'session-1',
        },
      },
    } as never;

    expect(() =>
      requireStreamingPublisherCapability(params, {
        task_id: 'task-2',
        session_id: 'session-1',
      })
    ).toThrow('executor-scoped token');
    expect(() =>
      requireStreamingPublisherCapability(params, {
        task_id: 'task-1',
        session_id: 'session-2',
      })
    ).toThrow('session does not match');
  });
});
