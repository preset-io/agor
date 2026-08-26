// @ts-nocheck - Complex auth flow with conditional null states
/**
 * Authentication Hook
 *
 * Manages user authentication state and provides login/logout functions
 */

import type { User, UserID } from '@agor-live/client';
import { createRestClient } from '@agor-live/client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getDaemonUrl } from '../config/daemon';
import { isDefiniteAuthFailure, isTransientConnectionError } from '../utils/authErrors';
import { isExpiringSoon, msUntilExpiry } from '../utils/jwtExpiry';
import {
  exchangeLaunchCode,
  getLaunchCodeFromSearch,
  removeLaunchCodeFromCurrentUrl,
} from '../utils/launchAuth';
import { discardMarketplaceOAuthStateForAuthority } from '../utils/marketplaceOAuthPrompt';
import {
  dispatchTokensRefreshed,
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
import type { AuthorityOperation } from './useAuthorityOperationGuard';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  authenticated: boolean;
  loading: boolean;
  error: string | null;
}

/**
 * Exact authenticated authority captured before an operation invalidates its
 * own old credentials (for example, a required password change).
 *
 * Component mount lifetime is deliberately not part of this ticket. The App
 * loading gate may unmount the initiating modal while a replacement login is
 * in flight. Identity, role, credential, connection and auth-generation
 * changes still invalidate it through the supplied authority guard and the
 * exact auth/storage snapshots.
 */
export interface CapturedAuthAuthorityCycle {
  userId: string;
  role: string;
  accessToken: string;
  isCurrent: () => boolean;
  onInvalidate: AuthorityOperation['onInvalidate'];
}

export interface EstablishedAuthAuthorityReceipt {
  userId: string;
  role: string;
  accessToken: string;
  /** Exact freshly-installed authority, independent of the initiating modal/generation. */
  isCurrent: () => boolean;
}

export type AuthorityCycleLoginResult =
  | { status: 'signed-in'; authority: EstablishedAuthAuthorityReceipt }
  | { status: 'failed' }
  | { status: 'obsolete' };

interface UseAuthReturn extends AuthState {
  /** Monotonic owner for caller-scoped async work. Routine token refresh does not advance it. */
  authenticationGeneration: number;
  isAuthenticationGenerationCurrent: (generation: number) => boolean;
  isAuthenticationOwnerCurrent: (userId: UserID, generation: number) => boolean;
  login: (email: string, password: string) => Promise<boolean>;
  captureAuthorityCycle: (
    authorityOperation: Pick<AuthorityOperation, 'isCurrent' | 'onInvalidate'>
  ) => CapturedAuthAuthorityCycle | null;
  loginForAuthorityCycle: (
    email: string,
    password: string,
    authorityCycle: CapturedAuthAuthorityCycle
  ) => Promise<AuthorityCycleLoginResult>;
  logout: () => Promise<void>;
  logoutForAuthorityCycle: (authorityCycle: CapturedAuthAuthorityCycle) => Promise<boolean>;
  reAuthenticate: () => Promise<void>;
  refreshCurrentUserForAuthorityCycle: (shouldApply: () => boolean) => Promise<boolean>;
}

const UNEXPECTED_LOGIN_RESPONSE_MESSAGE =
  'The Agor server returned an unexpected response while signing in. Check that the daemon URL is correct and the server is reachable, then try again.';

function isJsonParseFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const message =
    error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? '');
  return /json parsing error/i.test(message) || /unexpected token.*json/i.test(message);
}

