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

export async function admitTenantSocketPacket(input: {
  tenantId: string;
  executor: boolean;
  packet: unknown[];
  assertAccess: (tenantId: string) => Promise<void>;
}): Promise<void> {
  try {
    await input.assertAccess(input.tenantId);
  } catch (error) {
    if (input.executor && isTenantSafetyPacket(input.packet)) return;
    throw error;
  }
}

type PacketNext = (error?: Error) => void;

/** Packets one socket may hold behind pending admissions before the socket is disconnected. */
export const TENANT_SOCKET_PACKET_QUEUE_LIMIT = 1000;

/** Per-socket packet gate: only `needsAdmission` packets await a read, and every packet dispatches in arrival order. */
export function createOrderedTenantPacketGate(input: {
  needsAdmission: (packet: unknown[]) => boolean;
  admit: (packet: unknown[]) => Promise<void>;
  /** Wraps an admitted packet's read and dispatch so later checks in that call can share the read. */
  scope?: <T>(work: () => T) => T;
  /** A stuck read rejects its packet after this bound, so later packets never freeze behind it. */
  admissionTimeoutMs?: number;
  queueLimit?: number;
  /** Called once when the queue would exceed its limit; every queued and later packet is then rejected. */
  onOverflow?: () => void;
}): (packet: unknown[], next: PacketNext) => void {
  const timeoutMs = input.admissionTimeoutMs ?? TENANT_RESTRICTION_READ_TIMEOUT_MS;
  const limit = input.queueLimit ?? TENANT_SOCKET_PACKET_QUEUE_LIMIT;
  let tail: Promise<void> = Promise.resolve();
  let queued = 0;
  let overflowed = false;
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
  const bounded = (admission: Promise<void>): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
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
    const run = input.scope ?? ((work) => work());
    run(() => enqueue(packet, next, bounded(input.admit(packet))));
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

/** Consecutive unverifiable observations (about 10 s at the 1 s tick) before a tenant's sockets are retired. */
export const TENANT_SOCKET_UNVERIFIABLE_LIMIT = 10;

interface TenantSocketRestrictionMonitorOptions {
  timeoutMs?: number;
  now?: () => number;
  /** Retires a tenant's sockets once its state stayed unverifiable for `unverifiableLimit` observations. */
  retireUnverifiable?: (tenantId: string) => void;
  unverifiableLimit?: number;
}

/** Bound each observation without piling up reads; sockets retire on a positive observation or a persistent unverifiable streak. */
export class TenantSocketRestrictionMonitor {
  private readonly pending = new Map<string, { startedAt: number; read: Promise<void> }>();
  /** At most one abandoned read per tenant may still be running against the database. */
  private readonly abandoned = new Map<string, Promise<void>>();
  private readonly unverifiable = new Map<string, number>();
  private lastWarning?: { at: number; suppressed: number };
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly unverifiableLimit: number;
  constructor(
    private readonly observe: (tenantId: string) => Promise<void>,
    private readonly options: TenantSocketRestrictionMonitorOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? TENANT_RESTRICTION_READ_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.unverifiableLimit = options.unverifiableLimit ?? TENANT_SOCKET_UNVERIFIABLE_LIMIT;
  }

  async check(tenantIds: Iterable<string>): Promise<void> {
    const entries = [...new Set(tenantIds)];
    const present = new Set(entries);
    // Streaks of tenants with no sockets left are forgotten.
    for (const tenantId of this.unverifiable.keys()) {
      if (!present.has(tenantId)) this.unverifiable.delete(tenantId);
    }
    for (let offset = 0; offset < entries.length; offset += 8) {
      await Promise.all(
        entries.slice(offset, offset + 8).map(async (tenantId) => {
          const read = this.readFor(tenantId);
          if (!read) return this.skip(tenantId, 'saturated');
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timedOut = new Promise<MonitorSkip>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
          });
          // One unverifiable read retires nothing: every RPC still fails closed at admission.
          const skipped = await Promise.race([
            read.then(
              () => undefined,
              () => 'error' as const
            ),
            timedOut,
          ]);
          if (timer) clearTimeout(timer);
          if (skipped) this.skip(tenantId, skipped);
          else this.unverifiable.delete(tenantId);
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
    void read.then(clear, clear);
    return read;
  }

  private skip(tenantId: string, reason: MonitorSkip): void {
    const streak = (this.unverifiable.get(tenantId) ?? 0) + 1;
    if (streak >= this.unverifiableLimit && this.options.retireUnverifiable) {
      // A tenant nobody can verify must not keep driving raw terminal input indefinitely.
      this.unverifiable.delete(tenantId);
      this.options.retireUnverifiable(tenantId);
      console.warn(
        `[tenant.restriction] socket observation unverifiable; retired sockets streak=${streak}`
      );
    } else {
      this.unverifiable.set(tenantId, streak);
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
