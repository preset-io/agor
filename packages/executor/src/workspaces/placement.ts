import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CachePolicy = z
  .object({
    mode: z.enum(['observe', 'affinity', 'caches', 'workspaces']).default('observe'),
    highWatermark: z.number().min(0.1).max(0.99).default(0.8),
    lowWatermark: z.number().min(0.05).max(0.98).default(0.65),
    minimumFreeBytes: z
      .number()
      .nonnegative()
      .default(10 * 1024 ** 3),
    minimumFreeInodes: z.number().int().nonnegative().default(100000),
    idleMs: z.number().min(0).default(300000),
    heartbeatMs: z.number().min(1000).default(10000),
    affinityWaitMs: z.number().min(0).max(60000).default(15000),
  })
  .refine((p) => p.lowWatermark < p.highWatermark, 'Low watermark must be below high watermark');
export type CachePolicyConfig = z.infer<typeof CachePolicy>;
export interface Resident {
  branchId: string;
  repository: string;
  sessions: string[];
  revision: number | null;
  epoch?: number;
  stale?: boolean;
  approximateBytes?: number;
  lastUsed: number;
  resident: boolean;
  generation: string;
  pinned?: string;
  preparationMs: number;
}
export interface WorkerInventory {
  origin: string;
  incarnation: string;
  freeBytes: number;
  freeInodes: number;
  totalBytes: number;
  totalInodes: number;
  freeSlots: number;
  freeCpu: number;
  freeMemoryBytes: number;
  accepting: boolean;
  residents: Resident[];
}
export interface Candidate extends WorkerInventory {
  ageMs: number;
}
export function underPressure(w: WorkerInventory, p: CachePolicyConfig, low = false) {
  const threshold = low ? p.lowWatermark : p.highWatermark;
  return (
    w.freeBytes < p.minimumFreeBytes ||
    w.freeInodes < p.minimumFreeInodes ||
    (w.totalBytes > 0 && 1 - w.freeBytes / w.totalBytes >= threshold) ||
    (w.totalInodes > 0 && 1 - w.freeInodes / w.totalInodes >= threshold)
  );
}
/** Stable rendezvous ordering; authority ownership always overrides this hint. */
export function choosePlacement(input: {
  owner: string | null;
  workers: Candidate[];
  tenantId: string;
  branchId: string;
  repository: string;
  sessionId?: string;
  waitedMs: number;
  policy: CachePolicyConfig;
}): { origin?: string; reason: string; wait: boolean } {
  const { workers, policy: p } = input;
  const live = workers.filter((w) => w.ageMs >= 0 && w.ageMs < p.heartbeatMs * 3);
  const fits = (w: Candidate) =>
    w.accepting &&
    w.freeSlots > 0 &&
    w.freeCpu > 0 &&
    w.freeMemoryBytes > 0 &&
    w.freeBytes > p.minimumFreeBytes &&
    w.freeInodes > p.minimumFreeInodes;
  if (input.owner) {
    const owner = live.find((w) => w.origin === input.owner);
    return owner && fits(owner)
      ? { origin: owner.origin, reason: 'owner', wait: false }
      : { reason: 'owner_unavailable', wait: true };
  }
  const tier = (w: Candidate) => {
    const branch = w.residents.find((r) => r.branchId === input.branchId && r.resident);
    if (branch?.sessions.includes(input.sessionId ?? '')) return 3;
    if (branch) return 2;
    return w.residents.some((r) => r.repository === input.repository && r.resident) ? 1 : 0;
  };
  const score = (w: Candidate) =>
    createHash('sha256')
      .update(JSON.stringify([input.tenantId, input.repository, w.origin]))
      .digest('hex');
  const last = (w: Candidate) =>
    w.residents.find((r) => r.branchId === input.branchId && r.resident)?.lastUsed ?? 0;
  const ranked = [...live].sort(
    (a, b) => tier(b) - tier(a) || last(b) - last(a) || score(b).localeCompare(score(a))
  );
  const preferred = ranked[0];
  if (preferred && tier(preferred) > 0 && !fits(preferred) && input.waitedMs < p.affinityWaitMs)
    return { reason: 'warm_queue', wait: true };
  const selected = ranked.find(fits);
  return selected
    ? {
        origin: selected.origin,
        reason: ['cold', 'repository', 'branch', 'session'][tier(selected)],
        wait: false,
      }
    : { reason: 'capacity', wait: true };
}
export function evictionOrder(entries: Resident[], now: number, idleMs: number) {
  return entries
    .filter((r) => r.resident && !r.pinned && now - r.lastUsed >= idleMs)
    .sort(
      (a, b) =>
        Number(!!b.stale) - Number(!!a.stale) ||
        a.lastUsed - b.lastUsed ||
        (b.approximateBytes ?? 0) - (a.approximateBytes ?? 0) ||
        a.preparationMs - b.preparationMs ||
        a.branchId.localeCompare(b.branchId)
    );
}
