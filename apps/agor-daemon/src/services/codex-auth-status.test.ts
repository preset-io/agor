import { describe, expect, it, vi } from 'vitest';
import { CodexAuthStatusService } from './codex-auth-status';

describe('CodexAuthStatusService', () => {
  it('returns the current user status instead of a shared global home', async () => {
    const manager = {
      getStatusForUser: vi.fn().mockResolvedValue({
        agorUserId: 'user-a',
        status: 'not_signed_in',
        codexHome: '/tmp/.agor/codex/users/user-a',
      }),
    } as any;
    const service = new CodexAuthStatusService(manager);

    const result = await service.get('current', {
      user: { user_id: 'user-a' },
    } as any);

    expect(manager.getStatusForUser).toHaveBeenCalledWith('user-a');
    expect(result).toMatchObject({
      agorUserId: 'user-a',
      codexHome: '/tmp/.agor/codex/users/user-a',
    });
  });

  it('requires an authenticated user', async () => {
    const service = new CodexAuthStatusService({
      getStatusForUser: vi.fn(),
    } as any);

    await expect(service.get('current', {} as any)).rejects.toThrow('Authentication required');
  });

  it('disconnects the current user instead of touching shared auth state', async () => {
    const manager = {
      getStatusForUser: vi.fn(),
      disconnectUser: vi.fn().mockResolvedValue({
        success: true,
        codexHome: '/tmp/.agor/codex/users/user-a',
      }),
    } as any;
    const service = new CodexAuthStatusService(manager);

    const result = await service.remove('current', {
      user: { user_id: 'user-a' },
    } as any);

    expect(manager.disconnectUser).toHaveBeenCalledWith('user-a');
    expect(result).toEqual({
      success: true,
      codexHome: '/tmp/.agor/codex/users/user-a',
    });
  });
});
