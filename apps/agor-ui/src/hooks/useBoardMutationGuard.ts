import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useConnectionState, useMutationGate } from '../contexts/ConnectionContext';
import { useAgorStore } from '../store/agorStore';
import {
  type BoardWriteTicket,
  captureBoardWriteTicket,
  isBoardWriteTicketCurrent,
} from '../store/boardMutationGuard';
import { makeBoardPartitionSelector } from '../store/boardPartitions';
import { useThemedMessage } from '../utils/message';

export interface BoardMutationGuard {
  /** A write captured now would be accepted (reactive; drives disabled states). */
  canMutate: boolean;
  /**
   * Capture a ticket when work is queued or a dialog/picker opens; `null` when
   * the board can't be written now.
   */
  capture: () => BoardWriteTicket | null;
  /**
   * Whether a write under `ticket` may dispatch right now: this guard captured
   * it and is still mounted, same board, same partition lifetime and auth
   * generation, still allowed, connection usable.
   */
  isCurrent: (ticket: BoardWriteTicket | null | undefined) => ticket is BoardWriteTicket;
  /**
   * Run `dispatch` only if `ticket` is current; otherwise drop it, with
   * `staleWarning` shown to the user when given. Resolves whether it ran.
   * `dispatch` must send its request synchronously (no await before it).
   */
  write: (
    ticket: BoardWriteTicket | null | undefined,
    dispatch: () => Promise<unknown>,
    staleWarning?: string
  ) => Promise<boolean>;
  /** Show the standard "not saved" warning for a dropped write. */
  warnDropped: (message?: string) => void;
}

export const BOARD_RELOADED_WARNING = "Couldn't save your change, because the board reloaded.";

/**
 * The outcome of a ticketed board write: `true` saved, `false` the request
 * failed (retryable as is), `'stale'` refused because its ticket no longer
 * holds — nothing was sent, and only a new ticket, captured on an explicit
 * user action, may send it.
 */
export type BoardWriteResult = boolean | 'stale';

/**
 * The single fence for board-scoped writes (see `store/boardMutationGuard.ts`).
 * `allowed` is the caller's permission for this kind of write (board.edit,
 * comment, …); the connection mutation gate is always applied. Every check
 * reads the connection and partition as they are now, so a ticket held by a
 * stale closure is still judged now; once the guard unmounts, none of its
 * tickets is current again.
 */
export function useBoardMutationGuard(
  boardId: string | null | undefined,
  allowed: boolean,
  options: { requirePartition?: boolean } = {}
): BoardMutationGuard {
  const requirePartition = options.requirePartition ?? true;
  const gate = useMutationGate();
  const { authGeneration } = useConnectionState();
  const { showWarning } = useThemedMessage();
  const partition = useAgorStore(useMemo(() => makeBoardPartitionSelector(boardId), [boardId]));

  // What the owner rendered last. It consumes the connection, so it renders
  // again in the very render a connection change arrives; a ticket whose
  // owner no longer renders is dead (`owner`).
  const live = useRef({ boardId, allowed, canMutate: gate.canMutate, authGeneration });
  live.current = { boardId, allowed, canMutate: gate.canMutate, authGeneration };

  // This guard's mounted lifetime: unmounting ends every ticket it captured.
  // (A StrictMode remount starts a new lifetime.) A layout cleanup runs in the
  // unmount's commit, before its DOM removal is observable; a passive cleanup
  // can run a task later, after a promise continuation already dispatched.
  const ownerRef = useRef({ alive: true });
  useLayoutEffect(() => {
    if (!ownerRef.current.alive) ownerRef.current = { alive: true };
    const owner = ownerRef.current;
    return () => {
      owner.alive = false;
    };
  }, []);

  const canMutate =
    !!boardId && allowed && gate.canMutate && (!requirePartition || partition?.status === 'loaded');

  const isCurrent = useCallback(
    (ticket: BoardWriteTicket | null | undefined): ticket is BoardWriteTicket => {
      const now = live.current;
      return (
        now.allowed &&
        now.canMutate &&
        ticket?.owner === ownerRef.current &&
        ticket.boardId === now.boardId &&
        ticket.authGeneration === now.authGeneration &&
        isBoardWriteTicketCurrent(ticket)
      );
    },
    []
  );

  const capture = useCallback(() => {
    const ticket = captureBoardWriteTicket(live.current.boardId, {
      requirePartition,
      owner: ownerRef.current,
      authGeneration: live.current.authGeneration,
    });
    return isCurrent(ticket) ? ticket : null;
  }, [requirePartition, isCurrent]);

  const warnDropped = useCallback(
    (message: string = BOARD_RELOADED_WARNING) => showWarning(message),
    [showWarning]
  );

  const write = useCallback(
    async (
      ticket: BoardWriteTicket | null | undefined,
      dispatch: () => Promise<unknown>,
      staleWarning?: string
    ) => {
      if (!isCurrent(ticket)) {
        if (staleWarning) showWarning(staleWarning);
        return false;
      }
      await dispatch();
      return true;
    },
    [isCurrent, showWarning]
  );

  return useMemo(
    () => ({ canMutate, capture, isCurrent, write, warnDropped }),
    [canMutate, capture, isCurrent, write, warnDropped]
  );
}
