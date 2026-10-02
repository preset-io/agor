import { createRestClient } from '@agor-live/client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { LoginPage } from '../components/LoginPage/LoginPage';
import { refreshTokensSingleFlight, resetRefreshFailureState } from '../utils/singleFlightRefresh';
import {
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  SupersededAuthenticationError,
} from '../utils/tokenRefresh';
import { useAuth } from './useAuth';

const authenticate = vi.fn();
const refreshCreate = vi.fn();
const launchCreate = vi.fn();
let currentAuth: ReturnType<typeof useAuth>;
vi.mock('@agor-live/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor-live/client')>()),
  createRestClient: vi.fn(async () => ({
    authenticate,
    service: (name: string) => ({ create: name === 'auth/launch' ? launchCreate : refreshCreate }),
  })),
}));
function Runtime() {
  const auth = useAuth();
  currentAuth = auth;
  return auth.authenticated ? (
    <button type="button" onClick={auth.logout}>
      Log out
    </button>
  ) : (
    <LoginPage
      onLogin={auth.login}
      localLoginEnabled={false}
      externalLaunchLoginRedirectUrl="https://workspace.example.test/open"
    />
  );
}
beforeEach(() => {
  localStorage.clear();
  resetRefreshFailureState();
  authenticate.mockReset();
  refreshCreate.mockReset();
  launchCreate.mockReset();
  window.history.replaceState({}, '', '/ui/');
});
afterEach(() => {
  localStorage.clear();
});

it.each(['jwt', 'launch', 'refresh'])(
  'keeps the runtime login screen signed out when %s finishes after clicking Log out',
  async (kind) => {
    const session = {
      accessToken: 'tenant-a-access',
      refreshToken: 'tenant-a-refresh',
      user: { user_id: 'alice', role: 'member' },
    };
    localStorage.setItem(ACCESS_TOKEN_KEY, session.accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, session.refreshToken);
    authenticate.mockResolvedValueOnce(session);
    render(<Runtime />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Log out' })).toBeVisible());
    let complete!: (value: typeof session) => void;
    const held = new Promise<typeof session>((resolve) => {
      complete = resolve;
    });
    let pending!: Promise<unknown>;
    if (kind === 'refresh') {
      refreshCreate.mockReturnValueOnce(held);
      const client = await createRestClient('http://localhost:3030');
      pending = expect(
        refreshTokensSingleFlight(client, session.refreshToken)
      ).rejects.toBeInstanceOf(SupersededAuthenticationError);
    } else {
      if (kind === 'launch') {
        window.history.replaceState({}, '', '/ui/?launch_code=tenant-a-code');
        launchCreate.mockReturnValueOnce(held);
      } else authenticate.mockReturnValueOnce(held);
      act(() => {
        pending = currentAuth.reAuthenticate();
      });
      await waitFor(() =>
        expect(kind === 'launch' ? launchCreate : authenticate).toHaveBeenCalledTimes(
          kind === 'launch' ? 1 : 2
        )
      );
    }
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    });
    await act(async () => {
      complete({ ...session, accessToken: 'late-access', refreshToken: 'late-refresh' });
      await pending;
    });
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Return to workspace' })).toBeVisible();
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    await page.screenshot({
      path: `../../../.vitest/attachments/logout-783/signed-out-after-${kind}-${window.innerWidth}.png`,
    });
  }
);
