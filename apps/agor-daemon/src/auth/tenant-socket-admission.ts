import { Forbidden } from '@agor/core/feathers';
import {
  BRANCH_CLEANUP_REPORT_SERVICE,
  BRANCH_DELETION_REPORT_SERVICE,
  ENVIRONMENT_COMMAND_REPORT_SERVICE,
  TENANT_RESTRICTED_ERROR_CODE,
} from '@agor/core/types';
import {
  isTenantRestrictedRejection,
  TENANT_RESTRICTION_READ_TIMEOUT_MS,
} from './tenant-access.js';
import { TENANT_SAFETY_TASK_METHODS } from './tenant-safety-settlement.js';

/** This only preserves transport to authenticated service safety guards, never authorizes an RPC. */
function isTenantSafetyPacket(packet: unknown[]): boolean {
  const [method, path] = packet;
  if (path === 'tasks') return TENANT_SAFETY_TASK_METHODS.includes(String(method));
  return (
    method === 'create' &&
    [
      ENVIRONMENT_COMMAND_REPORT_SERVICE,
      BRANCH_CLEANUP_REPORT_SERVICE,
      BRANCH_DELETION_REPORT_SERVICE,
    ].includes(path as never)
  );
}

/** Executor packets except safety RPCs, service calls, and every packet of an unverified tenant await a read. */
export function tenantSocketPacketNeedsAdmission(input: {
  executor: boolean;
  serviceCall: boolean;
  unverified: boolean;
  packet: unknown[];
}): boolean {
  // Safety RPCs are admitted whatever a read says, so they only keep their place in the queue.
  if (input.executor) return !isTenantSafetyPacket(input.packet);
  return input.serviceCall || input.unverified;
}

export async function admitTenantSocketPacket(input: {
  tenantId: string;
  executor: boolean;
  packet: unknown[];
  assertAccess: (tenantId: string) => Promise<void>;
}): Promise<void> {
  if (input.executor && isTenantSafetyPacket(input.packet)) return;
  await input.assertAccess(input.tenantId);
}

type PacketNext = (error?: Error) => void;

/** Packets one socket may hold behind pending admissions before the socket is disconnected. */
export const TENANT_SOCKET_PACKET_QUEUE_LIMIT = 1000;

/** Timed-out admission reads one socket may leave running before it starts no more. */
export const TENANT_SOCKET_STALE_READ_LIMIT = 4;

