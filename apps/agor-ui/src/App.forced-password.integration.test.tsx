import type { AgorClient, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForcePasswordChangeModal } from './components/ForcePasswordChangeModal';
import { ConnectionProvider } from './contexts/ConnectionContext';
import { useAuth } from './hooks/useAuth';
import { useAuthorityOperationGuard } from './hooks/useAuthorityOperationGuard';
import { useForcedPasswordChangeHandler } from './hooks/useForcedPasswordChangeHandler';
import { TOKENS_REFRESHED_EVENT } from './utils/singleFlightRefresh';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from './utils/tokenRefresh';

const authenticate = vi.fn();

vi.mock('@agor-live/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor-live/client')>();
  return {
    ...actual,
    createRestClient: vi.fn(async () => ({ authenticate })),
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function authUser(id: string, mustChangePassword: boolean): User {
  return {
    user_id: id,
    email: `${id}@example.test`,
    role: 'admin',
    must_change_password: mustChangePassword,
  } as User;
}

/**
 * Exercises the production composition that caused the regression: useAuth's
 * global loading state is checked before the forced-password modal, so local
 * reauthentication unmounts the modal that initiated it. The durable ticket is
 * App-owned and therefore outlives that loading-gate unmount.
 */
function ForcedPasswordAppComposition({
  client,
  authGeneration = 4,
  onCompleted,
}: {
  client: AgorClient;
  authGeneration?: number;
  onCompleted?: (signedIn: boolean) => void;
}) {
  const auth = useAuth();
  const appGuard = useAuthorityOperationGuard(
    auth.user?.user_id && auth.user.role && auth.authenticated
      ? [auth.user.user_id, auth.user.role, client, authGeneration]
      : null
  );

  const changePassword = useForcedPasswordChangeHandler({
    client,
    user: auth.user,
    appAuthorityGuard: appGuard,
    captureAuthorityCycle: auth.captureAuthorityCycle,
    reauthenticate: auth.loginForAuthorityCycle,
    logout: auth.logoutForAuthorityCycle,
    onCompleted,
  });

  // This is the real App ordering: loading wins and unmounts the modal.
  if (auth.loading) return <div>Authenticating…</div>;
  if (!auth.authenticated || !auth.user) return <div>Signed out</div>;
  if (!auth.user.must_change_password) return <div>Ready: {auth.user.user_id}</div>;

  return (
    <ConnectionProvider
      value={{
        connected: true,
        connecting: false,
        authGeneration,
        outOfSync: false,
        capturedSha: null,
        currentSha: null,
      }}
    >
      <ForcePasswordChangeModal
        open
        user={auth.user}
        onChangePassword={changePassword}
        onLogout={auth.logout}
      />
    </ConnectionProvider>
  );
}

describe('App forced-password authority composition', () => {
  const patch = vi.fn();
  const client = {
    service: vi.fn((path: string) => {
      if (path !== 'users') throw new Error(path);
      return { patch };
    }),
  } as unknown as AgorClient;

  beforeEach(() => {
    localStorage.clear();
    authenticate.mockReset();
    patch.mockReset().mockResolvedValue({});
    localStorage.setItem(ACCESS_TOKEN_KEY, 'admin-a-old-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'admin-a-old-refresh');
    authenticate.mockResolvedValueOnce({
      accessToken: 'admin-a-old-access',
      user: authUser('admin-a', true),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  async function submitPassword() {
    await screen.findByRole('button', { name: 'Change Password' });
    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: 'new-password-1234' },
    });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'new-password-1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change Password' }));
    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
  }

  it('installs successful credentials after the loading gate unmounts the modal', async () => {
    const login = deferred<{
      accessToken: string;
      refreshToken: string;
      user: User;
    }>();
    authenticate.mockImplementationOnce(() => login.promise);
    const onCompleted = vi.fn();
    render(<ForcedPasswordAppComposition client={client} onCompleted={onCompleted} />);

    await submitPassword();
    expect(await screen.findByText('Authenticating…')).toBeInTheDocument();
    expect(screen.queryByLabelText('New Password')).not.toBeInTheDocument();

    login.resolve({
      accessToken: 'admin-a-new-access',
      refreshToken: 'admin-a-new-refresh',
      user: authUser('admin-a', false),
    });

    expect(await screen.findByText('Ready: admin-a')).toBeInTheDocument();
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('admin-a-new-access');
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('admin-a-new-refresh');
    expect(onCompleted).toHaveBeenCalledOnce();
    expect(onCompleted).toHaveBeenCalledWith(true);
  });

  it('clears loading and logs out stale credentials after relogin failure', async () => {
    const login = deferred<never>();
    authenticate.mockImplementationOnce(() => login.promise);
    const onCompleted = vi.fn();
    render(<ForcedPasswordAppComposition client={client} onCompleted={onCompleted} />);

    await submitPassword();
    expect(await screen.findByText('Authenticating…')).toBeInTheDocument();
    login.reject(new Error('new credentials rejected'));

    expect(await screen.findByText('Signed out')).toBeInTheDocument();
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    expect(onCompleted).toHaveBeenCalledOnce();
    expect(onCompleted).toHaveBeenCalledWith(false);
  });

  it('cannot install or log out A after an in-place replacement by admin B', async () => {
    const login = deferred<{
      accessToken: string;
      refreshToken: string;
      user: User;
    }>();
    authenticate.mockImplementationOnce(() => login.promise);
    const onCompleted = vi.fn();
    render(<ForcedPasswordAppComposition client={client} onCompleted={onCompleted} />);

    await submitPassword();
    expect(await screen.findByText('Authenticating…')).toBeInTheDocument();

    localStorage.setItem(ACCESS_TOKEN_KEY, 'admin-b-access');
    localStorage.setItem(REFRESH_TOKEN_KEY, 'admin-b-refresh');
    act(() => {
      window.dispatchEvent(
        new CustomEvent(TOKENS_REFRESHED_EVENT, {
          detail: {
            accessToken: 'admin-b-access',
            refreshToken: 'admin-b-refresh',
            user: authUser('admin-b', false),
          },
        })
      );
    });
    expect(await screen.findByText('Ready: admin-b')).toBeInTheDocument();

    login.resolve({
      accessToken: 'stale-admin-a-access',
      refreshToken: 'stale-admin-a-refresh',
      user: authUser('admin-a', false),
    });
    await act(() => login.promise);

    expect(screen.getByText('Ready: admin-b')).toBeInTheDocument();
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('admin-b-access');
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('admin-b-refresh');
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it('releases global loading on same-user generation cancellation before held REST auth settles', async () => {
    const login = deferred<{
      accessToken: string;
      refreshToken: string;
      user: User;
    }>();
    authenticate.mockImplementationOnce(() => login.promise);
    const onCompleted = vi.fn();
    const rendered = render(
      <ForcedPasswordAppComposition client={client} authGeneration={4} onCompleted={onCompleted} />
    );

    await submitPassword();
    expect(await screen.findByText('Authenticating…')).toBeInTheDocument();

    rendered.rerender(
      <ForcedPasswordAppComposition client={client} authGeneration={5} onCompleted={onCompleted} />
    );

    // Cancellation, not the held REST response, must release the App loading
    // gate. The same caller's required-password modal becomes usable again.
    expect(await screen.findByRole('button', { name: 'Change Password' })).toBeInTheDocument();
    expect(screen.queryByText('Authenticating…')).not.toBeInTheDocument();

    login.resolve({
      accessToken: 'obsolete-admin-a-access',
      refreshToken: 'obsolete-admin-a-refresh',
      user: authUser('admin-a', false),
    });
    await act(() => login.promise);

    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('admin-a-old-access');
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('admin-a-old-refresh');
    expect(onCompleted).not.toHaveBeenCalled();
  });
});
