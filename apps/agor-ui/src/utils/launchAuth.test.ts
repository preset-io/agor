import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exchangeLaunchCode,
  getLaunchCodeFromSearch,
  removeLaunchCodeFromCurrentUrl,
} from './launchAuth';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY } from './tokenRefresh';

describe('launch auth utilities', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('reads launch_code from query parameters', () => {
    expect(getLaunchCodeFromSearch('?launch_code=abc123')).toBe('abc123');
    expect(getLaunchCodeFromSearch('?x=1')).toBeNull();
    expect(getLaunchCodeFromSearch('?launch_code=')).toBeNull();
  });

  it('removes launch_code from the current URL without dropping other URL state', () => {
    window.history.replaceState({}, '', '/ui/?launch_code=abc&board=b1#panel');

    removeLaunchCodeFromCurrentUrl();

    expect(window.location.pathname).toBe('/ui/');
    expect(window.location.search).toBe('?board=b1');
    expect(window.location.hash).toBe('#panel');
  });

  it('exchanges a launch code and stores normal auth tokens', async () => {
    const client = {
      service: vi.fn(() => ({
        create: vi.fn(async () => ({
          accessToken: 'access',
          refreshToken: 'refresh',
          user: { user_id: 'u1', email: 'u@example.test' },
        })),
      })),
    } as any;

    const result = await exchangeLaunchCode(client, 'code');

    expect(client.service).toHaveBeenCalledWith('auth/launch');
    expect(result.accessToken).toBe('access');
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('access');
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('refresh');
  });

  it('stores tokens in localStorage and writes no cookie during the exchange', async () => {
    const cookieBefore = document.cookie;
    const client = {
      service: vi.fn(() => ({
        create: vi.fn(async () => ({
          accessToken: 'access',
          refreshToken: 'refresh',
          user: { user_id: 'u1', email: 'u@example.test' },
        })),
      })),
    } as any;

    await exchangeLaunchCode(client, 'code');

    // Verifiable claim: the exchange persists the runtime session in
    // origin-scoped localStorage and writes no cookie. (Cross-host isolation
    // follows from localStorage being per-origin, but that is a browser
    // property this unit test cannot itself exercise.)
    expect(localStorage.getItem(ACCESS_TOKEN_KEY)).toBe('access');
    expect(localStorage.getItem(REFRESH_TOKEN_KEY)).toBe('refresh');
    expect(document.cookie).toBe(cookieBefore);
  });
});
