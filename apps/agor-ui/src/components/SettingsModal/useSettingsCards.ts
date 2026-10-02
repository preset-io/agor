import type { AgorClient, Board, BoardEntityObject, CardWithType } from '@agor-live/client';
import { PAGINATION } from '@agor-live/client';
import { useEffect, useRef, useState } from 'react';
import { useAgorStore } from '@/store/agorStore';

/** Trailing delay that coalesces a burst of reconcile requests (reconnects, reauth). */
export const RECONCILE_DEBOUNCE_MS = 300;
/** A sustained burst still reconciles within this bound. */
export const RECONCILE_MAX_WAIT_MS = 2000;

export interface SettingsCards {
  cards: CardWithType[];
  /** Card placements (board objects with a `card_id`); empty for viewers. */
  placements: BoardEntityObject[];
  /** Full records (with zones) of the boards the placements reference. */
  zoneBoards: Map<string, Board>;
}

type Listener = (row: never) => void;
interface EventSource {
  on?: (event: string, listener: Listener) => unknown;
  removeListener?: (event: string, listener: Listener) => unknown;
}

/** The user part of an authority scope (`user:role:generation`). */
const identityOf = (authority: string) => authority.split(':')[0];

/**
 * One table's dataset and its read coordinator. It outlives authority
 * changes, so reconnects and reauthentications share one single-flight,
 * debounced reconcile path.
 */
function createCardsCoordinator(
  client: AgorClient,
  canReadPlacements: boolean,
  output: { setData: (data: SettingsCards | null) => void; setError: (error: boolean) => void }
) {
  const cards = new Map<string, CardWithType>();
  const placements = new Map<string, BoardEntityObject>();
  const zoneBoards = new Map<string, Board>();
  // Per-board revision fence for zone reads: bumped by a full board event, so
  // a `boards.get` that started earlier never overwrites the newer record.
  const boardRevisions = new Map<string, number>();
  const boardReads = new Set<string>();
  // A lean board event landed during a read of that board: read it again.
  const staleBoardReads = new Set<string>();
  // Ids an event wrote while a read was in flight: they keep their live value.
  const touched = new Set<string>();
  let authority: string | null = null;
  let loaded = false;
  let inflight = false;
  let superseded = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstRequestAt = 0;

  const publish = () => {
    if (disposed || !loaded) return;
    output.setData({
      cards: [...cards.values()],
      placements: [...placements.values()],
      zoneBoards: new Map(zoneBoards),
    });
  };

  const ensureZoneBoard = (boardId: string, force = false) => {
    if (boardReads.has(boardId)) {
      if (force) staleBoardReads.add(boardId);
      return;
    }
    if (!force && zoneBoards.has(boardId)) return;
    boardReads.add(boardId);
    const revision = boardRevisions.get(boardId) ?? 0;
    void (client.service('boards').get(boardId) as Promise<Board>)
      .then((board) => {
        // A full board event during the read carried newer data.
        if (disposed || (boardRevisions.get(boardId) ?? 0) !== revision) return;
        zoneBoards.set(boardId, board);
        publish();
      })
      .catch(() => {
        // An unreadable board leaves its cards without a zone name.
      })
      .finally(() => {
        boardReads.delete(boardId);
        if (staleBoardReads.delete(boardId) && !disposed) ensureZoneBoard(boardId, true);
      });
  };

  /** Single-flight read; a read superseded in flight is discarded and read again. */
  const read = async (): Promise<void> => {
    if (!authority || disposed) return;
    if (inflight) {
      superseded = true;
      return;
    }
    inflight = true;
    superseded = false;
    // This read covers any reconcile still waiting in its debounce (it was
    // requested before now), so the trailing read consumes it.
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    touched.clear();
    const readAuthority = authority;
    // Every read after the first is a reconcile (reconnect, re-authentication):
    // cached zone boards may have missed events too, so they are read again.
    const reconcile = loaded;
    let rerun = false;
    try {
      const [cardRows, placementRows] = await Promise.all([
        client.service('cards').findAll({ query: { $limit: PAGINATION.DEFAULT_LIMIT } }) as Promise<
          CardWithType[]
        >,
        canReadPlacements
          ? (client.service('board-objects').findAll({
              query: { entity_type: 'card', $limit: PAGINATION.DEFAULT_LIMIT },
            }) as Promise<BoardEntityObject[]>)
          : Promise.resolve([] as BoardEntityObject[]),
      ]);
      if (disposed) return;
      // Superseded (another reconcile was requested) or read under an
      // authority that is gone: the snapshot may be stale. Feathers reads
      // can't be aborted, so the response is discarded instead.
      if (superseded || authority !== readAuthority) {
        rerun = superseded;
        return;
      }
      const snapshot = <T>(live: Map<string, T>, rows: T[], key: keyof T, prefix: string) => {
        const next = new Map(rows.map((row) => [row[key] as unknown as string, row]));
        for (const id of touched) {
          if (!id.startsWith(prefix)) continue;
          const liveId = id.slice(prefix.length);
          const row = live.get(liveId);
          if (row) next.set(liveId, row);
          else next.delete(liveId);
        }
        live.clear();
        for (const [id, row] of next) live.set(id, row);
      };
      snapshot(cards, cardRows, 'card_id', 'card:');
      snapshot(
        placements,
        placementRows.filter((row) => row.card_id),
        'object_id',
        'placement:'
      );
      loaded = true;
      output.setError(false);
      publish();
      const zoned = new Set<string>();
      for (const placement of placements.values()) {
        if (placement.zone_id) zoned.add(placement.board_id);
      }
      // Boards no placement pins into a zone any more are dropped.
      for (const boardId of zoneBoards.keys()) {
        if (!zoned.has(boardId)) zoneBoards.delete(boardId);
      }
      for (const boardId of zoned) ensureZoneBoard(boardId, reconcile);
    } catch (err) {
      if (disposed) return;
      console.warn('[settings] failed to load cards:', err);
      output.setError(true);
    } finally {
      inflight = false;
      if (rerun) void read();
    }
  };

  /** Debounced reconcile; a sustained burst still runs within the max wait. */
  const requestReconcile = () => {
    if (disposed) return;
    const now = Date.now();
    if (timer === null) firstRequestAt = now;
    else clearTimeout(timer);
    const delay = Math.max(
      0,
      Math.min(RECONCILE_DEBOUNCE_MS, firstRequestAt + RECONCILE_MAX_WAIT_MS - now)
    );
    timer = setTimeout(() => {
      timer = null;
      void read();
    }, delay);
  };

  const setAuthority = (next: string | null) => {
    const previous = authority;
    authority = next;
    if (!next || next === previous) return; // reads wait for a valid authority
    if (!loaded || (previous && identityOf(previous) !== identityOf(next))) {
      if (loaded) {
        // Another user's rows are never shown, even briefly.
        loaded = false;
        cards.clear();
        placements.clear();
        zoneBoards.clear();
        output.setData(null);
      }
      void read(); // marks an in-flight read superseded, if any
      return;
    }
    requestReconcile(); // same user, re-authenticated: coalesced
  };

  const onCard = (card: CardWithType) => {
    if (inflight) touched.add(`card:${card.card_id}`);
    cards.set(card.card_id, card);
    publish();
  };
  const onCardRemoved = (card: CardWithType) => {
    if (inflight) touched.add(`card:${card.card_id}`);
    if (cards.delete(card.card_id)) publish();
  };
  const onPlacement = (placement: BoardEntityObject) => {
    if (!placement.card_id) return; // branch placements are not this table's
    if (inflight) touched.add(`placement:${placement.object_id}`);
    placements.set(placement.object_id, placement);
    if (placement.zone_id) ensureZoneBoard(placement.board_id);
    publish();
  };
  const onPlacementRemoved = (placement: BoardEntityObject) => {
    if (!placement.card_id) return;
    if (inflight) touched.add(`placement:${placement.object_id}`);
    if (placements.delete(placement.object_id)) publish();
  };
  const onBoard = (board: Board) => {
    const boardId = board.board_id;
    const relevant =
      zoneBoards.has(boardId) ||
      boardReads.has(boardId) ||
      [...placements.values()].some((p) => p.board_id === boardId && p.zone_id);
    if (!relevant) return;
    if (board.objects) {
      boardRevisions.set(boardId, (boardRevisions.get(boardId) ?? 0) + 1);
      zoneBoards.set(boardId, board);
      publish();
    } else {
      ensureZoneBoard(boardId, true); // a lean event: read the zones
    }
  };

  const subscriptions: Array<[EventSource, string, Listener]> = [
    [client.service('cards') as unknown as EventSource, 'created', onCard as Listener],
    [client.service('cards') as unknown as EventSource, 'patched', onCard as Listener],
    [client.service('cards') as unknown as EventSource, 'updated', onCard as Listener],
    [client.service('cards') as unknown as EventSource, 'removed', onCardRemoved as Listener],
    [client.service('boards') as unknown as EventSource, 'patched', onBoard as Listener],
    [client.service('boards') as unknown as EventSource, 'updated', onBoard as Listener],
    [client.io as unknown as EventSource, 'connect', requestReconcile as Listener],
  ];
  if (canReadPlacements) {
    const objects = client.service('board-objects') as unknown as EventSource;
    subscriptions.push(
      [objects, 'created', onPlacement as Listener],
      [objects, 'patched', onPlacement as Listener],
      [objects, 'updated', onPlacement as Listener],
      [objects, 'removed', onPlacementRemoved as Listener]
    );
  }
  for (const [source, event, listener] of subscriptions) source.on?.(event, listener);

  return {
    setAuthority,
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const [source, event, listener] of subscriptions) {
        source.removeListener?.(event, listener);
      }
    },
  };
}

