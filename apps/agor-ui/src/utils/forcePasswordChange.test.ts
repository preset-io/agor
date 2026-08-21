import { describe, expect, it, vi } from 'vitest';
import { completeForcedPasswordChange, completeLocalPasswordChange } from './forcePasswordChange';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function makeClient(patch = vi.fn().mockResolvedValue({})) {
  return {
    service: vi.fn((name: string) => {
      if (name !== 'users') throw new Error(`unexpected service: ${name}`);
      return { patch };
    }),
  } as unknown as Parameters<typeof completeForcedPasswordChange>[0]['client'];
}

function authorityCycle(isCurrent: () => boolean = () => true) {
  return {
    userId: 'user-a',
    role: 'admin',
    accessToken: 'user-a-access',
    isCurrent,
  };
}

function options(overrides: Partial<Parameters<typeof completeForcedPasswordChange>[0]> = {}) {
  return {
    client: makeClient(),
    userId: 'user-a',
    email: 'a@example.test',
    newPassword: 'new-password-1234',
    authorityCycle: authorityCycle(),
    shouldApply: () => true,
    reauthenticate: vi.fn().mockResolvedValue('signed-in' as const),
    logout: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('completeForcedPasswordChange', () => {
  it('patches then establishes the same exact authority cycle', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const reauthenticate = vi.fn().mockResolvedValue('signed-in');
    const logout = vi.fn().mockResolvedValue(true);
    await expect(
      completeForcedPasswordChange(options({ client: makeClient(patch), reauthenticate, logout }))
    ).resolves.toBe(true);
    expect(patch).toHaveBeenCalledWith('user-a', { password: 'new-password-1234' });
    expect(reauthenticate).toHaveBeenCalledWith(
      'a@example.test',
      'new-password-1234',
      expect.objectContaining({ userId: 'user-a', role: 'admin' })
    );
    expect(logout).not.toHaveBeenCalled();
  });

  it('does not reauthenticate A when authority changes during the password patch', async () => {
    const pendingPatch = deferred<Record<string, never>>();
    let current = true;
    const reauthenticate = vi.fn();
    const logout = vi.fn();
    const result = completeForcedPasswordChange(
      options({
        client: makeClient(vi.fn(() => pendingPatch.promise)),
        shouldApply: () => current,
        authorityCycle: authorityCycle(() => current),
        reauthenticate,
        logout,
      })
    );
    current = false;
    pendingPatch.resolve({});
    await expect(result).resolves.toBeNull();
    expect(reauthenticate).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });

  it('does not apply a delayed A relogin failure continuation or log out B', async () => {
    const pendingLogin = deferred<'signed-in' | 'failed' | 'obsolete'>();
    let current = true;
    const logout = vi.fn().mockResolvedValue(true);
    const result = completeForcedPasswordChange(
      options({
        shouldApply: () => current,
        authorityCycle: authorityCycle(() => current),
        reauthenticate: vi.fn(() => pendingLogin.promise),
        logout,
      })
    );
    await Promise.resolve();
    current = false;
    pendingLogin.resolve('failed');
    await expect(result).resolves.toBeNull();
    expect(logout).not.toHaveBeenCalled();
  });

  it('accepts the guarded signed-in receipt when that exact install advances generation', async () => {
    let current = true;
    const logout = vi.fn();
    const reauthenticate = vi.fn(async () => {
      expect(current).toBe(true);
      // Installing A's new tokens is the operation's intended terminal
      // authority transition, so the old generation becomes stale here.
      current = false;
      return 'signed-in' as const;
    });
    await expect(
      completeForcedPasswordChange(options({ shouldApply: () => current, reauthenticate, logout }))
    ).resolves.toBe(true);
    expect(logout).not.toHaveBeenCalled();
  });

  it('logs out only when relogin fails while the captured authority is still exact', async () => {
    const logout = vi.fn().mockResolvedValue(true);
    await expect(
      completeForcedPasswordChange(
        options({ reauthenticate: vi.fn().mockResolvedValue('failed'), logout })
      )
    ).resolves.toBe(false);
    expect(logout).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-a', role: 'admin' })
    );
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
