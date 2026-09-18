import { Forbidden } from '@agor/core/feathers';
import {
  BRANCH_CLEANUP_REPORT_SERVICE,
  BRANCH_DELETION_REPORT_SERVICE,
  ENVIRONMENT_COMMAND_REPORT_SERVICE,
} from '@agor/core/types';

/** This only preserves transport to authenticated service safety guards, never authorizes an RPC. */
export function isTenantSafetyPacket(packet: unknown[]): boolean {
  const [method, path] = packet;
  if (path === 'tasks') {
    return [
      'getTerminationState',
      'reportTerminationComplete',
      'reportRuntimeTelemetry',
      'reportSdkHealthFailure',
    ].includes(String(method));
  }
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

/** Bound each observation without spawning duplicate reads if a DB call stalls. */
export class TenantSocketRestrictionMonitor {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(
    private readonly assertAccess: (tenantId: string) => Promise<void>,
    private readonly timeoutMs = 2000
  ) {}

  async check(tenants: Map<string, () => void>): Promise<void> {
    const entries = [...tenants];
    for (let offset = 0; offset < entries.length; offset += 8) {
      await Promise.all(
        entries.slice(offset, offset + 8).map(async ([tenantId, close]) => {
          let read = this.pending.get(tenantId);
          if (!read && this.pending.size >= 8) {
            close();
            return;
          }
          if (!read) {
            read = Promise.resolve().then(() => this.assertAccess(tenantId));
            this.pending.set(tenantId, read);
            const clear = () => {
              if (this.pending.get(tenantId) === read) this.pending.delete(tenantId);
            };
            void read.then(clear, clear);
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              read,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error('Tenant access observation timed out')),
                  this.timeoutMs
                );
              }),
            ]);
          } catch {
            close();
          } finally {
            if (timer) clearTimeout(timer);
          }
        })
      );
    }
  }
}