/** Per-socket packet gate: only `needsAdmission` packets await a read, and every packet dispatches in arrival order. */
export function createOrderedTenantPacketGate(input: {
  needsAdmission: (packet: unknown[]) => boolean;
  admit: (packet: unknown[]) => Promise<void>;
  /** Packets that may join this socket's read already in flight for another such packet, never a settled one. */
  coalesce?: (packet: unknown[]) => boolean;
  /** Wraps an admitted packet's read and dispatch so later checks in that call can share the read. */
  scope?: <T>(work: () => T) => T;
  /** A stuck read rejects its packet after this bound, so later packets never freeze behind it. */
  admissionTimeoutMs?: number;
  queueLimit?: number;
  staleReadLimit?: number;
  /** Called once when the queue would exceed its limit; every queued and later packet is then rejected. */
  onOverflow?: () => void;
}): (packet: unknown[], next: PacketNext) => void {
  const timeoutMs = input.admissionTimeoutMs ?? TENANT_RESTRICTION_READ_TIMEOUT_MS;
  const limit = input.queueLimit ?? TENANT_SOCKET_PACKET_QUEUE_LIMIT;
  const staleLimit = input.staleReadLimit ?? TENANT_SOCKET_STALE_READ_LIMIT;
  let tail: Promise<void> = Promise.resolve();
  let queued = 0;
  let overflowed = false;
  const running = new Set<Promise<void>>();
  // Reads that outlived the bound still hold a database connection until they settle.
  const stale = new Set<Promise<void>>();
  let shared: Promise<void> | undefined;
  const enqueue = (packet: unknown[], next: PacketNext, admitted: Promise<boolean>) => {
    queued++;
    // Registered in the caller's async context, so dispatch keeps the packet's shared read scope.
    tail = tail
      .then(() => admitted)
      .then((ok) => {
        queued--;
        if (ok && !overflowed) next();
        else rejectTenantSocketPacket(packet, next);
      })
      .catch(() => undefined);
  };
  const start = (packet: unknown[]): Promise<void> => {
    const admission = input.admit(packet);
    running.add(admission);
    const settle = () => {
      running.delete(admission);
      stale.delete(admission);
      if (shared === admission) shared = undefined;
    };
    admission.then(settle, settle);
    return admission;
  };
  const bounded = (admission: Promise<void>): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        if (running.has(admission)) stale.add(admission);
        resolve(false);
      }, timeoutMs);
    });
    return Promise.race([
      admission.then(
        () => true,
        () => false
      ),
      timedOut,
    ]).finally(() => clearTimeout(timer));
  };
  return (packet, next) => {
    if (overflowed) return rejectTenantSocketPacket(packet, next);
    if (queued >= limit) {
      // A backlog this deep means admission is not keeping up; drop the connection rather than packets.
      overflowed = true;
      rejectTenantSocketPacket(packet, next);
      input.onOverflow?.();
      return;
    }
    if (!input.needsAdmission(packet)) {
      // Raw realtime traffic never reads; it only waits behind an earlier admitted packet.
      if (queued === 0) next();
      else enqueue(packet, next, Promise.resolve(true));
      return;
    }
    const joins = input.coalesce?.(packet) === true;
    if (joins && shared) return enqueue(packet, next, bounded(shared));
    if (stale.size >= staleLimit) {
      // The database is not answering this socket: refuse fast rather than start another read.
      if (queued === 0) rejectTenantSocketPacket(packet, next);
      else enqueue(packet, next, Promise.resolve(false));
      return;
    }
    const run = input.scope ?? ((work) => work());
    run(() => {
      const admission = start(packet);
      if (joins) shared = admission;
      enqueue(packet, next, bounded(admission));
    });
  };
}

/** Reject without dispatching; Socket.IO next(error) alone never settles an RPC ack. */
export function rejectTenantSocketPacket(packet: unknown[], next: (error: Error) => void): void {
  // Never serialize a database/observation error or private restriction metadata.
  const error = new Forbidden('Tenant access cannot be verified');
  const acknowledge = packet[packet.length - 1];
  if (typeof acknowledge === 'function') acknowledge(error.toJSON());
  else next(error);
}

export function missingSocketTenant(): Error {
  return new Forbidden('Tenant access cannot be verified');
}

/** Handshake rejection carrying the stable code in `data`, only for the restriction denial itself. */
export function restrictedSocketHandshakeError(
  error: unknown
): (Error & { data: { code: string } }) | null {
  if (!isTenantRestrictedRejection(error)) return null;
  const rejection = new Error('Tenant access is restricted') as Error & {
    data: { code: string };
  };
  rejection.data = { code: TENANT_RESTRICTED_ERROR_CODE };
  return rejection;
}

type MonitorSkip = 'timeout' | 'error' | 'saturated';

/** Consecutive failed or timed-out observations (about 10 s at the 1 s tick) before a tenant is marked unverified. */
export const TENANT_SOCKET_UNVERIFIABLE_LIMIT = 10;

interface TenantSocketRestrictionMonitorOptions {
  timeoutMs?: number;
  now?: () => number;
  unverifiableLimit?: number;
}

/** Bound each observation without piling up reads; sockets retire only on a positive observation, and an unreadable tenant is marked unverified. */
export class TenantSocketRestrictionMonitor {
  private readonly pending = new Map<string, { startedAt: number; read: Promise<void> }>();
  /** At most one abandoned read per tenant may still be running against the database. */
  private readonly abandoned = new Map<string, Promise<void>>();
  private readonly unverifiable = new Map<string, number>();
  private readonly unverified = new Set<string>();
  /** Sweep in which each tenant last got a read, so saturated tenants go first next sweep. */
  private readonly lastRead = new Map<string, number>();
  private sweep = 0;
  private lastWarning?: { at: number; suppressed: number };
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly unverifiableLimit: number;
  constructor(
    private readonly observe: (tenantId: string) => Promise<void>,
    options: TenantSocketRestrictionMonitorOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? TENANT_RESTRICTION_READ_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.unverifiableLimit = options.unverifiableLimit ?? TENANT_SOCKET_UNVERIFIABLE_LIMIT;
  }

