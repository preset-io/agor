// @ts-nocheck - Complex auth flow with conditional null states
/**
 * Authentication Hook
 *
 * Manages user authentication state and provides login/logout functions
 */

import type { User } from '@agor-live/client';
import { createRestClient } from '@agor-live/client';
import { useCallback, useEffect, useState } from 'react';
import { getDaemonUrl } from '../config/daemon';
import { isTransientConnectionError } from '../utils/authErrors';
import { isExpiringSoon, msUntilExpiry } from '../utils/jwtExpiry';
import {
  RefreshUnrecoverableError,
  refreshTokensSingleFlight,
  resetRefreshFailureState,
  TOKENS_REFRESH_UNRECOVERABLE_EVENT,
  TOKENS_REFRESHED_EVENT,
} from '../utils/singleFlightRefresh';
import {
  clearTokens,
  getStoredAccessToken,
  getStoredRefreshToken,
  type RefreshResult,
  storeTokens,
} from '../utils/tokenRefresh';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  authenticated: boolean;
  loading: boolean;
  error: string | null;
}

interface UseAuthReturn extends AuthState {
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  reAuthenticate: () => Promise<void>;
}

/**
 * Authentication hook
 */
export function useAuth(): UseAuthReturn {
  const [state, setState] = useState<AuthState>({
    user: null,
    accessToken: null,
    authenticated: false,
    loading: true,
    error: null,
  });

  /**
   * Re-authenticate using stored token (with automatic refresh)
   * Retries up to 3 times to handle daemon restarts gracefully
   */
  const reAuthenticate = useCallback(async (retryCount = 0) => {
    const MAX_RETRIES = 5;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const storedAccessToken = getStoredAccessToken();
      const storedRefreshToken = getStoredRefreshToken();

      if (!storedAccessToken && !storedRefreshToken) {
        setState({
          user: null,
          accessToken: null,
          authenticated: false,
          loading: false,
          error: null,
        });
        return;
      }

      const client = await createRestClient(getDaemonUrl());

      // Try to authenticate with stored access token first
      if (storedAccessToken) {
        try {
          const result = await client.authenticate({
            strategy: 'jwt',
            accessToken: storedAccessToken,
          });

          setState({
            user: result.user,
            accessToken: result.accessToken,
            authenticated: true,
            loading: false,
            error: null,
          });

          return;
        } catch (_accessTokenError) {
          // Access token expired or invalid, try refresh token
        }
      }

      // Access token expired or missing, try refresh token
      if (storedRefreshToken) {
        try {
          const refreshResult = await refreshTokensSingleFlight(client, storedRefreshToken);

          setState({
            user: refreshResult.user,
            accessToken: refreshResult.accessToken,
            authenticated: true,
            loading: false,
            error: null,
          });

          return;
        } catch (_refreshError) {
          // Refresh token also expired or invalid
        }
      }

      // Both tokens invalid or expired — expected when refresh token hits its TTL.
      clearTokens();
      setState({
        user: null,
        accessToken: null,
        authenticated: false,
        loading: false,
        error: null,
      });
    } catch (error) {
      // Connection or authentication error - retry if daemon just restarted
      const isConnectionError = isTransientConnectionError(error);

      if (isConnectionError && retryCount < MAX_RETRIES) {
        const delay = Math.min(2000 * 1.5 ** retryCount, 10000); // Exponential backoff: 2s, 3s, 4.5s, 6.75s, 10s (capped)
        await new Promise((resolve) => setTimeout(resolve, delay));
        return reAuthenticate(retryCount + 1);
      }

      // IMPORTANT: Don't clear tokens if this is a connection error
      // The daemon might still be restarting, and we want to keep tokens for next retry
      if (!isConnectionError) {
        console.error('Authentication failure, clearing tokens:', error);
        clearTokens();
      }

      setState({
        user: null,
        accessToken: null,
        authenticated: false,
        loading: false,
        error: isConnectionError ? 'Connection lost - waiting for daemon...' : null,
      });
    }
  }, []);

  // Try to re-authenticate on mount (using stored token)
  useEffect(() => {
    reAuthenticate();
  }, [reAuthenticate]);

  // Visibility handler: recover from tab wake.
  //
  // Handles the laptop-sleep case where the access token has silently expired
  // while the tab was hidden — setTimeout didn't fire on time, so we catch up
  // here before the user's next click triggers a 401 and makes the stale
  // state visible. Also retries auth if we woke up in the unauthenticated-
  // with-tokens state (e.g. daemon was down when we last tried).
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;

      // Case 1: we think we're unauthenticated but have tokens — retry auth.
      if (!state.authenticated) {
        const hasTokens = getStoredAccessToken() || getStoredRefreshToken();
        if (hasTokens) {
          reAuthenticate();
        }
        return;
      }

      // Case 2: we think we're authenticated, but the access token has
      // silently expired (or will within the next refresh buffer) while the
      // tab was hidden. Refresh now, before the user's next click triggers a
      // 401 and makes the stale state visible.
      const REFRESH_BUFFER_MS = 60_000;
      const storedAccess = getStoredAccessToken();
      if (!storedAccess || !isExpiringSoon(storedAccess, REFRESH_BUFFER_MS)) return;

      const refreshToken = getStoredRefreshToken();
      if (!refreshToken) return;

      try {
        const client = await createRestClient(getDaemonUrl());
        await refreshTokensSingleFlight(client, refreshToken);
        // State sync happens via TOKENS_REFRESHED_EVENT listener below —
        // no need to setState here.
      } catch (error) {
        // Unrecoverable failures are handled by the unrecoverable-event
        // listener (clearTokens + unauthenticated). Bail out so we don't
        // kick off a reAuthenticate that will immediately fail again.
        if (error instanceof RefreshUnrecoverableError) return;
        // Transient/connection errors: let the poll effect pick us up.
        // Other non-connection errors: force a full reAuthenticate, which
        // has its own retry + token-clear policy.
        if (!isTransientConnectionError(error)) {
          reAuthenticate();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [state.authenticated, reAuthenticate]);

  // Poll for daemon availability when we have tokens but aren't authenticated.
  // This handles the case where the daemon restarts and we need to reconnect
  // without a user-driven event to trigger it. Split from the visibility
  // effect so that visibility-listener setup/teardown isn't churned every
  // time `state.loading` flips.
  useEffect(() => {
    if (state.authenticated || state.loading) return;

    const hasTokens = getStoredAccessToken() || getStoredRefreshToken();
    if (!hasTokens) return;

    const pollInterval = setInterval(() => {
      reAuthenticate();
    }, 3000); // Poll every 3 seconds

    return () => clearInterval(pollInterval);
  }, [state.authenticated, state.loading, reAuthenticate]);

  // Auto-refresh the access token before it expires.
  //
  // Strategy: decode the `exp` claim on the current access token and schedule
  // a single setTimeout for (exp - REFRESH_BUFFER). When it fires, refresh;
  // the state update then re-runs this effect with the new token, which
  // schedules the next tick. This removes the historic drift bug where the
  // refresh interval was hardcoded independently of the server's TTL.
  useEffect(() => {
    if (!state.authenticated || !state.accessToken) return;

    const REFRESH_BUFFER_MS = 60_000; // refresh this many ms before exp
    const MIN_DELAY_MS = 1_000; // never schedule tighter than this
    const FALLBACK_DELAY_MS = 5 * 60_000; // if we can't decode exp

    const untilExp = msUntilExpiry(state.accessToken);
    const delay =
      untilExp === null ? FALLBACK_DELAY_MS : Math.max(MIN_DELAY_MS, untilExp - REFRESH_BUFFER_MS);

    const timer = setTimeout(async () => {
      const refreshToken = getStoredRefreshToken();
      if (!refreshToken) return;

      try {
        const client = await createRestClient(getDaemonUrl());
        await refreshTokensSingleFlight(client, refreshToken);
        // State sync happens via TOKENS_REFRESHED_EVENT listener below.
      } catch (error) {
        // Unrecoverable: the unrecoverable-event listener already cleared
        // tokens and flipped to unauthenticated. Avoid double-handling.
        if (error instanceof RefreshUnrecoverableError) return;

        console.error('Failed to auto-refresh token:', error);
        if (isTransientConnectionError(error)) {
          setState((prev) => ({
            ...prev,
            error: 'Connection lost - waiting for daemon...',
          }));
        } else {
          // Definite refresh/auth failure: token refresh failed, user must login again.
          clearTokens();
          setState({
            user: null,
            accessToken: null,
            authenticated: false,
            loading: false,
            error: 'Session expired, please login again',
          });
        }
      }
    }, delay);

    return () => clearTimeout(timer);
  }, [state.authenticated, state.accessToken]);

  // When the single-flight refresh helper completes from a non-React path
  // (e.g. the socket-client 401-retry hook, or a concurrent refresh in
  // useAgorClient), sync our React state so the next render uses the fresh
  // token and the auto-refresh effect re-schedules around the new `exp`.
  useEffect(() => {
    const handleRefreshed = (event: Event) => {
      const detail = (event as CustomEvent<RefreshResult>).detail;
      if (!detail) return;
      setState((prev) => ({
        ...prev,
        accessToken: detail.accessToken,
        user: detail.user,
        authenticated: true,
      }));
    };

    window.addEventListener(TOKENS_REFRESHED_EVENT, handleRefreshed);
    return () => window.removeEventListener(TOKENS_REFRESHED_EVENT, handleRefreshed);
  }, []);

  // When the single-flight refresh helper determines the refresh token is
  // permanently dead (e.g. the server returned 401 / NotAuthenticated from
  // the refresh endpoint), clear tokens and flip to unauthenticated. Without
  // this, the socket around-hook and connect-handler would each re-throw
  // the original auth error without cleanup, and a page reload would be the
  // only way to escape the resulting refresh/reconnect loop.
  useEffect(() => {
    const handleUnrecoverable = () => {
      clearTokens();
      setState({
        user: null,
        accessToken: null,
        authenticated: false,
        loading: false,
        error: 'Session expired, please login again',
      });
    };

    window.addEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, handleUnrecoverable);
    return () =>
      window.removeEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, handleUnrecoverable);
  }, []);

  /**
   * Login with email and password
   */
  const login = async (email: string, password: string): Promise<boolean> => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const client = await createRestClient(getDaemonUrl());

      // Authenticate
      const result = await client.authenticate({
        strategy: 'local',
        email,
        password,
      });

      // Store both access and refresh tokens
      storeTokens(result.accessToken, result.refreshToken);

      // Fresh session — clear any stale "refresh is dead" latch from a
      // previous login so the new refresh token isn't rejected before it
      // ever gets tried.
      resetRefreshFailureState();

      setState({
        user: result.user,
        accessToken: result.accessToken,
        authenticated: true,
        loading: false,
        error: null,
      });

      return true;
    } catch (error) {
      console.error('❌ Login failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Login failed';
      console.error('❌ Error message:', errorMessage);
      setState((prev) => ({
        ...prev,
        loading: false,
        error: errorMessage,
      }));
      return false;
    }
  };

  /**
   * Logout
   *
   * Clears authentication tokens and forces a full page reload to clear all cached state.
   * This prevents cached data from one user from leaking to another user on the same browser.
   */
  const logout = async () => {
    // Clear tokens from localStorage
    clearTokens();

    // Clear state (will be reset on reload anyway, but good practice)
    setState({
      user: null,
      accessToken: null,
      authenticated: false,
      loading: false,
      error: null,
    });

    // Force full page reload to clear:
    // - Feathers client cache
    // - All React state (sessionById, worktreeById, etc.)
    // - Any other in-memory cached data
    // This prevents security issues where User A's data remains visible after User B logs in
    window.location.href = '/';
  };

  return {
    ...state,
    login,
    logout,
    reAuthenticate,
  };
}
