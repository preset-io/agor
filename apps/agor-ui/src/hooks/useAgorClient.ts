// @ts-nocheck - Complex client lifecycle with conditional null states
/**
 * React hook for Agor daemon client connection
 *
 * Manages FeathersJS client lifecycle with React effects
 */

import type { AgorClient } from '@agor/core/api';
import { createClient } from '@agor/core/api';
import { useEffect, useRef, useState } from 'react';
import { getDaemonUrl } from '../config/daemon';
import { getStoredRefreshToken, refreshAndStoreTokens } from '../utils/tokenRefresh';

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

      // Store client globally for Vite HMR cleanup
      if (typeof window !== 'undefined') {
        // biome-ignore lint/suspicious/noExplicitAny: Global window extension for HMR cleanup
        (window as any).__agorClient = client;
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
                console.log('Access token failed on reconnect, attempting refresh...');

                // Check if we have a refresh token in localStorage
                const refreshToken = getStoredRefreshToken();
                if (refreshToken) {
                  try {
                    const refreshResult = await refreshAndStoreTokens(client, refreshToken);

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
          console.log('🔌 Disconnected from daemon:', reason);
          setConnected(false);

          // Auto-reconnect if disconnect was due to server restart (not intentional client disconnect)
          if (reason === 'io server disconnect' || reason === 'transport close') {
            console.log('🔄 Daemon restarted, attempting to reconnect...');
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
            console.log('🔄 Reconnection attempt failed, will retry...');
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
      // biome-ignore lint/suspicious/noExplicitAny: Global window extension for HMR cleanup
      if (typeof window !== 'undefined' && (window as any).__agorClient === client) {
        // biome-ignore lint/suspicious/noExplicitAny: Global window extension for HMR cleanup
        delete (window as any).__agorClient;
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

    console.log('🔄 Manual reconnection requested');

    // If already connected, disconnect first
    if (client.io.connected) {
      console.log('🔌 Disconnecting before retry...');
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
