import type {
  BoardRemovalRealtimeVisibilitySnapshot,
  BranchRemovalRealtimeVisibilitySnapshot,
} from '../types/realtime';
import { BranchRealtimeVisibilityMode } from '../types/realtime';
import type { TenantID } from '../types/tenant';

/**
 * Wire revision for the internal cross-replica Feathers publication relay.
 *
 * A revision change requires the documented all-at-once HA cohort replacement:
 * mixed revisions intentionally listen on different Socket.IO server events.
 */
export const REALTIME_RELAY_VERSION = 3 as const;
export const REALTIME_RELAY_EVENT = `agor:feathers-publication:v${REALTIME_RELAY_VERSION}` as const;
export const MAX_REALTIME_RELAY_BYTES = 512 * 1024;

/** Bounded JSON envelope sent over the existing HA realtime relay. */
export interface RealtimeRelayEnvelope {
  version: typeof REALTIME_RELAY_VERSION;
  tenantId: TenantID;
  path: string;
  event: string;
  method?: string;
  id?: string | number;
  data: unknown;
  /** Required for branch removals because their ACL rows have already been deleted. */
  branchRemovalVisibility?: BranchRemovalRealtimeVisibilitySnapshot;
  /** Required for board removals because board grants/references are gone. */
  boardRemovalVisibility?: BoardRemovalRealtimeVisibilitySnapshot;
}

export function isBoardRemovalRealtimeVisibilitySnapshot(
  value: unknown
): value is BoardRemovalRealtimeVisibilitySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.boardId !== 'string' ||
    snapshot.boardId.length === 0 ||
    snapshot.boardId.length > 256
  ) {
    return false;
  }
  if (snapshot.mode === BranchRealtimeVisibilityMode.ALL_AUTHENTICATED) {
    return snapshot.userIds === undefined;
  }
  return (
    snapshot.mode === BranchRealtimeVisibilityMode.EXPLICIT_USERS &&
    Array.isArray(snapshot.userIds) &&
    snapshot.userIds.every(
      (userId) => typeof userId === 'string' && userId.length > 0 && userId.length <= 256
    )
  );
}

export function isBranchRemovalRealtimeVisibilitySnapshot(
  value: unknown
): value is BranchRemovalRealtimeVisibilitySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.branchId !== 'string' ||
    snapshot.branchId.length === 0 ||
    snapshot.branchId.length > 256
  ) {
    return false;
  }
  if (snapshot.mode === BranchRealtimeVisibilityMode.ALL_AUTHENTICATED) {
    return snapshot.userIds === undefined;
  }
  return (
    snapshot.mode === BranchRealtimeVisibilityMode.EXPLICIT_USERS &&
    Array.isArray(snapshot.userIds) &&
    snapshot.userIds.every(
      (userId) => typeof userId === 'string' && userId.length > 0 && userId.length <= 256
    )
  );
}

function isBoundedJson(value: unknown): boolean {
  try {
    const encoded = JSON.stringify(value);
    return (
      encoded !== undefined &&
      new TextEncoder().encode(encoded).byteLength <= MAX_REALTIME_RELAY_BYTES
    );
  } catch {
    return false;
  }
}

/** Runtime codec for data received from the trusted-but-untyped Redis plane. */
export function isRealtimeRelayEnvelope(value: unknown): value is RealtimeRelayEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  const isBranchRemoval = envelope.path === 'branches' && envelope.event === 'removed';
  const removalVisibilityValid = isBranchRemoval
    ? isBranchRemovalRealtimeVisibilitySnapshot(envelope.branchRemovalVisibility)
    : envelope.branchRemovalVisibility === undefined;
  const isBoardRemoval = envelope.path === 'boards' && envelope.event === 'removed';
  const boardRemovalVisibilityValid = isBoardRemoval
    ? isBoardRemovalRealtimeVisibilitySnapshot(envelope.boardRemovalVisibility)
    : envelope.boardRemovalVisibility === undefined;

  return (
    envelope.version === REALTIME_RELAY_VERSION &&
    typeof envelope.tenantId === 'string' &&
    envelope.tenantId.length > 0 &&
    envelope.tenantId.length <= 128 &&
    typeof envelope.path === 'string' &&
    envelope.path.length > 0 &&
    envelope.path.length <= 128 &&
    typeof envelope.event === 'string' &&
    envelope.event.length > 0 &&
    envelope.event.length <= 128 &&
    (envelope.method === undefined ||
      (typeof envelope.method === 'string' && envelope.method.length <= 128)) &&
    (envelope.id === undefined ||
      (typeof envelope.id === 'string' && envelope.id.length <= 256) ||
      (typeof envelope.id === 'number' && Number.isFinite(envelope.id))) &&
    'data' in envelope &&
    isBoundedJson(envelope) &&
    removalVisibilityValid &&
    boardRemovalVisibilityValid
  );
}
