import type {
  BoardLayoutApplyResult,
  BoardLayoutBatch,
  BoardLayoutObjectUpdate,
} from '@agor/core/types';

/**
 * Auto-layout signatures include positions so a user's manual move can reflow
 * an automatic zone. Consume the next position signature produced by the
 * arranger itself, otherwise that output schedules a redundant second pass.
 */
export function zonesNeedingAutoArrange<T extends readonly [string, unknown]>(
  zones: readonly T[],
  skipOnce: Set<string>
): T[] {
  return zones.filter(([zoneId]) => {
    if (!skipOnce.has(zoneId)) return true;
    skipOnce.delete(zoneId);
    return false;
  });
}

export interface ExpectedAutoLayoutSignature {
  signature: string;
  acknowledged: boolean;
}

/**
 * An explicit atomic layout can still rebuild board and placement selectors in
 * separate React renders. Suppress every intermediate observer signature; the
 * authoritative target settles the guard only after the service acknowledges
 * the write. An acknowledged intermediate signature stays suppressed instead
 * of firing the same mutation again. The guard remains until the exact target
 * is observed or the board lifecycle clears it, so transient reconstruction
 * can never reissue the acknowledged mutation.
 */
export function expectedAutoLayoutState(
  currentSignature: string | undefined,
  expected: ExpectedAutoLayoutSignature | undefined
): { suppress: boolean; settled: boolean; needsFallback: boolean } {
  if (!expected) return { suppress: false, settled: false, needsFallback: false };
  const settled = expected.acknowledged && currentSignature === expected.signature;
  return {
    suppress: true,
    settled,
    needsFallback: false,
  };
}

function sameObjectGeometry(
  durable: { x: number; y: number; width?: number; height?: number } | undefined,
  expected: BoardLayoutObjectUpdate
): boolean {
  if (!durable || durable.x !== expected.x || durable.y !== expected.y) return false;
  if (expected.width !== undefined && durable.width !== expected.width) return false;
  if (expected.height !== undefined && durable.height !== expected.height) return false;
  return true;
}

/**
 * Verify that the applyLayout acknowledgement contains every submitted piece
 * of committed geometry. This makes the response, rather than a transient
 * React Flow reconstruction, the authority for acknowledging an Auto Zone
 * write.
 */
export function layoutResultCoversBatch(
  result: BoardLayoutApplyResult | undefined,
  batch: BoardLayoutBatch
): boolean {
  if (!result?.board?.objects || !Array.isArray(result.placements)) return false;
  for (const [objectId, expected] of Object.entries(batch.objects)) {
    if (!sameObjectGeometry(result.board.objects?.[objectId], expected)) return false;
  }
  const placementById = new Map(
    result.placements.map((placement) => [placement.object_id, placement] as const)
  );
  for (const [objectId, expected] of Object.entries(batch.placements)) {
    const durable = placementById.get(objectId);
    if (
      !durable ||
      durable.position.x !== expected.position.x ||
      durable.position.y !== expected.position.y ||
      durable.size?.width !== expected.size.width ||
      durable.size?.height !== expected.size.height ||
      (expected.compact !== undefined && durable.compact !== expected.compact)
    )
      return false;
  }
  return true;
}
