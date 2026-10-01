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

const IDLE: FullSessionDetailsState = { status: 'idle' };
const LOADING: FullSessionDetailsState = { status: 'loading' };

export function useFullSessionDetails(
  client: AgorClient | null | undefined,
  row: Session | null | undefined,
  enabled = true
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
    let cancelled = false;
    setStored({ sessionId, status: 'loading' });
    (client.service('sessions').get(sessionId) as Promise<Session>).then(
      (session) => {
        if (!cancelled) setStored({ sessionId, status: 'ready', session });
      },
      (error: unknown) => {
        if (!cancelled) setStored({ sessionId, status: 'error', error });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, client, attempt]);

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
