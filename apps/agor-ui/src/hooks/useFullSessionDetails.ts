/**
 * Full session record for surfaces that read withheld `custom_context` keys.
 *
 * Store rows may be lean list rows (`SessionListRow`) that withhold
 * `scheduled_run` / `slash_commands` / `skills`. A surface that edits or
 * renders the whole `custom_context` (session settings, zone triggers) must
 * not treat such a row as complete, so it resolves the full record here:
 *
 * - a full store row is used as is (`ready` on the first render);
 * - a lean row is fetched with `sessions.get`;
 * - a failed fetch is a visible `error` with `retry`, and is retried
 *   automatically when the socket re-authenticates (reconnect);
 * - a fetch that does not answer within `timeoutMs` is the same `error`
 *   (a late answer to that attempt is ignored; Retry starts a new one);
 * - once `ready` for a session id, the result is kept while enabled — a later
 *   store downgrade or client change does not reload it under the user;
 *   disabling (closing the surface) forgets it so the next use reloads.
 */
import type { AgorClient, Session } from '@agor-live/client';
import { hasFullSessionDetails } from '@agor-live/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOptionalConnectionState } from '../contexts/ConnectionContext';

export type FullSessionDetailsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; session: Session }
  | { status: 'error'; error: unknown };

type StoredResult = FullSessionDetailsState & { sessionId: string };

/** How long a `sessions.get` may stay unanswered before it counts as failed. */
export const FULL_SESSION_DETAILS_TIMEOUT_MS = 15_000;

/** The full-record request did not answer in time. */
export class FullSessionDetailsTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`the request timed out after ${Math.round(timeoutMs / 1000)} s`);
    this.name = 'FullSessionDetailsTimeoutError';
  }
}

const IDLE: FullSessionDetailsState = { status: 'idle' };
const LOADING: FullSessionDetailsState = { status: 'loading' };

export function useFullSessionDetails(
  client: AgorClient | null | undefined,
  row: Session | null | undefined,
  enabled = true,
  timeoutMs = FULL_SESSION_DETAILS_TIMEOUT_MS
): FullSessionDetailsState & { retry: () => void } {
  const sessionId = enabled ? (row?.session_id ?? null) : null;
  const [stored, setStored] = useState<StoredResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  const authGeneration = useOptionalConnectionState()?.authGeneration ?? 0;

  const current = stored?.sessionId === sessionId ? stored : null;
  const currentRef = useRef(current);
  currentRef.current = current;
  const rowRef = useRef(row);
  rowRef.current = row;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger
  useEffect(() => {
    // Disabled (e.g. the modal closed): forget, so the next open reloads.
    if (!sessionId) {
      setStored(null);
      return;
    }
    if (currentRef.current?.status === 'ready') return;
    const candidate = rowRef.current;
    if (candidate && hasFullSessionDetails(candidate)) {
      setStored({ sessionId, status: 'ready', session: candidate });
      return;
    }
    if (!client) return;
    // Settled by the first of: the answer, a failure, the timeout, cleanup.
    let settled = false;
    const settle = (next: StoredResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setStored(next);
    };
    setStored({ sessionId, status: 'loading' });
    const timer = setTimeout(
      () =>
        settle({
          sessionId,
          status: 'error',
          error: new FullSessionDetailsTimeoutError(timeoutMs),
        }),
      timeoutMs
    );
    (client.service('sessions').get(sessionId) as Promise<Session>).then(
      (session) => settle({ sessionId, status: 'ready', session }),
      (error: unknown) => settle({ sessionId, status: 'error', error })
    );
    return () => {
      settled = true;
      clearTimeout(timer);
    };
  }, [sessionId, client, attempt, timeoutMs]);

  // A reconnect (new socket-auth generation) retries a failed load.
  const authGenerationRef = useRef(authGeneration);
  useEffect(() => {
    if (authGenerationRef.current === authGeneration) return;
    authGenerationRef.current = authGeneration;
    if (currentRef.current?.status === 'error') setAttempt((value) => value + 1);
  }, [authGeneration]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  let state: FullSessionDetailsState;
  if (!sessionId) state = IDLE;
  else if (current) state = current;
  else if (row && hasFullSessionDetails(row)) state = { status: 'ready', session: row };
  else state = LOADING;
  return { ...state, retry };
}

/** User-facing message for a failed full-details load. */
export function fullSessionDetailsErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : undefined;
  return message
    ? `Could not load full session details: ${message}`
    : 'Could not load full session details.';
}
