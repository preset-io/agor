import { ceilBoardGridValue, snapBoardGridValue } from '@agor/core/layout/rectangle-packing';
import { normalizeZoneLayoutPolicy } from '@agor/core/layout/zone-layout';
import type { ZoneLayoutPolicy } from '@agor-live/client';

export interface AutoZoneObserverChild {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Sort-relevant, durable entity metadata in a caller-owned fixed order. */
  sortData: readonly unknown[];
}

export interface AutoZoneObserverInput {
  zoneId: string;
  width: number;
  height: number;
  layout?: ZoneLayoutPolicy;
  children: readonly AutoZoneObserverChild[];
}

/**
 * Canonical material signature for one Auto Zone observer.
 *
 * A board render may rebuild React Flow nodes in a different array order after
 * any realtime event. Sorting by stable ids prevents that presentation detail
 * from looking like a layout input change. Geometry uses the same board-grid
 * normalization as the planner, so measured/fallback and subpixel variants
 * that produce the same durable rectangle cannot alternate the observer.
 */
export function autoZoneObserverSignature(input: AutoZoneObserverInput): string {
  const policy = normalizeZoneLayoutPolicy(input.layout);
  const children = [...input.children]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((child) => [
      child.id,
      snapBoardGridValue(child.x),
      snapBoardGridValue(child.y),
      ceilBoardGridValue(child.width),
      ceilBoardGridValue(child.height),
      ...child.sortData,
    ]);

  return JSON.stringify([
    input.zoneId,
    snapBoardGridValue(input.width),
    snapBoardGridValue(input.height),
    [
      policy.mode,
      policy.preset,
      policy.density,
      policy.sortBy,
      policy.sortDirection,
      policy.columns ?? null,
      policy.gap ?? null,
      policy.autoResizeHeight,
      policy.resize,
      policy.onOverflow,
    ],
    children,
  ]);
}

/** Return only zones whose own normalized inputs changed, while pruning removals. */
export function changedAutoZoneObserverIds(
  inputs: readonly AutoZoneObserverInput[],
  previous: ReadonlyMap<string, string>
): { signatures: Map<string, string>; changedIds: Set<string> } {
  const signatures = new Map<string, string>();
  const changedIds = new Set<string>();
  for (const input of [...inputs].sort((left, right) =>
    left.zoneId < right.zoneId ? -1 : left.zoneId > right.zoneId ? 1 : 0
  )) {
    const signature = autoZoneObserverSignature(input);
    signatures.set(input.zoneId, signature);
    if (previous.get(input.zoneId) !== signature) changedIds.add(input.zoneId);
  }
  return { signatures, changedIds };
}

export interface AutoZoneObserverLockManager {
  request(
    name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    callback: () => Promise<void>
  ): Promise<void>;
}

/**
 * Hold one browser-origin lease for background Auto Zone writes on a board.
 * Explicit user layout actions do not use this lease. The Web Locks queue
 * hands ownership to another open tab when the owner unloads, which prevents
 * observing tabs from racing the same realtime snapshot.
 */
export async function holdAutoZoneObserverLease(
  locks: AutoZoneObserverLockManager,
  boardId: string,
  signal: AbortSignal,
  onOwnershipChange: (owned: boolean) => void
): Promise<void> {
  try {
    await locks.request(
      `agor:auto-zone-observer:${boardId}`,
      { mode: 'exclusive', signal },
      async () => {
        if (signal.aborted) return;
        onOwnershipChange(true);
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        onOwnershipChange(false);
      }
    );
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}
