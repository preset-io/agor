import { useCallback } from 'react';
import { useLocalStorage } from './useLocalStorage';

export type EjectedSessionPositions = Record<string, { x: number; y: number }>;

/**
 * Persists ejected session canvas positions in localStorage, scoped per user+board.
 *
 * Ejected sessions are removed from the right-panel drawer and rendered as
 * full interactive nodes on the board canvas instead. Each session maintains
 * its own realtime subscription, draft persistence, and prompt input.
 *
 * Key: `agor:ejected:<userId>:<boardId>` — scoped so switching boards shows
 * only the ejected sessions belonging to that board.
 */
export function useEjectedSessions(
  userId: string | undefined,
  boardId: string
): {
  ejectedSessions: EjectedSessionPositions;
  ejectSession: (sessionId: string, position: { x: number; y: number }) => void;
  updateEjectedPosition: (sessionId: string, position: { x: number; y: number }) => void;
  redockSession: (sessionId: string) => void;
  closeEjectedSession: (sessionId: string) => void;
} {
  const storageKey = userId && boardId ? `agor:ejected:${userId}:${boardId}` : 'agor:ejected:anon:';

  const [ejectedSessions, setEjectedSessions] = useLocalStorage<EjectedSessionPositions>(
    storageKey,
    {}
  );

  const ejectSession = useCallback(
    (sessionId: string, position: { x: number; y: number }) => {
      setEjectedSessions((prev) => ({ ...prev, [sessionId]: position }));
    },
    [setEjectedSessions]
  );

  const updateEjectedPosition = useCallback(
    (sessionId: string, position: { x: number; y: number }) => {
      setEjectedSessions((prev) => {
        if (!prev[sessionId]) return prev;
        return { ...prev, [sessionId]: position };
      });
    },
    [setEjectedSessions]
  );

  /** Remove from ejected set so the caller can open the session in the drawer. */
  const redockSession = useCallback(
    (sessionId: string) => {
      setEjectedSessions((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    },
    [setEjectedSessions]
  );

  /** Close without re-docking: removes from canvas; next click opens in drawer. */
  const closeEjectedSession = useCallback(
    (sessionId: string) => {
      setEjectedSessions((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    },
    [setEjectedSessions]
  );

  return {
    ejectedSessions,
    ejectSession,
    updateEjectedPosition,
    redockSession,
    closeEjectedSession,
  };
}
