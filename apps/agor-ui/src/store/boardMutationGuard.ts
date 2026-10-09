/**
 * Board write tickets: the one fence every board-scoped write passes.
 *
 * An unloaded board (a reconnect unloads every board but the displayed one)
 * is read-only: its cached rows and record may be stale, so a write derived
 * from them could restore a deleted zone or persist a wrong pin. A ticket
 * records the partition lifetime the write was decided against. It is
 * captured when the work is queued or its dialog opens, and checked
 * immediately before every dispatch, including each dispatch after an await.
 *
 * The lifetime token is the partition's `generation`. It is kept while the
 * board stays loaded (live membership updates don't change it), and every
 * load gets a new one, so after an unload and reload a ticket from before the
 * unload never matches again, even once the board is loaded.
 *
 * A ticket also belongs to the guard that captured it (`owner`), which ends
 * all of its tickets when it unmounts: a confirmation, dialog or running
 * batch that outlives its component never dispatches. While the owner is
 * mounted it re-renders on every connection change, so the guard judges the
 * connection and auth generation from what it rendered last
 * (`useBoardMutationGuard`).
 */
import { agorStore } from './agorStore';
import { selectBoardPartition } from './boardPartitions';

/** The mounted lifetime of one guard; `alive` turns false when it unmounts. */
export interface BoardWriteOwner {
  readonly alive: boolean;
}

export interface BoardWriteTicket {
  readonly boardId: string;
  /** Generation of the loaded partition the write was decided against; `null` when the write doesn't need one. */
  readonly generation: number | null;
  /** Socket-auth generation at capture: a re-authentication ends the ticket. */
  readonly authGeneration: number;
  /** The guard that captured the ticket: its unmount ends the ticket. */
  readonly owner: BoardWriteOwner;
}

/**
 * A ticket for `boardId` under the owner's `authGeneration`, or `null` when
 * the board can't be written now: the owner unmounted, or its partition isn't
 * loaded (and one is required).
 */
export function captureBoardWriteTicket(
  boardId: string | null | undefined,
  options: { requirePartition: boolean; owner: BoardWriteOwner; authGeneration: number }
): BoardWriteTicket | null {
  const { requirePartition, owner, authGeneration } = options;
  if (!boardId || !owner.alive) return null;
  if (!requirePartition) return { boardId, generation: null, authGeneration, owner };
  const partition = selectBoardPartition(agorStore.getState(), boardId);
  if (partition?.status !== 'loaded') return null;
  return { boardId, generation: partition.generation, authGeneration, owner };
}

/** Whether `ticket`'s partition is still loaded under the generation it was captured with. */
function samePartition(ticket: BoardWriteTicket): boolean {
  const current = selectBoardPartition(agorStore.getState(), ticket.boardId);
  return current?.status === 'loaded' && current.generation === ticket.generation;
}

/**
 * Whether the store side of `ticket` still holds: its owner is mounted and
 * the partition lifetime is unchanged. The guard checks the connection.
 */
export function isBoardWriteTicketCurrent(
  ticket: BoardWriteTicket | null | undefined
): ticket is BoardWriteTicket {
  if (!ticket?.owner?.alive) return false;
  return ticket.generation === null || samePartition(ticket);
}

/**
 * Whether `ticket` can never be current again: there is none, its owner
 * unmounted, a re-authentication replaced its auth generation (`authGeneration`
 * is the caller's current one; generations only advance), or its partition
 * lifetime ended (the board unloaded). A ticket held only by a passing
 * condition (a disconnect, withheld edit) has not.
 */
export function hasBoardWriteTicketEnded(
  ticket: BoardWriteTicket | null | undefined,
  authGeneration: number
): boolean {
  if (!ticket?.owner?.alive) return true;
  if (ticket.authGeneration !== authGeneration) return true;
  return ticket.generation !== null && !samePartition(ticket);
}
