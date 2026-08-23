import type { TenantContext } from '@agor/core/types';
import type { ExecutorSessionTokenRevocation } from '../services/session-token-service.js';

const CANDIDATE = Symbol('agor.executor-connection-capability-candidate');
const TOMBSTONE_TTL_MS = 5 * 60 * 1000;
const MAX_TOMBSTONES = 4_096;

export interface ExecutorRevocationSnapshot {
  tenantId?: string;
  tenantGeneration: number;
  unscopedGeneration: number;
  allGeneration: number;
}

export interface ExecutorConnectionCapabilityCandidate {
  tenantId?: string;
  sessionId: string;
  taskId?: string;
  branchId?: string;
  expiresAt: number;
  tokenFingerprint: string;
  revocationSnapshot: ExecutorRevocationSnapshot;
}

export interface ExecutorConnectionCapability {
  readonly tenant: TenantContext;
  readonly sessionId: string;
  readonly taskId?: string;
  readonly branchId?: string;
  readonly expiresAt: number;
  readonly tokenFingerprint: string;
}

type CandidateCarrier = { [CANDIDATE]?: ExecutorConnectionCapabilityCandidate };

function tombstoneKey(tenantId: string | undefined, value: string): string {
  return `${tenantId ?? '*'}\0${value}`;
}

/**
 * Process-local half of the distributed executor-token revocation fence.
 *
 * The authority database decides whether a bearer is valid. This fence closes
 * the interval between an asynchronous authority read and the final synchronous
 * authenticated-connection commit: a revocation observed during that interval
 * changes the generation, so the stale authentication result cannot install a
 * room capability. Bounded tombstones also make the exact/session decision
 * explicit without retaining raw bearer material.
 */
export class ExecutorConnectionRevocationFence {
  private allGeneration = 0;
  private unscopedGeneration = 0;
  private readonly tenantGenerations = new Map<string, number>();
  private readonly tokenTombstones = new Map<string, number>();
  private readonly sessionTombstones = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  snapshot(tenantId?: string): ExecutorRevocationSnapshot {
    this.prune();
    return {
      ...(tenantId ? { tenantId } : {}),
      tenantGeneration: tenantId ? (this.tenantGenerations.get(tenantId) ?? 0) : 0,
      unscopedGeneration: this.unscopedGeneration,
      allGeneration: this.allGeneration,
    };
  }

  record(revocation: ExecutorSessionTokenRevocation): void {
    const tenantId = revocation.tenantId;
    this.allGeneration += 1;
    if (tenantId) {
      this.tenantGenerations.set(tenantId, (this.tenantGenerations.get(tenantId) ?? 0) + 1);
    } else {
      this.unscopedGeneration += 1;
    }

    const expiresAt = this.now() + TOMBSTONE_TTL_MS;
    if (revocation.tokenFingerprint) {
      this.setBounded(
        this.tokenTombstones,
        tombstoneKey(tenantId, revocation.tokenFingerprint),
        expiresAt
      );
    } else if (revocation.sessionId) {
      this.setBounded(
        this.sessionTombstones,
        tombstoneKey(tenantId, revocation.sessionId),
        expiresAt
      );
    }
    this.prune();
  }

  permits(candidate: ExecutorConnectionCapabilityCandidate, tenant: TenantContext): boolean {
    this.prune();
    if (candidate.tenantId && candidate.tenantId !== tenant.tenant_id) return false;

    const snapshot = candidate.revocationSnapshot;
    if (snapshot.unscopedGeneration !== this.unscopedGeneration) return false;
    if (snapshot.tenantId) {
      if (snapshot.tenantId !== tenant.tenant_id) return false;
      if (snapshot.tenantGeneration !== (this.tenantGenerations.get(tenant.tenant_id) ?? 0)) {
        return false;
      }
    } else if (snapshot.allGeneration !== this.allGeneration) {
      // Legacy/static candidates without a tenant claim fail closed across any
      // concurrent revocation rather than guessing which tenant generation to
      // compare.
      return false;
    }

    return (
      !this.hasTombstone(this.tokenTombstones, tenant.tenant_id, candidate.tokenFingerprint) &&
      !this.hasTombstone(this.sessionTombstones, tenant.tenant_id, candidate.sessionId)
    );
  }

  private hasTombstone(store: Map<string, number>, tenantId: string, value: string): boolean {
    return store.has(tombstoneKey(tenantId, value)) || store.has(tombstoneKey(undefined, value));
  }

  private setBounded(store: Map<string, number>, key: string, expiresAt: number): void {
    store.delete(key);
    store.set(key, expiresAt);
    while (store.size > MAX_TOMBSTONES) {
      const oldest = store.keys().next().value;
      if (typeof oldest !== 'string') break;
      store.delete(oldest);
    }
  }

  private prune(): void {
    const now = this.now();
    for (const store of [this.tokenTombstones, this.sessionTombstones]) {
      for (const [key, expiresAt] of store) {
        if (expiresAt <= now) store.delete(key);
      }
    }
  }
}

const fencesByApp = new WeakMap<object, ExecutorConnectionRevocationFence>();

export function getOrCreateExecutorConnectionRevocationFence(
  app: object
): ExecutorConnectionRevocationFence {
  let fence = fencesByApp.get(app);
  if (!fence) {
    fence = new ExecutorConnectionRevocationFence();
    fencesByApp.set(app, fence);
  }
  return fence;
}

export function attachExecutorConnectionCapabilityCandidate(
  authResult: object,
  candidate: ExecutorConnectionCapabilityCandidate
): void {
  Object.defineProperty(authResult, CANDIDATE, {
    configurable: true,
    enumerable: false,
    value: candidate,
  });
}

export function getExecutorConnectionCapabilityCandidate(
  authResult: unknown
): ExecutorConnectionCapabilityCandidate | undefined {
  return authResult && typeof authResult === 'object'
    ? (authResult as CandidateCarrier)[CANDIDATE]
    : undefined;
}

export function commitExecutorConnectionCapability(
  candidate: ExecutorConnectionCapabilityCandidate,
  tenant: TenantContext,
  fence: ExecutorConnectionRevocationFence
): ExecutorConnectionCapability | undefined {
  if (!fence.permits(candidate, tenant)) return undefined;
  const capability: ExecutorConnectionCapability = Object.freeze({
    tenant,
    sessionId: candidate.sessionId,
    ...(candidate.taskId ? { taskId: candidate.taskId } : {}),
    ...(candidate.branchId ? { branchId: candidate.branchId } : {}),
    expiresAt: candidate.expiresAt,
    tokenFingerprint: candidate.tokenFingerprint,
  });
  return capability;
}
