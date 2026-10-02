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
 * The lifetime token is the `loaded` partition entry itself. `setBoardPartition`
 * replaces the entry on every change, so an unload followed by a reload yields
 * a new entry: a ticket from before the unload never matches again, even once
 * the board is loaded.
 *
 * A ticket also belongs to the guard that captured it (`owner`), which ends
 * all of its tickets when it unmounts: a confirmation, dialog or running
 * batch that outlives its component never dispatches. The connection and auth
 * generation are read from the published snapshot when checked, never from
 * values an owner rendered.
 */
import { agorStore, type BoardPartitionState } from './agorStore';
import { connectionAllowsWrites, getConnectionSnapshot } from './connectionSnapshot';

/** The mounted lifetime of one guard; `alive` turns false when it unmounts. */
export interface BoardWriteOwner {
  readonly alive: boolean;
}

export interface BoardWriteTicket {
  readonly boardId: string;
  /** The loaded partition the write was decided against; `null` when the write doesn't need one. */
  readonly partition: BoardPartitionState | null;
  /** Socket-auth generation at capture: a re-authentication ends the ticket. */
  readonly authGeneration: number;
  /** The guard that captured the ticket: its unmount ends the ticket. */
  readonly owner: BoardWriteOwner;
}

/**
 * A ticket for `boardId`, or `null` when the board can't be written now: the
 * owner unmounted, the connection is unusable, or its partition isn't loaded
 * (and one is required).
 */
export function captureBoardWriteTicket(
  boardId: string | null | undefined,
  options: { requirePartition: boolean; owner: BoardWriteOwner }
): BoardWriteTicket | null {
  const { requirePartition, owner } = options;
  const connection = getConnectionSnapshot();
  if (!boardId || !owner.alive || !connectionAllowsWrites(connection)) return null;
  const { authGeneration } = connection;
  if (!requirePartition) return { boardId, partition: null, authGeneration, owner };
  const partition = agorStore.getState().boardPartitions.get(boardId);
  if (partition?.status !== 'loaded') return null;
  return { boardId, partition, authGeneration, owner };
}

/**
 * Whether everything `ticket` was captured under still holds now: its owner
 * is mounted, the connection is usable under the same auth generation, and
 * the partition lifetime is unchanged.
 */
export function isBoardWriteTicketCurrent(
  ticket: BoardWriteTicket | null | undefined
): ticket is BoardWriteTicket {
  if (!ticket?.owner?.alive) return false;
  const connection = getConnectionSnapshot();
  if (!connectionAllowsWrites(connection)) return false;
  if (ticket.authGeneration !== connection.authGeneration) return false;
  if (ticket.partition === null) return true;
  const current = agorStore.getState().boardPartitions.get(ticket.boardId);
  return current === ticket.partition && current.status === 'loaded';
}
