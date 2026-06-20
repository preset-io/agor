import { describe, expect, it, vi } from 'vitest';
import type { SessionsServiceImpl } from './declarations';
import { markStoppedSessionPromptableAndDrainQueue } from './register-routes';

describe('markStoppedSessionPromptableAndDrainQueue', () => {
  it('marks the session promptable before triggering queue processing', async () => {
    const calls: string[] = [];
    const params = { provider: 'rest' };
    const sessionsService = {
      patch: vi.fn(async () => {
        calls.push('patch');
        return {};
      }),
      triggerQueueProcessing: vi.fn(async () => {
        calls.push('drain');
      }),
    } as unknown as Pick<SessionsServiceImpl, 'patch' | 'triggerQueueProcessing'>;

    await markStoppedSessionPromptableAndDrainQueue(sessionsService, 'session-1' as never, params);

    expect(sessionsService.patch).toHaveBeenCalledWith(
      'session-1',
      { status: 'idle', ready_for_prompt: true },
      params
    );
    expect(sessionsService.triggerQueueProcessing).toHaveBeenCalledWith('session-1', params);
    expect(calls).toEqual(['patch', 'drain']);
  });

  it('does not trigger the queue if the session patch fails', async () => {
    const sessionsService = {
      patch: vi.fn(async () => {
        throw new Error('patch denied');
      }),
      triggerQueueProcessing: vi.fn(async () => {}),
    } as unknown as Pick<SessionsServiceImpl, 'patch' | 'triggerQueueProcessing'>;

    await expect(
      markStoppedSessionPromptableAndDrainQueue(sessionsService, 'session-1' as never, {})
    ).rejects.toThrow('patch denied');
    expect(sessionsService.triggerQueueProcessing).not.toHaveBeenCalled();
  });
});
