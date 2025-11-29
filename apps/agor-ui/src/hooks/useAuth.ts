// @ts-nocheck - Complex auth flow with conditional null states
/**
 * Authentication Hook
 *
 * Manages user authentication state and provides login/logout functions
 */

import { createClient } from '@agor/core/api';
import type { User } from '@agor/core/types';
import { useCallback, useEffect, useState } from 'react';
import { getDaemonUrl } from '../config/daemon';
import {
  clearTokens,
  getStoredAccessToken,
  getStoredRefreshToken,
  refreshAndStoreTokens,
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

    // Move client outside try block so it's accessible in finally
    let client: ReturnType<typeof createClient> | null = null;

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

      // Create temporary client
      client = createClient(getDaemonUrl());

      // Connect the client first (since autoConnect is false)
      client.io.connect();

      // Wait for connection (longer timeout for daemon restarts)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);

        if (client.io.connected) {
          clearTimeout(timeout);
          resolve();
          return;
        }

        client.io.once('connect', () => {
          clearTimeout(timeout);
          resolve();
        });

        client.io.once('connect_error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

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
        } catch (accessTokenError) {
          // Access token expired or invalid, try refresh token
          console.log(
            'Access token failed:',
            accessTokenError instanceof Error ? accessTokenError.message : accessTokenError,
            '- attempting refresh...'
          );
        }
      }

      // Access token expired or missing, try refresh token
      if (storedRefreshToken) {
        try {
          const refreshResult = await refreshAndStoreTokens(client, storedRefreshToken);

          setState({
            user: refreshResult.user,
            accessToken: refreshResult.accessToken,
            authenticated: true,
            loading: false,
            error: null,
          });

          console.log('✓ Token refreshed successfully after daemon restart');
          return;
        } catch (refreshError) {
          // Refresh token also expired or invalid
          console.log(
            'Refresh token failed:',
            refreshError instanceof Error ? refreshError.message : refreshError,
            '- need to login again'
          );
        }
      }

      // Both tokens invalid or expired
      console.error('❌ CLEARING TOKENS (both access and refresh tokens invalid/expired)');
      console.trace('Token clearing stack trace');
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
      const errorMessage =
        error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      const errorName = error instanceof Error ? error.constructor.name : '';
      const isConnectionError =
        errorMessage.includes('connection') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('websocket') ||
        errorMessage.includes('transport') ||
        errorName === 'TransportError' ||
        errorName === 'WebSocketError';

      if (isConnectionError && retryCount < MAX_RETRIES) {
        const delay = Math.min(2000 * 1.5 ** retryCount, 10000); // Exponential backoff: 2s, 3s, 4.5s, 6.75s, 10s (capped)
        console.log(
          `Connection failed (attempt ${retryCount + 1}/${MAX_RETRIES}), retrying in ${Math.round(delay)}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return reAuthenticate(retryCount + 1);
      }

      // Max retries exceeded or auth error (not connection issue)
      console.log('Failed to re-authenticate after max retries:', error);

      // IMPORTANT: Don't clear tokens if this is a connection error
      // The daemon might still be restarting, and we want to keep tokens for next retry
      if (!isConnectionError) {
        console.error('❌ CLEARING TOKENS due to authentication failure (not connection error)');
        console.error('Error details:', error);
        console.trace('Token clearing stack trace');
        clearTokens();
      } else {
        console.log(
          '✓ Keeping tokens in localStorage despite connection failure (daemon may be restarting)'
        );
      }

      setState({
        user: null,
        accessToken: null,
        authenticated: false,
        loading: false,
        error: isConnectionError ? 'Connection lost - waiting for daemon...' : null,
      });
    } finally {
      // CRITICAL: Always close the client connection to prevent leaks
      if (client?.io) {
        client.io.removeAllListeners();
        client.io.close();
      }
    }
  }, []);

  // Try to re-authenticate on mount (using stored token)
  useEffect(() => {
    reAuthenticate();
  }, [reAuthenticate]);

  // Listen for daemon reconnection events (window.ononline, storage events, etc.)
  // This helps recover from daemon restarts automatically
  useEffect(() => {
    const handleVisibilityChange = () => {
      // When tab becomes visible again, check if we need to re-auth
      if (document.visibilityState === 'visible' && !state.authenticated) {
        const hasTokens = getStoredAccessToken() || getStoredRefreshToken();
        if (hasTokens) {
          console.log('Tab became visible, attempting re-authentication...');
          reAuthenticate();
        }
      }
    };

    // Poll for daemon availability when we have tokens but aren't authenticated
    // This handles the case where daemon restarts and we need to reconnect
    let pollInterval: NodeJS.Timeout | null = null;
    if (!state.authenticated && !state.loading) {
      const hasTokens = getStoredAccessToken() || getStoredRefreshToken();
      if (hasTokens) {
        console.log('Starting reconnection polling (have tokens but not authenticated)...');
        pollInterval = setInterval(() => {
          console.log('Polling: attempting re-authentication...');
          reAuthenticate();
        }, 3000); // Poll every 3 seconds
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (pollInterval) {
        console.log('Stopping reconnection polling');
        clearInterval(pollInterval);
      }
    };
  }, [state.authenticated, state.loading, reAuthenticate]);

  // Auto-refresh token before expiration
  useEffect(() => {
    if (!state.authenticated || !state.accessToken) return;

    // Access token expires in 7 days, refresh after 6 days (conservative approach)
    const REFRESH_INTERVAL = 6 * 24 * 60 * 60 * 1000; // 6 days in milliseconds

    const refreshTimer = setInterval(async () => {
      const refreshToken = getStoredRefreshToken();
      if (!refreshToken) {
        console.log('No refresh token available');
        return;
      }

      let client: ReturnType<typeof createClient> | null = null;

      try {
        client = createClient(getDaemonUrl());
        client.io.connect();

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);

          if (client.io.connected) {
            clearTimeout(timeout);
            resolve();
            return;
          }

          client.io.once('connect', () => {
            clearTimeout(timeout);
            resolve();
          });

          client.io.once('connect_error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });

        const refreshResult = await refreshAndStoreTokens(client, refreshToken);

        setState((prev) => ({
          ...prev,
          accessToken: refreshResult.accessToken,
          user: refreshResult.user,
        }));

        console.log('✓ Token auto-refreshed successfully');
      } catch (error) {
        console.error('Failed to auto-refresh token:', error);
        // Token refresh failed, user needs to login again
        clearTokens();
        setState({
          user: null,
          accessToken: null,
          authenticated: false,
          loading: false,
          error: 'Session expired, please login again',
        });
      } finally {
        // CRITICAL: Always close the client connection to prevent leaks
        if (client?.io) {
          client.io.removeAllListeners();
          client.io.close();
        }
      }
    }, REFRESH_INTERVAL);

    return () => clearInterval(refreshTimer);
  }, [state.authenticated, state.accessToken]);

  /**
   * Login with email and password
   */
  const login = async (email: string, password: string): Promise<boolean> => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    let client: ReturnType<typeof createClient> | null = null;

    try {
      // Create temporary client for login
      client = createClient(getDaemonUrl());

      // Connect the client first (since autoConnect is false)
      client.io.connect();

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);

        if (client.io.connected) {
          clearTimeout(timeout);
          resolve();
          return;
        }

        client.io.once('connect', () => {
          clearTimeout(timeout);
          resolve();
        });

        client.io.once('connect_error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Authenticate
      console.log('🔐 Attempting authentication with local strategy...');
      const result = await client.authenticate({
        strategy: 'local',
        email,
        password,
      });

      console.log('✓ Authentication successful, got tokens:', {
        hasAccessToken: !!result.accessToken,
        hasRefreshToken: !!result.refreshToken,
        user: result.user?.email,
      });

      // Store both access and refresh tokens
      storeTokens(result.accessToken, result.refreshToken);

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
    } finally {
      // CRITICAL: Always close the client connection to prevent leaks
      if (client?.io) {
        client.io.removeAllListeners();
        client.io.close();
      }
    }
  };

  /**
   * Logout
   */
  const logout = async () => {
    console.log('🚪 Logout called, clearing tokens');
    console.trace('Logout stack trace');
    clearTokens();
    setState({
      user: null,
      accessToken: null,
      authenticated: false,
      loading: false,
      error: null,
    });
  };

  return {
    ...state,
    login,
    logout,
    reAuthenticate,
  };
}