function loginErrorMessage(error: unknown): string {
  if (isJsonParseFailure(error)) {
    return UNEXPECTED_LOGIN_RESPONSE_MESSAGE;
  }

  if (isTransientConnectionError(error)) {
    return 'Unable to reach the Agor server. Check your connection and try again.';
  }

  return error instanceof Error ? error.message : 'Login failed';
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
  const authStateRef = useRef(state);
  authStateRef.current = state;
  const previousMarketplaceAuthorityRef = useRef<{ userId: string; role: string } | null>(null);
  // Only the latest local-login attempt may install credentials or own the
  // global loading bit. Other auth establishments explicitly supersede it.
  const localLoginAttemptRef = useRef<object | null>(null);
  const authenticationGenerationRef = useRef(0);
  const [authenticationGeneration, setAuthenticationGeneration] = useState(0);
  const activeAuthorityRef = useRef<{ userId: UserID; role: User['role'] } | null>(null);

  const advanceAuthenticationGeneration = useCallback(() => {
    authenticationGenerationRef.current += 1;
    setAuthenticationGeneration(authenticationGenerationRef.current);
  }, []);

  const invalidateAuthentication = useCallback(() => {
    activeAuthorityRef.current = null;
    advanceAuthenticationGeneration();
  }, [advanceAuthenticationGeneration]);

  const noteAuthenticatedUser = useCallback(
    (user: User) => {
      const previous = activeAuthorityRef.current;
      if (!previous || previous.userId !== user.user_id || previous.role !== user.role) {
        advanceAuthenticationGeneration();
      }
      activeAuthorityRef.current = { userId: user.user_id, role: user.role };
    },
    [advanceAuthenticationGeneration]
  );

  const noteUnauthenticated = useCallback(() => {
    if (activeAuthorityRef.current) invalidateAuthentication();
  }, [invalidateAuthentication]);

  const isAuthenticationGenerationCurrent = useCallback(
    (generation: number) => authenticationGenerationRef.current === generation,
    []
  );
  const isAuthenticationOwnerCurrent = useCallback(
    (userId: UserID, generation: number) =>
      activeAuthorityRef.current?.userId === userId &&
      authenticationGenerationRef.current === generation,
    []
  );

  // Identity replacement can also happen through token refresh/reconnect,
  // without an explicit logout and without any SessionPanel mounted. Clear
  // only the departing authority's tab-local Marketplace state before child
  // layout effects can observe the replacement identity.
  useLayoutEffect(() => {
    const next = state.user ? { userId: state.user.user_id, role: state.user.role } : null;
    const previous = previousMarketplaceAuthorityRef.current;
    if (previous && (!next || previous.userId !== next.userId || previous.role !== next.role)) {
      discardMarketplaceOAuthStateForAuthority(previous);
    }
    previousMarketplaceAuthorityRef.current = next;
  }, [state.user]);

  /**
   * Re-authenticate using stored token (with automatic refresh)
   * Retries up to 3 times to handle daemon restarts gracefully
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: auth-generation helpers are stable for the hook lifetime; reAuthenticate must remain stable for retry/effect callers
  const reAuthenticate = useCallback(async (retryCount = 0, pendingLaunchCode?: string) => {
    const MAX_RETRIES = 5;
    localLoginAttemptRef.current = null;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    const storedAccessToken = getStoredAccessToken();
    const storedRefreshToken = getStoredRefreshToken();
    const hasStoredTokens = !!storedAccessToken || !!storedRefreshToken;
    const activeLaunchCode =
      pendingLaunchCode ||
      (typeof window !== 'undefined' ? getLaunchCodeFromSearch(window.location.search) : null);
    let attemptedLaunch = false;
    let launchFailed = false;

    async function authenticateWithStoredTokens(
      client: Awaited<ReturnType<typeof createRestClient>>
    ) {
      if (!storedAccessToken && !storedRefreshToken) return false;

      // Try to authenticate with stored access token first
      if (storedAccessToken) {
        try {
          const result = await client.authenticate({
            strategy: 'jwt',
            accessToken: storedAccessToken,
          });

          noteAuthenticatedUser(result.user);
          setState({
            user: result.user,
            accessToken: result.accessToken,
            authenticated: true,
            loading: false,
            error: null,
          });

          return true;
        } catch (accessTokenError) {
          // Access token expired or invalid, try refresh token
          if (!isDefiniteAuthFailure(accessTokenError)) throw accessTokenError;
        }
      }

      // Access token expired or missing, try refresh token
      if (storedRefreshToken) {
        try {
          const refreshResult = await refreshTokensSingleFlight(client, storedRefreshToken);

          noteAuthenticatedUser(refreshResult.user);
          setState({
            user: refreshResult.user,
            accessToken: refreshResult.accessToken,
            authenticated: true,
            loading: false,
            error: null,
          });

          return true;
        } catch (refreshError) {
          // Refresh token also expired or invalid
          if (
            !isDefiniteAuthFailure(refreshError) &&
            !(refreshError instanceof RefreshUnrecoverableError)
          ) {
            throw refreshError;
          }
        }
      }

      return false;
    }

    try {
      const client = await createRestClient(getDaemonUrl());

      if (activeLaunchCode) {
        attemptedLaunch = true;
        // Remove the opaque one-time code before the network round-trip so a
        // refresh, copy/paste, or dev-mode double effect does not replay it.
        removeLaunchCodeFromCurrentUrl();

        try {
          const result = await exchangeLaunchCode(client, activeLaunchCode);
          resetRefreshFailureState();
          noteAuthenticatedUser(result.user);

          setState({
            user: result.user,
            accessToken: result.accessToken,
            authenticated: true,
            loading: false,
            error: null,
          });
          dispatchTokensRefreshed(result);

          return;
        } catch (launchError) {
          const isConnectionError = isTransientConnectionError(launchError);
          if (isConnectionError && retryCount < MAX_RETRIES) {
            const delay = Math.min(2000 * 1.5 ** retryCount, 10000);
            await new Promise((resolve) => setTimeout(resolve, delay));
            return reAuthenticate(retryCount + 1, activeLaunchCode);
          }

          launchFailed = true;
          if (!hasStoredTokens) {
            throw launchError;
          }

          console.warn('Launch sign-in failed; falling back to stored auth tokens:', launchError);
        }
      }

      if (!hasStoredTokens) {
        noteUnauthenticated();
        setState({
          user: null,
          accessToken: null,
          authenticated: false,
          loading: false,
          error: launchFailed
            ? 'Launch sign-in failed. The one-time launch code may have expired or already been used.'
            : null,
        });
        return;
      }

      if (await authenticateWithStoredTokens(client)) return;

      // Both tokens invalid or expired — expected when refresh token hits its TTL.
      clearTokens();
      noteUnauthenticated();
      setState({
        user: null,
        accessToken: null,
        authenticated: false,
        loading: false,
        error: launchFailed
          ? 'Launch sign-in failed. The one-time launch code may have expired or already been used.'
          : null,
      });
    } catch (error) {
      // Connection or authentication error - retry if daemon just restarted
      const isConnectionError = isTransientConnectionError(error);

      if (isConnectionError && retryCount < MAX_RETRIES) {
        const delay = Math.min(2000 * 1.5 ** retryCount, 10000); // Exponential backoff: 2s, 3s, 4.5s, 6.75s, 10s (capped)
        await new Promise((resolve) => setTimeout(resolve, delay));
        return reAuthenticate(
          retryCount + 1,
          attemptedLaunch ? activeLaunchCode || undefined : undefined
        );
      }

      // IMPORTANT: Don't clear tokens for connection errors or for failed
      // launch-code attempts when stored tokens exist. A stale/consumed URL
      // code must not log out a user with an otherwise valid local session.
      if (
        isDefiniteAuthFailure(error) &&
        !isConnectionError &&
        !(attemptedLaunch && hasStoredTokens)
      ) {
        console.error('Authentication failure, clearing tokens:', error);
        clearTokens();
      }

      if (attemptedLaunch && hasStoredTokens) {
        try {
          const client = await createRestClient(getDaemonUrl());
          if (await authenticateWithStoredTokens(client)) return;
        } catch (fallbackError) {
          console.warn(
            'Stored-token fallback after launch sign-in failure also failed:',
            fallbackError
          );
        }
      }

      noteUnauthenticated();
      setState({
        user: null,
        accessToken: null,
        authenticated: false,
        loading: false,
        error: isConnectionError
          ? 'Connection lost - waiting for daemon...'
          : attemptedLaunch
            ? 'Launch sign-in failed. The one-time launch code may have expired or already been used.'
            : null,
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
          noteUnauthenticated();
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
  }, [state.authenticated, state.accessToken, noteUnauthenticated]);

  // When the single-flight refresh helper completes from a non-React path
  // (e.g. the socket-client 401-retry hook, or a concurrent refresh in
  // useAgorClient), sync our React state so the next render uses the fresh
  // token and the auto-refresh effect re-schedules around the new `exp`.
  useEffect(() => {
    const handleRefreshed = (event: Event) => {
      const detail = (event as CustomEvent<RefreshResult>).detail;
      if (!detail) return;
      localLoginAttemptRef.current = null;
      noteAuthenticatedUser(detail.user);
      const nextState: AuthState = {
        ...authStateRef.current,
        accessToken: detail.accessToken,
        user: detail.user,
        authenticated: true,
        loading: false,
        error: null,
      };
      // Update the authority ref synchronously with the token event. A stale
      // local-auth continuation can otherwise run in the microtask before
      // React commits the replacement identity.
      authStateRef.current = nextState;
      setState(nextState);
    };

    window.addEventListener(TOKENS_REFRESHED_EVENT, handleRefreshed);
    return () => window.removeEventListener(TOKENS_REFRESHED_EVENT, handleRefreshed);
  }, [noteAuthenticatedUser]);

  // When the single-flight refresh helper determines the refresh token is
  // permanently dead (e.g. the server returned 401 / NotAuthenticated from
  // the refresh endpoint), clear tokens and flip to unauthenticated. Without
  // this, the socket around-hook and connect-handler would each re-throw
  // the original auth error without cleanup, and a page reload would be the
  // only way to escape the resulting refresh/reconnect loop.
  useEffect(() => {
    const handleUnrecoverable = () => {
      localLoginAttemptRef.current = null;
      clearTokens();
      noteUnauthenticated();
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
  }, [noteUnauthenticated]);

  /**
   * Login with email and password
   */
  const captureAuthorityCycle = useCallback(
    (
      authorityOperation: Pick<AuthorityOperation, 'isCurrent' | 'onInvalidate'>
    ): CapturedAuthAuthorityCycle | null => {
      const captured = authStateRef.current;
      const userId = captured.user?.user_id;
      const role = captured.user?.role;
      const accessToken = captured.accessToken;
      if (
        !authorityOperation.isCurrent() ||
        !captured.authenticated ||
        !userId ||
        !role ||
        !accessToken ||
        getStoredAccessToken() !== accessToken
      ) {
        return null;
      }

      return {
        userId,
        role,
        accessToken,
        onInvalidate: authorityOperation.onInvalidate,
        isCurrent: () => {
          const current = authStateRef.current;
          return (
            authorityOperation.isCurrent() &&
            current.authenticated &&
            current.user?.user_id === userId &&
            current.user?.role === role &&
            current.accessToken === accessToken &&
            getStoredAccessToken() === accessToken
          );
        },
      };
    },
    []
  );

  const loginForAuthorityCycle = async (
    email: string,
    password: string,
    authorityCycle: CapturedAuthAuthorityCycle
  ): Promise<AuthorityCycleLoginResult> => {
    if (!authorityCycle.isCurrent()) return { status: 'obsolete' };
    const attempt = {};
    localLoginAttemptRef.current = attempt;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    const finishObsolete = (): AuthorityCycleLoginResult => {
      if (localLoginAttemptRef.current === attempt) {
        localLoginAttemptRef.current = null;
        setState((prev) => ({ ...prev, loading: false }));
      }
      return { status: 'obsolete' };
    };

    try {
      const authentication = (async () => {
        const client = await createRestClient(getDaemonUrl());
        return client.authenticate({ strategy: 'local', email, password });
      })();
      let unsubscribeCancellation = () => {};
      const cancellation = new Promise<{ kind: 'cancelled' }>((resolve) => {
        unsubscribeCancellation = authorityCycle.onInvalidate(() => {
          resolve({ kind: 'cancelled' });
        });
      });
      // Convert rejection to a value before racing so an authentication
      // promise held past cancellation can never later reject unhandled.
      const outcome = await Promise.race([
        authentication.then(
          (result) => ({ kind: 'authenticated' as const, result }),
          (error: unknown) => ({ kind: 'failed' as const, error })
        ),
        cancellation,
      ]);
      unsubscribeCancellation();
      if (outcome.kind === 'cancelled') return finishObsolete();
      if (outcome.kind === 'failed') throw outcome.error;
      const result = outcome.result;

      // Local authentication is deliberately performed on a disposable REST
      // client. Do not install its tokens or identity into the long-lived app
      // after the exact caller/socket authority cycle that requested it ended.
      if (localLoginAttemptRef.current !== attempt || !authorityCycle.isCurrent()) {
        return finishObsolete();
      }
      if (
        result.user?.user_id !== authorityCycle.userId ||
        result.user?.role !== authorityCycle.role
      ) {
        localLoginAttemptRef.current = null;
        setState((prev) => ({
          ...prev,
          loading: false,
          error:
            'Your account authority changed while the password was being updated. Sign in again.',
        }));
        return { status: 'failed' };
      }

      // Store both access and refresh tokens. This is an explicit credential
      // replacement, so advance authority even when user id and role are unchanged.
      localLoginAttemptRef.current = null;
      invalidateAuthentication();
      storeTokens(result.accessToken, result.refreshToken);
      noteAuthenticatedUser(result.user);

      // Fresh session — clear any stale "refresh is dead" latch from a
      // previous login so the new refresh token isn't rejected before it
      // ever gets tried.
      resetRefreshFailureState();

      const nextState: AuthState = {
        user: result.user,
        accessToken: result.accessToken,
        authenticated: true,
        loading: false,
        error: null,
      };
      authStateRef.current = nextState;
      setState(nextState);
      dispatchTokensRefreshed(result);

      const establishedUserId = result.user.user_id;
      const establishedRole = result.user.role;
      const establishedAccessToken = result.accessToken;
      return {
        status: 'signed-in',
        authority: {
          userId: establishedUserId,
          role: establishedRole,
          accessToken: establishedAccessToken,
          isCurrent: () => {
            const current = authStateRef.current;
            return (
              current.authenticated &&
              current.user?.user_id === establishedUserId &&
              current.user?.role === establishedRole &&
              current.accessToken === establishedAccessToken &&
              getStoredAccessToken() === establishedAccessToken
            );
          },
        },
      };
    } catch (error) {
      if (localLoginAttemptRef.current !== attempt || !authorityCycle.isCurrent()) {
        return finishObsolete();
      }
      localLoginAttemptRef.current = null;
      console.error('❌ Login failed:', error);
      const userFacingMessage = loginErrorMessage(error);
      const rawMessage = error instanceof Error ? error.message : 'Login failed';
      console.error('❌ Error message:', rawMessage);
      setState((prev) => ({
        ...prev,
        loading: false,
        error: userFacingMessage,
      }));
      return { status: 'failed' };
    }
  };

  const login = async (email: string, password: string): Promise<boolean> => {
    invalidateAuthentication();
    // Ordinary login begins without an existing authenticated authority. Use a
    // dedicated path rather than fabricating a captured cycle.
    const attempt = {};
    localLoginAttemptRef.current = attempt;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const client = await createRestClient(getDaemonUrl());
      const result = await client.authenticate({ strategy: 'local', email, password });
      if (localLoginAttemptRef.current !== attempt) return false;
      localLoginAttemptRef.current = null;
      storeTokens(result.accessToken, result.refreshToken);
      resetRefreshFailureState();
      noteAuthenticatedUser(result.user);
      setState({
        user: result.user,
        accessToken: result.accessToken,
        authenticated: true,
        loading: false,
        error: null,
      });
      dispatchTokensRefreshed(result);
      return true;
    } catch (error) {
      if (localLoginAttemptRef.current !== attempt) return false;
      localLoginAttemptRef.current = null;
      console.error('❌ Login failed:', error);
      setState((prev) => ({
        ...prev,
        loading: false,
        error: loginErrorMessage(error),
      }));
      return false;
    }
  };

  const logout = async () => {
    const currentUser = authStateRef.current.user;
    if (currentUser) {
      discardMarketplaceOAuthStateForAuthority({
        userId: currentUser.user_id,
        role: currentUser.role,
      });
    }
    localLoginAttemptRef.current = null;
    invalidateAuthentication();
    clearTokens();
    const nextState: AuthState = {
      user: null,
      accessToken: null,
      authenticated: false,
      loading: false,
      error: null,
    };
    authStateRef.current = nextState;
    setState(nextState);
  };

  const logoutForAuthorityCycle = async (
    authorityCycle: CapturedAuthAuthorityCycle
  ): Promise<boolean> => {
    if (!authorityCycle.isCurrent()) return false;
    invalidateAuthentication();
    // Token clearing and the React authority update are synchronous together;
    // no await boundary exists where a replacement identity can slip between
    // the guard and the mutation.
    discardMarketplaceOAuthStateForAuthority({
      userId: authorityCycle.userId,
      role: authorityCycle.role,
    });
    localLoginAttemptRef.current = null;
    clearTokens();
    const nextState: AuthState = {
      user: null,
      accessToken: null,
      authenticated: false,
      loading: false,
      error: null,
    };
    authStateRef.current = nextState;
    setState(nextState);
    return true;
  };

  /**
   * Refresh the authenticated directory row without replacing credentials.
   *
   * Settings uses this after a self-update so role/name changes returned by
   * the authentication strategy become the current identity authority. Keep
   * it separate from `reAuthenticate`: a settings continuation belongs to one
   * exact socket authority generation and must never start a refresh/login
   * cycle whose tokens could be installed after that generation was replaced.
   */
  const refreshCurrentUserForAuthorityCycle = async (
    shouldApply: () => boolean
  ): Promise<boolean> => {
    if (!shouldApply()) return false;

    const accessToken = getStoredAccessToken();
    if (!accessToken) return false;

    const client = await createRestClient(getDaemonUrl());
    if (!shouldApply() || getStoredAccessToken() !== accessToken) return false;

    const result = await client.authenticate({
      strategy: 'jwt',
      accessToken,
    });

    // Check both the render/layout-invalidated authority operation and the
    // exact credential snapshot. The latter closes the microtask window where
    // another auth path has replaced storage but React has not committed the
    // matching identity/authGeneration render yet.
    if (!shouldApply() || getStoredAccessToken() !== accessToken) return false;

    noteAuthenticatedUser(result.user);
    const nextState: AuthState = {
      user: result.user,
      accessToken,
      authenticated: true,
      loading: false,
      error: null,
    };
    authStateRef.current = nextState;
    setState(nextState);
    return true;
  };

  return {
    ...state,
    authenticationGeneration,
    isAuthenticationGenerationCurrent,
    isAuthenticationOwnerCurrent,
    login,
    captureAuthorityCycle,
    loginForAuthorityCycle,
    logout,
    logoutForAuthorityCycle,
    reAuthenticate,
    refreshCurrentUserForAuthorityCycle,
  };
}
