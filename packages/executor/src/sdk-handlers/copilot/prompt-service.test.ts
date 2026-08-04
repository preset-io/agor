import { describe, expect, it, vi } from 'vitest';
import type { SessionID } from '../../types.js';
import { CopilotPromptService } from './prompt-service.js';

const sessionId = '01980d95-43cd-7a46-a0af-6dbf2aaa121e' as SessionID;

function createService(): CopilotPromptService {
  return new CopilotPromptService({} as never, {} as never);
}

describe('CopilotPromptService', () => {
  it('does not launch SDK work after cancellation', async () => {
    const service = createService();
    const abortController = new AbortController();
    abortController.abort();

    const result = await service
      .promptSessionStreaming(sessionId, 'prompt', undefined, undefined, abortController)
      .next();

    expect(result.value).toEqual({ type: 'stopped', sessionId: '' });
    expect(result.done).toBe(false);
  });

  it('confirms cancellation only after the SDK client stops', async () => {
    const service = createService();
    const stop = vi.fn().mockResolvedValue(undefined);
    Reflect.set(service, 'client', { stop });

    await expect(service.stopTask(sessionId)).resolves.toEqual({ success: true });
    expect(stop).toHaveBeenCalledOnce();
    expect(Reflect.get(service, 'client')).toBeNull();
  });

  it('keeps cancellation unverified when the SDK client cannot stop', async () => {
    const service = createService();
    Reflect.set(service, 'client', {
      stop: vi.fn().mockRejectedValue(new Error('stop failed')),
    });

    await expect(service.stopTask(sessionId)).resolves.toEqual({
      success: false,
      reason: 'stop failed',
    });
  });
});
