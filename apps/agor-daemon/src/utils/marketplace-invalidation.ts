import { enqueueAfterTenantDatabaseCommit } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { HookContext, UserID } from '@agor/core/types';
import { emitHaNativeSocketEvent, tenantUserChannelName } from '../realtime/routing.js';

type RealtimeApplication = Application & {
  io?: {
    to(room: string): { emit(event: string, payload: unknown): unknown };
  };
};

type MarketplaceProjectionEvent = 'marketplace:changed' | 'marketplace:invalidated';

function emitMarketplaceProjectionEvent(
  app: RealtimeApplication,
  tenantId: string | undefined,
  userIds: Iterable<UserID | string>,
  event: MarketplaceProjectionEvent
): void {
  if (!tenantId || !app.io) return;
  const targets = [...new Set([...userIds].filter((value) => typeof value === 'string' && value))];
  if (targets.length === 0) return;

  const emit = () => {
    for (const userId of targets) {
      emitHaNativeSocketEvent(app.io!.to(tenantUserChannelName(tenantId, userId)), event, {});
    }
  };
  if (!enqueueAfterTenantDatabaseCommit(emit)) emit();
}

export const MARKETPLACE_INVALIDATION_TARGETS_PARAM = '_agorMarketplaceInvalidationTargets';

/** Capture the pre-write tenant audience so a removed principal is retained. */
export async function captureMarketplaceInvalidationTargets(
  context: HookContext,
  users: { listUserIds(): Promise<UserID[]> },
  app: RealtimeApplication
): Promise<HookContext> {
  if (!context.params.tenant?.tenant_id || !app.io) return context;
  const ids = await users.listUserIds();
  (context.params as typeof context.params & Record<string, unknown>)[
    MARKETPLACE_INVALIDATION_TARGETS_PARAM
  ] = ids;
  return context;
}

/** Publish the pre-write snapshot after the authority mutation succeeds. */
export function publishCapturedMarketplaceInvalidation(
  context: HookContext,
  app: RealtimeApplication
): HookContext {
  const ids = (context.params as typeof context.params & Record<string, unknown>)[
    MARKETPLACE_INVALIDATION_TARGETS_PARAM
  ];
  emitMarketplaceInvalidation(
    app,
    context.params.tenant?.tenant_id,
    Array.isArray(ids) ? (ids as UserID[]) : []
  );
  return context;
}

/**
 * Tell exactly the named users in exactly one tenant to discard Marketplace
 * caller-private state.
 *
 * This is a revocation signal, not a resource event. It deliberately carries
 * no branch, server, user, or credential metadata. Targeting happens in the
 * tenant-qualified room name, so a user id collision across tenants cannot
 * widen delivery. Native Socket.IO is used because its Redis adapter preserves
 * these exact rooms across replicas; post-write Feathers branch publication
 * cannot reach somebody whose visibility was just removed.
 */
export function emitMarketplaceInvalidation(
  app: RealtimeApplication,
  tenantId: string | undefined,
  userIds: Iterable<UserID | string>
): void {
  emitMarketplaceProjectionEvent(app, tenantId, userIds, 'marketplace:invalidated');
}

/**
 * Tell affected Marketplace views to revalidate without discarding their last
 * good caller-scoped projection. Ordinary server/tool mutations use this;
 * `marketplace:invalidated` remains reserved for visibility revocation.
 */
export function emitMarketplaceChanged(
  app: RealtimeApplication,
  tenantId: string | undefined,
  userIds: Iterable<UserID | string>
): void {
  emitMarketplaceProjectionEvent(app, tenantId, userIds, 'marketplace:changed');
}
