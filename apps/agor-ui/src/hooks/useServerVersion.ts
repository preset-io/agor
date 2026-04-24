/**
 * useServerVersion - Detect frontend/backend version drift after a deploy.
 *
 * Captures the daemon's build SHA on first successful connect (in-memory,
 * per tab) and compares against subsequent values seen on the `server-info`
 * welcome event. A mismatch flips `outOfSync` true, which ConnectionStatus
 * surfaces as an amber "refresh to load latest" tag.
 *
 * Source-of-truth: daemon-only. The frontend never bakes its own SHA — the
 * baseline only resets on hard reload, which is exactly the signal we want.
 *
 * Dev mode short-circuit: when either side reports the literal string 'dev'
 * (the daemon fallback when no SHA is resolvable, or when the file/env are
 * absent in source installs), comparison is disabled. Otherwise contributors
 * hot-reloading the daemon would see the banner on every commit.
 *
 * Grace: outOfSync only flips true after a successful handshake confirms
 * the mismatch — never during a transient reconnect, since the welcome event
 * only arrives on a real connection.
 */

import type { AgorClient } from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';

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
 * Subscribe to the daemon's `server-info` welcome event and track drift.
 *
 * @param client The Agor client instance (null while connecting / logged out).
 */
export function useServerVersion(client: AgorClient | null): UseServerVersionResult {
  const [capturedSha, setCapturedSha] = useState<string | null>(null);
  const [currentSha, setCurrentSha] = useState<string | null>(null);
  // Track captured value via ref so the listener closure doesn't capture a
  // stale empty baseline. setState is async; the next welcome event after
  // capture would otherwise still see capturedSha === null.
  const capturedShaRef = useRef<string | null>(null);

  useEffect(() => {
    if (!client?.io) return;

    const handler = (info: ServerInfoEvent) => {
      const sha = typeof info?.buildSha === 'string' ? info.buildSha : null;
      if (!sha) return;
      setCurrentSha(sha);
      if (capturedShaRef.current === null) {
        capturedShaRef.current = sha;
        setCapturedSha(sha);
      }
    };

    client.io.on('server-info', handler);
    return () => {
      client.io.off('server-info', handler);
    };
  }, [client]);

  return {
    capturedSha,
    currentSha,
    outOfSync: isOutOfSync(capturedSha, currentSha),
  };
}