/**
 * Every card the caller can see, for the settings Cards table. The store only
 * holds the cards of loaded boards, so the table reads its own dataset when it
 * opens: all cards, the card placements, and a `boards.get` for each board
 * whose zones a placement references (the boards list is lean).
 *
 * After that the dataset is patched from realtime events: card events, card
 * placement events (branch placements are ignored) and board record events
 * (zone labels, fenced per board against older `boards.get` responses). It is
 * reconciled in full only after a socket reconnect or a re-authentication,
 * zone boards included; both go through one coordinator: debounced with a
 * bounded wait, at most one read in flight, a read superseded in flight is
 * discarded and read again, and a read that starts consumes a reconcile still
 * waiting in its debounce. A different user starts over with an empty dataset.
 */
export function useSettingsCards(
  client: AgorClient | null,
  options: { canReadPlacements: boolean }
): { data: SettingsCards | null; error: boolean } {
  const { canReadPlacements } = options;
  const [data, setData] = useState<SettingsCards | null>(null);
  const [error, setError] = useState(false);
  const authority = useAgorStore((s) => s.dataAuthority);
  const authorityRef = useRef(authority);
  authorityRef.current = authority;
  const coordinatorRef = useRef<ReturnType<typeof createCardsCoordinator> | null>(null);

  useEffect(() => {
    if (!client) return;
    const coordinator = createCardsCoordinator(client, canReadPlacements, { setData, setError });
    coordinatorRef.current = coordinator;
    coordinator.setAuthority(authorityRef.current);
    return () => {
      coordinator.dispose();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null;
    };
  }, [client, canReadPlacements]);

  useEffect(() => {
    coordinatorRef.current?.setAuthority(authority);
  }, [authority]);

  return { data, error };
}
