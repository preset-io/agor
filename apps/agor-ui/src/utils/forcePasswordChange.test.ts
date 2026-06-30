import { describe, expect, it, vi } from 'vitest';
import { completeForcedPasswordChange } from './forcePasswordChange';

function makeClient(patch = vi.fn().mockResolvedValue({})) {
  return {
    service: vi.fn((name: string) => {
      if (name !== 'users') throw new Error(`unexpected service: ${name}`);
      return { patch };
    }),
  } as unknown as Parameters<typeof completeForcedPasswordChange>[0]['client'];
}

describe('completeForcedPasswordChange', () => {
  it('patches the password then signs in with the new password', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const login = vi.fn().mockResolvedValue(true);
    const logout = vi.fn().mockResolvedValue(undefined);

    const result = await completeForcedPasswordChange({
      client: makeClient(patch),
      userId: 'user-1',
      email: 'person@example.test',
      newPassword: 'new-password-1234',
      login,
      logout,
    });

    expect(result).toBe(true);
    expect(patch).toHaveBeenCalledWith('user-1', { password: 'new-password-1234' });
    expect(login).toHaveBeenCalledWith('person@example.test', 'new-password-1234');
    expect(logout).not.toHaveBeenCalled();
  });

  it('clears stale local state when the fresh sign-in fails', async () => {
    const login = vi.fn().mockResolvedValue(false);
    const logout = vi.fn().mockResolvedValue(undefined);

    const result = await completeForcedPasswordChange({
      client: makeClient(),
      userId: 'user-1',
      email: 'person@example.test',
      newPassword: 'new-password-1234',
      login,
      logout,
    });

    expect(result).toBe(false);
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
