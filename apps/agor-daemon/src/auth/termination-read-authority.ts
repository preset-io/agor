import { getCurrentTenantId } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, HookContext, Params, Session, Task } from '@agor/core/types';

const TERMINATION_READ = Symbol('termination-read');
type ReadParams = Params & { [TERMINATION_READ]?: object };
const grants = new WeakMap<
  object,
  { tenantId: string; path: string; id: string; taskId: string }
>();

/** Server-issued, single-call authority; JSON flags and provider-less calls are not grants. */
export function hasTerminationReadAuthority(context: HookContext): boolean {
  const token = (context.params as ReadParams)[TERMINATION_READ];
  const grant = token && grants.get(token);
  return (
    !!grant &&
    !context.params.provider &&
    context.method === 'get' &&
    context.params.tenant?.tenant_id === grant.tenantId &&
    context.path === grant.path &&
    String(context.id) === grant.id
  );
}

export function readTerminationEntity(
  app: Application,
  path: 'tasks',
  id: string,
  params: Params | undefined,
  taskId: string
): Promise<Task>;
export function readTerminationEntity(
  app: Application,
  path: 'sessions',
  id: string,
  params: Params | undefined,
  taskId: string
): Promise<Session>;
export async function readTerminationEntity(
  app: Application,
  path: 'tasks' | 'sessions',
  id: string,
  params: Params | undefined,
  taskId: string
): Promise<Task | Session> {
  const paramTenant = (params as AuthenticatedParams | undefined)?.tenant?.tenant_id;
  const tenantId = getCurrentTenantId() ?? paramTenant;
  if (tenantId && paramTenant && paramTenant !== tenantId) {
    throw new Error('Termination read tenant mismatch');
  }
  if (!id || !taskId || (path === 'tasks' && id !== taskId)) {
    throw new Error('Invalid termination read target');
  }
  const token = {};
  const readParams: ReadParams = { ...params, provider: undefined, [TERMINATION_READ]: token };
  // Standalone tests may have no tenant context. They receive no exemption.
  if (tenantId) grants.set(token, { tenantId, path, id, taskId });
  try {
    return await app.service(path).get(id, readParams);
  } finally {
    grants.delete(token);
  }
}
