/**
 * useServerVersion - Detect frontend/backend version drift after a deploy.
 *
 * Captures the daemon's build SHA on first load (in-memory, per tab) via a
 * direct GET /health, then watches the `server-info` welcome event on every
 * subsequent socket reconnect. If a later SHA disagrees, `outOfSync` flips
 * true and ConnectionStatus surfaces an amber "refresh to load latest" tag.
 *
 * Why /health *and* the socket event: the welcome event fires inside the
 * daemon's `io.on('connection', ...)` immediately when the socket connects.
 * useAgorClient stores the client in a ref and only triggers re-renders via
 * state, so by the time this hook re-runs with a non-null client and attaches
 * its listener, the initial welcome event has already been fired and missed.
 * The /health fetch sidesteps the timing entirely — it doesn't need the
 * client and runs on mount. The socket listener still matters for capturing
 * the *new* SHA after the daemon is rebuilt while the tab is open.
 *
 * Source-of-truth: daemon-only. The frontend never bakes its own SHA — the
 * baseline only resets on hard reload, which is exactly the signal we want.
 *
 * Dev mode short-circuit: when either side reports the literal string 'dev'
 * (the daemon fallback when no SHA is resolvable, or when the file/env are
 * absent in source installs), comparison is disabled. Otherwise contributors
 * hot-reloading the daemon would see the banner on every commit.
 *
 * Grace: outOfSync only flips true after a successful response confirms the
 * mismatch — never during a transient reconnect, since both /health and the
 * welcome event only deliver values on a real, healthy connection.
 */

import type { AgorClient } from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getDaemonUrl } from '../config/daemon';

/** SHA value treated as "no version check" — see setup/build-info.ts. */
export const DEV_SHA = 'dev';

/**
 * How often to re-poll /health for drift after the initial baseline. 60s
 * catches deploys quickly without being wasteful — /health is a tiny JSON
 * response. The socket `server-info` event still fires on reconnect; this
 * just covers the case where the socket stays connected through a deploy.
 */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * Pure comparison helper. Exposed for testing.
 *
 * Returns true ONLY when both values are concrete, non-empty SHAs and they
 * disagree. Any 'dev' / null / undefined / empty value short-circuits to
 * false (no banner) — these represent "unknown" and we never cry wolf on
 * unknown.
 */
export function isOutOfSync(
  capturedSha: string | null | undefined,
  currentSha: string | null | undefined
): boolean {
  if (!capturedSha || !currentSha) return false;
  if (capturedSha === DEV_SHA || currentSha === DEV_SHA) return false;
  return capturedSha !== currentSha;
}

interface ServerInfoEvent {
  buildSha?: string;
  builtAt?: string | null;
}

export interface UseServerVersionResult {
  /**
   * The SHA captured on the first successful handshake of this tab. Stays
   * stable across reconnects and only resets on hard reload.
   */
  capturedSha: string | null;
  /**
   * The most recent SHA the daemon has reported (welcome event or /health
   * fallback). Useful for the About tab to show "current" vs "captured".
   */
  currentSha: string | null;
  /** True when capturedSha and currentSha disagree (and neither is 'dev'). */
  outOfSync: boolean;
}

/**
 * Track the daemon's build SHA against the SHA captured at tab-load time.
 *
 * @param client The Agor client (null while connecting / logged out). Used
 *   only for the post-load `server-info` listener; the initial baseline comes
 *   from a direct /health fetch and does not require the client.
 * @param daemonUrl Override the URL probed for /health. Defaults to the
 *   resolved daemon URL. Exposed for tests.
 * @param pollIntervalMs How often to re-fetch /health to catch drift when the
 *   socket stays connected through a deploy. Pass 0 to disable. Exposed for
 *   tests.
 */
export function useServerVersion(
  client: AgorClient | null,
  daemonUrl: string = getDaemonUrl(),
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS
): UseServerVersionResult {
  const [capturedSha, setCapturedSha] = useState<string | null>(null);
  const [currentSha, setCurrentSha] = useState<string | null>(null);
  // Track captured value via ref so updates from /health and the socket
  // listener don't race each other. setState is async; without the ref, two
  // near-simultaneous updates could both see capturedSha === null and the
  // second would clobber the first.
  const capturedShaRef = useRef<string | null>(null);

  // Stable so both effects below can reference it without churning their
  // dependency lists. Only uses the ref + setters, none of which change.
  const recordSha = useCallback((sha: string | null) => {
    if (!sha) return;
    setCurrentSha(sha);
    if (capturedShaRef.current === null) {
      capturedShaRef.current = sha;
      setCapturedSha(sha);
    }
  }, []);

  // Initial baseline + periodic poll: fetch /health on mount and then every
  // pollIntervalMs. The mount fetch guarantees we capture the SHA the daemon
  // is running RIGHT NOW (without it we'd race the welcome event — see
  // top-of-file). The poll covers the case where a deploy happens while the
  // socket stays connected, so server-info never re-fires.
  useEffect(() => {
    const controller = new AbortController();
    const base = daemonUrl.replace(/\/$/, '');

    const fetchOnce = () => {
      fetch(`${base}/health`, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { buildSha?: string } | null) => {
          if (typeof body?.buildSha === 'string') recordSha(body.buildSha);
        })
        .catch(() => {
          // Daemon unreachable — no-op. If this is the first call we just
          // have no baseline yet; the socket listener will fill it in. If
          // it's a poll, we keep the previously-known currentSha.
        });
    };

    fetchOnce();
    const interval = pollIntervalMs > 0 ? setInterval(fetchOnce, pollIntervalMs) : null;

    return () => {
      controller.abort();
      if (interval !== null) clearInterval(interval);
    };
  }, [daemonUrl, pollIntervalMs, recordSha]);

  // Live updates: a fresh socket connection (e.g. after the daemon is
  // rebuilt and clients reconnect) emits server-info, which lets us see the
  // *new* SHA without the user touching anything.
  useEffect(() => {
    if (!client?.io) return;

    const handler = (info: ServerInfoEvent) => {
      if (typeof info?.buildSha === 'string') recordSha(info.buildSha);
    };

    client.io.on('server-info', handler);
    return () => {
      client.io.off('server-info', handler);
    };
  }, [client, recordSha]);

  return {
    capturedSha,
    currentSha,
    outOfSync: isOutOfSync(capturedSha, currentSha),
  };
}
