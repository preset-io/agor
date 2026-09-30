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

/** Per-socket packet gate: only `needsAdmission` packets await a read, and every packet dispatches in arrival order. */
export function createOrderedTenantPacketGate(input: {
  needsAdmission: (packet: unknown[]) => boolean;
  admit: (packet: unknown[]) => Promise<void>;
  /** Wraps an admitted packet's read and dispatch so later checks in that call can share the read. */
  scope?: <T>(work: () => T) => T;
}): (packet: unknown[], next: PacketNext) => void {
  let tail: Promise<void> = Promise.resolve();
  let queued = 0;
  const enqueue = (packet: unknown[], next: PacketNext, admitted: Promise<boolean>) => {
    queued++;
    // Registered in the caller's async context, so dispatch keeps the packet's shared read scope.
    tail = tail
      .then(() => admitted)
      .then((ok) => {
        queued--;
        if (ok) next();
        else rejectTenantSocketPacket(packet, next);
      })
      .catch(() => undefined);
  };
  return (packet, next) => {
    if (!input.needsAdmission(packet)) {
      // Raw realtime traffic never reads; it only waits behind an earlier admitted packet.
      if (queued === 0) next();
      else enqueue(packet, next, Promise.resolve(true));
      return;
    }
    const run = input.scope ?? ((work) => work());
    run(() =>
      enqueue(
        packet,
        next,
        input.admit(packet).then(
          () => true,
          () => false
        )
      )
    );
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

/** Bound each observation without duplicate reads; only `observe` itself retires sockets, on a positive observation. */
export class TenantSocketRestrictionMonitor {
  private readonly pending = new Map<string, Promise<void>>();
  private lastWarning?: { at: number; suppressed: number };
  constructor(
    private readonly observe: (tenantId: string) => Promise<void>,
    private readonly timeoutMs = TENANT_RESTRICTION_READ_TIMEOUT_MS,
    private readonly now = Date.now
  ) {}

  async check(tenantIds: Iterable<string>): Promise<void> {
    const entries = [...tenantIds];
    for (let offset = 0; offset < entries.length; offset += 8) {
      await Promise.all(
        entries.slice(offset, offset + 8).map(async (tenantId) => {
          let read = this.pending.get(tenantId);
          if (!read && this.pending.size >= 8) return this.skip('saturated');
          if (!read) {
            read = Promise.resolve().then(() => this.observe(tenantId));
            this.pending.set(tenantId, read);
            const clear = () => {
              if (this.pending.get(tenantId) === read) this.pending.delete(tenantId);
            };
            void read.then(clear, clear);
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timedOut = new Promise<MonitorSkip>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
          });
          // An unverifiable read retires nothing: every RPC still fails closed at admission.
          const skipped = await Promise.race([
            read.then(
              () => undefined,
              () => 'error' as const
            ),
            timedOut,
          ]);
          if (timer) clearTimeout(timer);
          if (skipped) this.skip(skipped);
        })
      );
    }
  }

  private skip(reason: MonitorSkip): void {
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
