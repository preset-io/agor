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
 */
export function useServerVersion(
  client: AgorClient | null,
  daemonUrl: string = getDaemonUrl()
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

  // Initial baseline: fetch /health on mount. This runs regardless of socket
  // state and guarantees we capture the SHA the daemon is running RIGHT NOW,
  // before the daemon ever has a chance to be rebuilt under us. Without this,
  // we'd race the welcome event and usually lose (see top-of-file comment).
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${daemonUrl.replace(/\/$/, '')}/health`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { buildSha?: string } | null) => {
        if (typeof body?.buildSha === 'string') recordSha(body.buildSha);
      })
      .catch(() => {
        // Daemon unreachable on first load — no baseline. The socket listener
        // below will pick up the SHA on the first real connection. This is
        // acceptable because if the daemon was unreachable at load time, the
        // tab couldn't have rendered against a stale SHA anyway.
      });
    return () => controller.abort();
  }, [daemonUrl, recordSha]);

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
