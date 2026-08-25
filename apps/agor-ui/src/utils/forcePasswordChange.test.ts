import { describe, expect, it, vi } from 'vitest';
import { completeForcedPasswordChange, completeLocalPasswordChange } from './forcePasswordChange';

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

describe('completeLocalPasswordChange', () => {
  it('patches all settings and reauthenticates with the post-change email', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const login = vi.fn().mockResolvedValue(true);
    const updates = {
      email: 'new@example.test',
      password: 'new-password-1234',
      name: 'Updated User',
    };

    await completeLocalPasswordChange({
      client: makeClient(patch),
      userId: 'user-1',
      emailAfterChange: updates.email,
      newPassword: updates.password,
      updates,
      login,
      logout: vi.fn(),
    });

    expect(patch).toHaveBeenCalledWith('user-1', updates);
    expect(login).toHaveBeenCalledWith('new@example.test', 'new-password-1234');
  });

  it('logs out when reauthentication rejects after the credential write', async () => {
    const loginError = new Error('authentication transport failed');
    const logout = vi.fn().mockResolvedValue(undefined);

    await expect(
      completeLocalPasswordChange({
        client: makeClient(),
        userId: 'user-1',
        emailAfterChange: 'person@example.test',
        newPassword: 'new-password-1234',
        updates: { password: 'new-password-1234' },
        login: vi.fn().mockRejectedValue(loginError),
        logout,
      })
    ).rejects.toBe(loginError);
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
