/**
 * Daemon configuration for UI
 *
 * Reads daemon URL from environment variables or uses defaults
 */

import { DAEMON } from '@agor-live/client';
import { daemonUrlForRuntime, resolveUiRuntime } from './urlRuntime';

/**
 * Get daemon URL for UI connections
 *
 * Reads from VITE_DAEMON_URL environment variable or falls back to default
 */
// Extend window interface for runtime config injection
interface WindowWithAgorConfig extends Window {
  AGOR_DAEMON_URL?: string;
}

export function getDaemonUrl(): string {
  // 1. Explicit config (env var or runtime injection)
  // Handles: production and any special setup
  if (typeof window !== 'undefined') {
    const injectedUrl = (window as WindowWithAgorConfig).AGOR_DAEMON_URL;
    if (injectedUrl) return injectedUrl;
  }

  const envUrl = import.meta.env.VITE_DAEMON_URL;
  if (envUrl) return envUrl;

  // 2. Same-host assumption: daemon runs on same host as UI
  // Use VITE_DAEMON_PORT if available, otherwise use default from constants
  const daemonPort = import.meta.env.VITE_DAEMON_PORT || String(DAEMON.DEFAULT_PORT);

  if (typeof window !== 'undefined') {
    const runtime = resolveUiRuntime({
      baseUrl: import.meta.env.BASE_URL,
      pathname: window.location.pathname,
    });
    return daemonUrlForRuntime(runtime, window.location.origin, daemonPort);
  }

  // 3. Server-side fallback
  return `http://${DAEMON.DEFAULT_HOST}:${daemonPort}`;
}

/**
 * Default daemon URL (for backwards compatibility)
 */
export const DEFAULT_DAEMON_URL = getDaemonUrl();
