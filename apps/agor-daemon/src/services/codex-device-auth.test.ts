import { describe, expect, it, vi } from 'vitest';
import { CodexDeviceAuthService } from './codex-device-auth';

describe('CodexDeviceAuthService', () => {
  it('starts a device auth flow for the current user', async () => {
    const manager = {
      start: vi.fn().mockResolvedValue({
        flowId: 'flow-1',
        agorUserId: 'user-a',
        status: 'pending',
      }),
    } as any;
    const config = {} as any;
    const service = new CodexDeviceAuthService(config, manager);

    const result = await service.create({}, {
      user: { user_id: 'user-a' },
    } as any);

    expect(manager.start).toHaveBeenCalledWith(config, { agorUserId: 'user-a' });
    expect(result).toMatchObject({ flowId: 'flow-1', agorUserId: 'user-a' });
  });

  it('forbids reading another user flow', async () => {
    const service = new CodexDeviceAuthService(
      {} as any,
      {
        get: vi.fn().mockReturnValue({
          flowId: 'flow-1',
          agorUserId: 'user-b',
          status: 'pending',
        }),
      } as any
    );

    await expect(
      service.get('flow-1', {
        user: { user_id: 'user-a' },
      } as any)
    ).rejects.toThrow("Cannot access another user's Codex auth flow");
  });

  it('forbids cancelling another user flow', async () => {
    const service = new CodexDeviceAuthService(
      {} as any,
      {
        get: vi.fn().mockReturnValue({
          flowId: 'flow-1',
          agorUserId: 'user-b',
          status: 'pending',
        }),
        cancel: vi.fn(),
      } as any
    );

    await expect(
      service.remove('flow-1', {
        user: { user_id: 'user-a' },
      } as any)
    ).rejects.toThrow("Cannot cancel another user's Codex auth flow");
  });
});
