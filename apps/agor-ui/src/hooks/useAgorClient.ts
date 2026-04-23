// @ts-nocheck - Complex client lifecycle with conditional null states
/**
 * React hook for Agor daemon client connection
 *
 * Manages FeathersJS client lifecycle with React effects
 */

import type { AgorClient } from '@agor-live/client';
import { createClient } from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';
import { getDaemonUrl } from '../config/daemon';
import { refreshTokensSingleFlight } from '../utils/singleFlightRefresh';
import { getStoredRefreshToken, type RefreshResult } from '../utils/tokenRefresh';

interface UseAgorClientResult {
  client: AgorClient | null;
  connected: boolean;
  connecting: boolean;
  error: string | null;
  retryConnection: () => void;
}

interface UseAgorClientOptions {
  url?: string;
  accessToken?: string | null;
  allowAnonymous?: boolean;
}

/**
 * Create and manage Agor daemon client connection
 *
 * @param options - Connection options (url, accessToken, allowAnonymous)
 * @returns Client instance, connection state, and error
 */
export function useAgorClient(options: UseAgorClientOptions = {}): UseAgorClientResult {
  const { url = getDaemonUrl(), accessToken, allowAnonymous = false } = options;
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(!!accessToken || allowAnonymous); // Connecting if we have token OR anonymous is allowed
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<AgorClient | null>(null);

  useEffect(() => {
    let mounted = true;
    let client: AgorClient | null = null;
    let hasConnectedOnce = false; // Track if we've ever connected successfully

    async function connect() {
      // Don't create client if no access token and anonymous not allowed
      if (!accessToken && !allowAnonymous) {
        setConnecting(false);
        setConnected(false);
        setError(null);
        clientRef.current = null;
        return;
      }

      // Reset connected state when starting a new connection attempt
      // This prevents stale "connected: true" state during token transitions
      setConnected(false);
      setConnecting(true);
      setError(null);

      // Create client (autoConnect: false, so we control connection timing)
      client = createClient(url, false);
      clientRef.current = client;

      // Register an around-hook that transparently recovers from mid-session
      // access-token expiry. Any service call that fails with NotAuthenticated
      // (typically "jwt expired" from the Feathers auth strategy) will:
      //   1. Call /authentication/refresh via the single-flight helper — N
      //      parallel 401s share one refresh request so we don't rotate the
      //      refresh token multiple times.
      //   2. Re-authenticate the socket with the freshly-issued access token.
      //   3. Retry the original call exactly once.
      // The `_refreshRetried` flag on params guards against infinite recursion
      // if the retry itself fails auth (e.g. refresh token also expired).
      //
      // Auth-service paths are skipped so we never retry the refresh call or
      // the initial authenticate() itself.
      client.hooks({
        around: {
          all: [
            async (context, next) => {
              const path = context.path;
              if (typeof path === 'string' && path.startsWith('authentication')) {
                await next();
                return;
              }

              try {
                await next();
              } catch (err) {
                const errorObject = err as
                  | { name?: string; code?: number; className?: string }
                  | undefined;
                const isAuthError =
                  errorObject?.name === 'NotAuthenticated' ||
                  errorObject?.code === 401 ||
                  errorObject?.className === 'not-authenticated';
                if (!isAuthError) throw err;

                const currentParams = (context.params ?? {}) as Record<string, unknown>;
                if (currentParams._refreshRetried) throw err;

                const refreshToken = getStoredRefreshToken();
                if (!refreshToken || !client) throw err;

                let refreshed: RefreshResult;
                try {
                  refreshed = await refreshTokensSingleFlight(client, refreshToken);
                } catch {
                  // Refresh itself failed — surface the original auth error
                  // so upstream code (useAuth, connect handler) can decide
                  // whether to clear tokens and bounce to the login screen.
                  throw err;
                }

                try {
                  await client.authenticate({
                    strategy: 'jwt',
                    accessToken: refreshed.accessToken,
                  });
                } catch {
                  throw err;
                }

                // Retry the original call once. Hooks fire again, but the
                // `_refreshRetried` flag on params prevents another retry
                // if the retry also 401s.
                const retryParams = { ...currentParams, _refreshRetried: true };
                const service = client.service(path as string);
                const method = context.method as string;

                if (method === 'find') {
                  context.result = await service.find(retryParams);
                } else if (method === 'get') {
                  context.result = await service.get(context.id, retryParams);
                } else if (method === 'create') {
                  context.result = await service.create(context.data, retryParams);
                } else if (method === 'update') {
                  context.result = await service.update(context.id, context.data, retryParams);
                } else if (method === 'patch') {
                  context.result = await service.patch(context.id, context.data, retryParams);
                } else if (method === 'remove') {
                  context.result = await service.remove(context.id, retryParams);
                } else {
                  throw err;
                }
              }
            },
          ],
        },
      });

      // Store client globally for Vite HMR cleanup
      if (typeof window !== 'undefined') {
        (window as unknown as { __agorClient: AgorClient }).__agorClient = client;
      }

      // Setup socket event listeners BEFORE connecting
      client.io.on('connect', async () => {
        if (mounted) {
          hasConnectedOnce = true; // Mark that we've successfully connected

          // Re-authenticate on reconnection (e.g., after daemon restart or network recovery)
          try {
            if (accessToken) {
              // Try to authenticate with access token first
              try {
                await client.authenticate({
                  strategy: 'jwt',
                  accessToken,
                });
                setConnected(true);
                setConnecting(false);
                setError(null);
                return;
              } catch (_accessTokenErr) {
                // Access token expired or invalid - try refresh token
                // Check if we have a refresh token in localStorage
                const refreshToken = getStoredRefreshToken();
                if (refreshToken) {
                  try {
                    const refreshResult = await refreshTokensSingleFlight(client, refreshToken);

                    // Authenticate with new access token
                    await client.authenticate({
                      strategy: 'jwt',
                      accessToken: refreshResult.accessToken,
                    });

                    setConnected(true);
                    setConnecting(false);
                    setError(null);

                    // Trigger useAuth to reload (in case it's not in sync)
                    window.dispatchEvent(new Event('storage'));
                    return;
                  } catch (refreshErr) {
                    console.error('❌ Refresh token also failed:', refreshErr);
                    // Fall through to error handling
                  }
                }
              }
            } else if (allowAnonymous) {
              await client.authenticate({
                strategy: 'anonymous',
              });
              setConnected(true);
              setConnecting(false);
              setError(null);
              return;
            }

            // If we get here, authentication failed
            console.error('❌ Re-authentication failed after reconnect - all tokens expired');
            setConnecting(false);
            setConnected(false);
            setError('Session expired. Please log in again.');
          } catch (err) {
            console.error('❌ Re-authentication failed after reconnect:', err);
            // Don't set error immediately - let useAuth handle it
            setConnecting(false);
            setConnected(false);
          }
        }
      });

      client.io.on('disconnect', (reason) => {
        if (mounted) {
          setConnected(false);

          // Auto-reconnect if disconnect was due to server restart (not intentional client disconnect)
          if (reason === 'io server disconnect' || reason === 'transport close') {
            // Socket.io will auto-reconnect, we just need to re-authenticate when it does
          }
        }
      });

      client.io.on('connect_error', (_err: Error) => {
        if (mounted) {
          // Only show error on initial connection failure, not during reconnection attempts
          // If we've connected before, keep showing "reconnecting" state instead of error
          if (!hasConnectedOnce) {
            setError('Daemon is not running. Start it with: cd apps/agor-daemon && pnpm dev');
            setConnecting(false);
            setConnected(false);
          } else {
            // During reconnection, keep connecting=true so UI shows reconnecting indicator
            setConnecting(true);
            setConnected(false);
            // Don't set error - socket.io will keep trying
          }
        }
      });

      // Now manually connect the socket
      client.io.connect();

      // Wait for connection before authenticating
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Connection timeout'));
          }, 5000);

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
      } catch (_err) {
        if (mounted) {
          setError('Failed to connect to daemon. Make sure it is running on :3030');
          setConnecting(false);
          setConnected(false);
        }
        return; // Exit early, don't try to authenticate
      }

      // Authenticate with JWT or anonymous
      try {
        if (accessToken) {
          // Authenticate with JWT token
          await client.authenticate({
            strategy: 'jwt',
            accessToken,
          });
        } else if (allowAnonymous) {
          // Authenticate anonymously
          await client.authenticate({
            strategy: 'anonymous',
          });
        }
      } catch (_err) {
        if (mounted) {
          setError(
            accessToken
              ? 'Authentication failed. Please log in again.'
              : 'Anonymous authentication failed. Check daemon configuration.'
          );
          setConnecting(false);
          setConnected(false);
        }
        return;
      }

      // Authentication successful - connection is ready
      if (mounted) {
        setConnected(true);
        setConnecting(false);
        setError(null);
      }
    }

    connect();

    // Cleanup on unmount
    return () => {
      mounted = false;
      if (client?.io) {
        // Remove all listeners to prevent memory leaks
        client.io.removeAllListeners();
        // Disconnect gracefully (close is more forceful than disconnect)
        client.io.close();
      }
      // Clear global reference
      if (
        typeof window !== 'undefined' &&
        (window as unknown as { __agorClient?: AgorClient }).__agorClient === client
      ) {
        delete (window as unknown as { __agorClient?: AgorClient }).__agorClient;
      }
    };
  }, [url, accessToken, allowAnonymous]);

  /**
   * Manually retry connection
   * Useful when auto-reconnect fails or user wants to force reconnect
   */
  const retryConnection = () => {
    const client = clientRef.current;
    if (!client?.io) return;

    // If already connected, disconnect first
    if (client.io.connected) {
      client.io.disconnect();
    }

    // Trigger reconnection
    setConnecting(true);
    setError(null);
    client.io.connect();
  };

  return {
    client: clientRef.current,
    connected,
    connecting,
    error,
    retryConnection,
  };
}
