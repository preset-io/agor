import { generateId } from '@agor/core/ids/browser';
import type { Board, BoardEntityObject } from '@agor-live/client';
import {
  type BoardEntityPlacementSnapshot,
  sameBoardEntityPlacement,
  snapshotBoardEntityPlacement,
} from './entityPlacementReconciliation';

export interface EntityPlacementIntent {
  nodeId: string;
  valid: boolean;
  observed: BoardEntityPlacementSnapshot | null;
}

/** Canvas-lifetime ownership, not authorization. HTTP completion never edits local intent.
 * Realtime echoes carry a request ID so equal-coordinate/ABA moves are not mistaken
 * for confirmations of a newer drag. Same-node dispatches serialize; other nodes do not.
 */
export class EntityPlacementWrites {
  private intents = new Map<string, EntityPlacementIntent>();
  // Keep request identities until this board/auth scope closes: a delayed echo
  // must not become an external write merely because a debounce/cache TTL elapsed.
  private requests = new Map<
    string,
    { nodeId: string; placement: BoardEntityPlacementSnapshot | null }
  >();
  private pending = new Map<string, Promise<unknown>>();
  private active = true;

  private invalidate: (nodeId: string) => void;

  constructor(invalidate: (nodeId: string) => void) {
    this.invalidate = invalidate;
  }

  queue(nodeId: string, placement: BoardEntityObject | undefined, board: Board) {
    const intent = {
      nodeId,
      valid: true,
      observed: snapshotBoardEntityPlacement(placement, board),
    };
    this.intents.set(nodeId, intent);
    return intent;
  }

  owns(nodeId: string, placement: BoardEntityObject | undefined, board: Board | null | undefined) {
    const request = placement?.placement_write_id
      ? this.requests.get(placement.placement_write_id)
      : undefined;
    return (
      request?.nodeId === nodeId &&
      sameBoardEntityPlacement(request.placement, snapshotBoardEntityPlacement(placement, board))
    );
  }

  observe(
    nodeId: string,
    placement: BoardEntityObject | undefined,
    board: Board | null | undefined
  ) {
    const intent = this.intents.get(nodeId);
    if (!intent) return;
    const next = snapshotBoardEntityPlacement(placement, board);
    if (!sameBoardEntityPlacement(intent.observed, next) && !this.owns(nodeId, placement, board)) {
      intent.valid = false;
      this.invalidate(nodeId);
    }
    intent.observed = next;
  }

  observeAll(rows: BoardEntityObject[], board: Board | null | undefined) {
    const byNode = new Map(rows.map((row) => [row.branch_id ?? `card-${row.card_id}`, row]));
    for (const nodeId of this.intents.keys()) this.observe(nodeId, byNode.get(nodeId), board);
  }

  activate() {
    this.active = true;
  }

  current(intent: EntityPlacementIntent) {
    return this.active && intent.valid && this.intents.get(intent.nodeId) === intent;
  }

  preserves(nodeId: string) {
    const intent = this.intents.get(nodeId);
    return !!intent && this.current(intent);
  }

  wait(nodeId: string) {
    return this.pending.get(nodeId);
  }

  async dispatch(
    intent: EntityPlacementIntent,
    placement: BoardEntityObject,
    board: Board,
    send: (id: string) => Promise<unknown>
  ) {
    const id = generateId();
    this.requests.set(id, {
      nodeId: intent.nodeId,
      placement: snapshotBoardEntityPlacement(placement, board),
    });
    const pending = send(id);
    this.pending.set(intent.nodeId, pending);
    try {
      return await pending;
    } finally {
      if (this.pending.get(intent.nodeId) === pending) this.pending.delete(intent.nodeId);
    }
  }

  dispose() {
    this.active = false;
    for (const nodeId of this.intents.keys()) this.invalidate(nodeId);
    this.intents.clear();
    this.requests.clear();
  }
}
