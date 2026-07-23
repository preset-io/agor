import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from './permission-service.js';

describe('executor PermissionService', () => {
  it('fails closed immediately when the task signal is already aborted', async () => {
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    const service = new PermissionService(emitEvent, 10);
    const controller = new AbortController();
    controller.abort('User Stop');

    const decision = await service.waitForDecision(
      'request-1',
      '00000000-0000-7000-8000-000000000002' as never,
      '00000000-0000-7000-8000-000000000001' as never,
      controller.signal
    );
    expect(decision).toMatchObject({
      allow: false,
      reason: 'Cancelled',
    });
    expect(decision.timedOut).toBeUndefined();
    expect(emitEvent).not.toHaveBeenCalledWith('permission:timeout', expect.anything());
  });
});
