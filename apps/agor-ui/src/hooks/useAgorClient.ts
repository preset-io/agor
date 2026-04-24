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
import { isDefiniteAuthFailure } from '../utils/authErrors';
import {
  RefreshUnrecoverableError,
  refreshAndReauthenticate,
  TOKENS_REFRESHED_EVENT,
} from '../utils/singleFlightRefresh';
import type { RefreshResult } from '../utils/tokenRefresh';

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

  // Keep the latest access token in a ref so the long-lived socket effect
  // can read it without taking it as a dependency. Before this split, every
  // token refresh (every ~14 min at the 15m TTL) changed `accessToken` →
  // the effect re-ran → the socket was torn down and recreated from scratch,
  // which reset real-time subscriptions and explicitly flipped
  // `connected: false` at connect() start — a UI flicker that no disconnect
  // grace period could catch. The effect now rebuilds only when the
  // *presence* of a token flips (login/logout) or when url/allowAnonymous
  // changes; in-place refreshes just re-authenticate the existing socket.
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;
  const hasToken = !!accessToken;

  useEffect(() => {
    let mounted = true;
    let client: AgorClient | null = null;
    let hasConnectedOnce = false; // Track if we've ever connected successfully

    // Bookkeeping for the manual reconnect path used on 'io server disconnect'.
    // socket.io does NOT auto-reconnect for that reason, so we kick it
    // ourselves — but without backoff+cap the loop can run at network speed
    // if the server keeps closing the socket (e.g. auth failures, crash loop,
    // config mismatch). Reset on any successful connect.
    let manualReconnectAttempts = 0;
    let manualReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const MAX_MANUAL_RECONNECT_ATTEMPTS = 10;
    const clearManualReconnectTimer = () => {
      if (manualReconnectTimer !== null) {
        clearTimeout(manualReconnectTimer);
        manualReconnectTimer = null;
      }
    };

    // Grace period before flipping `connected` to false on a disconnect.
    // Most reconnects (tsx watch reload, brief network blip, JWT refresh
    // reauth) finish well under 1s. Flipping `connected` immediately makes
    // every `useConnectionDisabled` consumer disable — buttons, forms,
    // inline inputs — producing a UI flicker. Instead, fire `connecting:true`
    // immediately for the navbar status tag, and only flip `connected` if
    // the reconnect hasn't finished within DISCONNECT_GRACE_MS. If we
    // reconnect inside the window, consumers never see a disabled frame.
    const DISCONNECT_GRACE_MS = 1500;
    let disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
    const clearDisconnectGrace = () => {
      if (disconnectGraceTimer !== null) {
        clearTimeout(disconnectGraceTimer);
        disconnectGraceTimer = null;
      }
    };
    const scheduleDisconnectedFlip = () => {
      if (disconnectGraceTimer !== null) return; // already pending
      disconnectGraceTimer = setTimeout(() => {
        disconnectGraceTimer = null;
        if (!mounted) return;
        setConnected(false);
      }, DISCONNECT_GRACE_MS);
    };

    async function connect() {
      // Don't create client if no access token and anonymous not allowed.
      // `hasToken` is the effect-level snapshot (also a dep, so a later
      // login rebuilds the effect); we still read the value from the ref
      // below in case it rotated during the async connect path.
      if (!hasToken && !allowAnonymous) {
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
      //   3. Retry the original call exactly once, via the raw method args so
      //      custom (non-CRUD) service methods retry as well.
      // The `_refreshRetried` flag on params guards against infinite recursion
      // if the retry itself fails auth (e.g. refresh token also expired).
      //
      // Skip `authentication` (login) and `authentication/refresh` themselves
      // so we never recurse on the refresh call. Auth-adjacent routes like
      // `authentication/impersonate` go through the retry like any other
      // service call.
      const AUTH_PATHS_TO_SKIP = new Set(['authentication', 'authentication/refresh']);
      client.hooks({
        around: {
          all: [
            async (context, next) => {
              const path = context.path;
              if (typeof path === 'string' && AUTH_PATHS_TO_SKIP.has(path)) {
                await next();
                return;
              }

              try {
                await next();
              } catch (err) {
                if (!isDefiniteAuthFailure(err)) throw err;

                // Guard against infinite retry if the retry also 401s.
                const currentParams = (context.params ?? {}) as Record<string, unknown>;
                if (currentParams._refreshRetried) throw err;

                if (!client) throw err;

                try {
                  const result = await refreshAndReauthenticate(client);
                  if (!result) throw err; // no refresh token stored
                } catch {
                  // Refresh or re-authenticate failed — surface the original
                  // auth error so upstream code (useAuth, connect handler)
                  // can decide whether to clear tokens and bounce to login.
                  throw err;
                }

                // Retry the original call once via its raw argument list so
                // custom service methods (non-CRUD) retry correctly too.
                // Feathers service methods always end with a `params` arg; we
                // inject `_refreshRetried: true` there to stop recursion if
                // the retry itself 401s.
                const args = context.arguments ? [...context.arguments] : [];
                const lastIdx = args.length - 1;
                const lastArg = args[lastIdx];
                const isParamsObject =
                  lastArg !== null && typeof lastArg === 'object' && !Array.isArray(lastArg);
                const retryParams = {
                  ...(isParamsObject ? (lastArg as Record<string, unknown>) : {}),
                  _refreshRetried: true,
                };
                if (isParamsObject) {
                  args[lastIdx] = retryParams;
                } else {
                  args.push(retryParams);
                }

                const service = client.service(path as string) as Record<string, unknown>;
                const method = context.method as string;
                const methodFn = service[method];
                if (typeof methodFn !== 'function') throw err;
                context.result = await (methodFn as (...a: unknown[]) => unknown).call(
                  service,
                  ...args
                );
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
          // Reset manual-reconnect backoff now that we're connected again.
          manualReconnectAttempts = 0;
          clearManualReconnectTimer();
          // Cancel any pending "flip to disconnected" — we made it back in
          // time, so consumers never saw a disabled frame.
          clearDisconnectGrace();

          // Re-authenticate on reconnection (e.g., after daemon restart or
          // network recovery). Read the token from the ref to pick up any
          // refresh that happened while we were disconnected.
          const currentAccessToken = accessTokenRef.current;
          try {
            if (currentAccessToken) {
              // Try to authenticate with access token first
              try {
                await client.authenticate({
                  strategy: 'jwt',
                  accessToken: currentAccessToken,
                });
                setConnected(true);
                setConnecting(false);
                setError(null);
                return;
              } catch (_accessTokenErr) {
                // Access token expired or invalid — try the refresh token.
                // `refreshAndReauthenticate` fires the single-flight refresh
                // and re-authenticates this socket client with the new access
                // token, shared with the 401-retry hook above.
                try {
                  const refreshResult = await refreshAndReauthenticate(client);
                  if (refreshResult) {
                    setConnected(true);
                    setConnecting(false);
                    setError(null);
                    return;
                  }
                  // refreshResult === null means no refresh token stored —
                  // treat as terminal (nothing to retry with).
                } catch (refreshErr) {
                  console.error('❌ Refresh failed on reconnect:', refreshErr);
                  // Only flip to the terminal "session expired" state on
                  // definite auth failure. Transient errors (5xx, network)
                  // should keep `connecting: true` so the normal socket
                  // reconnect can retry later — otherwise a daemon restart
                  // that briefly 5xxs the refresh endpoint would strand
                  // the UI in a hard "Session expired" state even though
                  // the tokens may still be valid. useAuth's unrecoverable
                  // listener has already cleared tokens on the auth path.
                  if (
                    refreshErr instanceof RefreshUnrecoverableError ||
                    isDefiniteAuthFailure(refreshErr)
                  ) {
                    setConnecting(false);
                    setConnected(false);
                    setError('Session expired. Please log in again.');
                    return;
                  }
                  setConnected(false);
                  setConnecting(true);
                  return;
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
        if (!mounted) return;
        // If we've never been connected (initial-load failure), flip
        // immediately — no "reconnect" to wait for. Otherwise defer the
        // flip via the grace timer so quick reconnects don't flicker the
        // UI; the navbar still shows "Reconnecting" via connecting=true.
        if (hasConnectedOnce) {
          scheduleDisconnectedFlip();
        } else {
          setConnected(false);
        }

        // Reason matters here. Per socket.io docs:
        //   - 'io server disconnect' fires when the server explicitly closed
        //     the socket (e.g. graceful shutdown calling io.close()). The
        //     client will NOT auto-reconnect — we have to kick it manually.
        //     This was the bug: tsx watch + production graceful restarts both
        //     hit this path, and the UI got stuck on "Disconnected" until the
        //     user clicked retry.
        //   - 'transport close' / 'transport error' / 'ping timeout' fire on
        //     network-level drops (container crash, wifi flap, etc.). Socket.io
        //     handles auto-reconnect for these.
        // In both auto-reconnect paths we flip connecting=true so the UI shows
        // "Reconnecting" immediately rather than flashing "Disconnected" for
        // the gap before the first connect_error fires.
        if (reason === 'io server disconnect') {
          // Manual reconnect with exponential backoff + cap. Previously we
          // called `client.io.connect()` immediately on every disconnect;
          // when the server repeatedly closed the socket (auth rejection,
          // crash loop, server-side kick) this created a tight reconnect
          // loop at network speed and a page refresh was the only way out.
          if (manualReconnectAttempts >= MAX_MANUAL_RECONNECT_ATTEMPTS) {
            setConnecting(false);
            // Give-up path — flip connected immediately; the grace period
            // is only for quick reconnects we expect to recover from.
            clearDisconnectGrace();
            setConnected(false);
            setError('Lost connection to daemon after multiple attempts. Please reload the page.');
            return;
          }
          setConnecting(true);
          const attempt = manualReconnectAttempts++;
          // 500ms, 1s, 2s, 4s, 8s, 16s, 30s cap.
          const delay = Math.min(500 * 2 ** attempt, 30_000);
          clearManualReconnectTimer();
          manualReconnectTimer = setTimeout(() => {
            manualReconnectTimer = null;
            if (!mounted) return;
            client?.io.connect();
          }, delay);
        } else if (
          reason === 'transport close' ||
          reason === 'transport error' ||
          reason === 'ping timeout'
        ) {
          setConnecting(true);
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

      // Authenticate with JWT or anonymous. Pull the token from the ref
      // so if a refresh landed while we were establishing the socket, we
      // use the fresh one.
      const initialAccessToken = accessTokenRef.current;
      try {
        if (initialAccessToken) {
          // Authenticate with JWT token
          await client.authenticate({
            strategy: 'jwt',
            accessToken: initialAccessToken,
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
            initialAccessToken
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

    // In-place reauth on token refresh. When singleFlightRefresh rotates
    // the access token, it dispatches TOKENS_REFRESHED_EVENT. Instead of
    // rebuilding the entire socket (which would flicker the UI and reset
    // every real-time subscription), we just call client.authenticate with
    // the new token on the existing socket. If the socket happens to be
    // disconnected at the moment of refresh, skip — the connect handler
    // will pick up the fresh token from the ref when the socket reconnects.
    const handleTokensRefreshed = (event: Event) => {
      if (!mounted) return;
      const detail = (event as CustomEvent<RefreshResult>).detail;
      if (!detail || !client) return;
      if (!client.io.connected) return;
      client.authenticate({ strategy: 'jwt', accessToken: detail.accessToken }).catch((err) => {
        // Best-effort — if this fails, the next service call will 401
        // and the around-hook will take the standard refresh-and-retry
        // path. Log so the cause isn't invisible.
        console.error('In-place re-authentication failed after token refresh:', err);
      });
    };
    window.addEventListener(TOKENS_REFRESHED_EVENT, handleTokensRefreshed);

    // Cleanup on unmount
    return () => {
      mounted = false;
      clearManualReconnectTimer();
      clearDisconnectGrace();
      window.removeEventListener(TOKENS_REFRESHED_EVENT, handleTokensRefreshed);
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
    // The dep list deliberately uses `hasToken` (presence), not the token
    // value itself: see the accessTokenRef comment above. Rebuilds happen
    // only on login/logout and url/allowAnonymous changes; token refreshes
    // are absorbed in-place by the handler above.
  }, [url, hasToken, allowAnonymous]);

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