  /** While marked, every packet of this tenant's sockets passes the per-packet admission read. */
  isUnverified(tenantId: string): boolean {
    return this.unverified.has(tenantId);
  }

  async check(tenantIds: Iterable<string>): Promise<void> {
    const sweep = ++this.sweep;
    const present = new Set(tenantIds);
    // State of tenants with no sockets left is forgotten.
    for (const state of [this.unverifiable, this.lastRead]) {
      for (const tenantId of state.keys()) if (!present.has(tenantId)) state.delete(tenantId);
    }
    for (const tenantId of this.unverified)
      if (!present.has(tenantId)) this.unverified.delete(tenantId);
    // Least recently read first (stable), so the eight-read bound cannot starve a tenant.
    const entries = [...present].sort(
      (a, b) => (this.lastRead.get(a) ?? 0) - (this.lastRead.get(b) ?? 0)
    );
    for (let offset = 0; offset < entries.length; offset += 8) {
      await Promise.all(
        entries.slice(offset, offset + 8).map(async (tenantId) => {
          const read = this.readFor(tenantId);
          if (!read) return this.skip(tenantId, 'saturated');
          this.lastRead.set(tenantId, sweep);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timedOut = new Promise<MonitorSkip>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
          });
          const skipped = await Promise.race([
            read.then(
              () => undefined,
              () => 'error' as const
            ),
            timedOut,
          ]);
          if (timer) clearTimeout(timer);
          if (skipped) this.skip(tenantId, skipped);
        })
      );
    }
  }

  /** Shared in-flight read; a read pending past two timeouts is abandoned once, never stacked. */
  private readFor(tenantId: string): Promise<void> | undefined {
    const at = this.now();
    const current = this.pending.get(tenantId);
    if (current) {
      const wedged = at - current.startedAt >= 2 * this.timeoutMs;
      if (!wedged || this.abandoned.has(tenantId)) return current.read;
      this.pending.delete(tenantId);
      this.abandoned.set(tenantId, current.read);
      const forget = () => {
        if (this.abandoned.get(tenantId) === current.read) this.abandoned.delete(tenantId);
      };
      void current.read.then(forget, forget);
    }
    // Abandoned reads still hold a connection, so they count toward the eight-read bound.
    if (this.pending.size + this.abandoned.size >= 8) return undefined;
    const read = Promise.resolve().then(() => this.observe(tenantId));
    const entry = { startedAt: at, read };
    this.pending.set(tenantId, entry);
    const clear = () => {
      if (this.pending.get(tenantId) === entry) this.pending.delete(tenantId);
    };
    // Any successful read, even one that outlived its timeout, verifies the tenant again.
    void read.then(() => {
      clear();
      this.unverifiable.delete(tenantId);
      this.unverified.delete(tenantId);
    }, clear);
    return read;
  }

  private skip(tenantId: string, reason: MonitorSkip): void {
    // Saturation says nothing about this tenant's database state.
    if (reason !== 'saturated') {
      const streak = (this.unverifiable.get(tenantId) ?? 0) + 1;
      this.unverifiable.set(tenantId, streak);
      if (streak >= this.unverifiableLimit && !this.unverified.has(tenantId)) {
        this.unverified.add(tenantId);
        console.warn(
          `[tenant.restriction] socket observation unverifiable; gating raw packets streak=${streak}`
        );
      }
    }
    const at = this.now();
    // One line per minute across every reason; the count carries what was suppressed.
    const last = this.lastWarning;
    if (last && at >= last.at && at - last.at < 60_000) {
      last.suppressed++;
      return;
    }
    console.warn(
      `[tenant.restriction] socket observation skipped reason=${reason} suppressed=${last?.suppressed ?? 0}`
    );
    this.lastWarning = { at, suppressed: 0 };
  }
}
