/** EXPLORATORY POC: tenant-scoped channel filtering helpers. Not production-wired. */

import type { Application } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';
import { tenantFromParams, type TenantID } from './tenant-context.js';

type ConnectionWithTenant = {
  tenant?: { tenantId?: TenantID };
  user?: { _isServiceAccount?: boolean; role?: string };
  authentication?: { user?: { _isServiceAccount?: boolean; role?: string } };
};

type Channel = ReturnType<Application['channel']>;

function connectionTenantId(connection: unknown): TenantID | undefined {
  return (connection as ConnectionWithTenant | undefined)?.tenant?.tenantId;
}

function isServiceConnection(connection: unknown): boolean {
  const c = connection as ConnectionWithTenant | undefined;
  const user = c?.user ?? c?.authentication?.user;
  return user?._isServiceAccount === true || user?.role === 'service';
}

/**
 * Fail-closed tenant filter. If the event lacks tenant context, only service
 * connections receive it so bugs do not broadcast across tenants by default.
 */
export function filterChannelToTenant(channel: Channel, tenantId: TenantID | undefined): Channel {
  return channel.filter((connection: unknown) => {
    if (isServiceConnection(connection)) return true;
    return !!tenantId && connectionTenantId(connection) === tenantId;
  });
}

export function configureTenantPublishPoc(app: Application): void {
  app.publish((data: unknown, context: HookContext) => {
    const tenantId =
      tenantFromParams(context.params)?.tenantId ??
      ((data && typeof data === 'object' && 'tenant_id' in data
        ? (data as { tenant_id?: TenantID }).tenant_id
        : undefined) as TenantID | undefined);
    return filterChannelToTenant(app.channel('authenticated'), tenantId);
  });
}
