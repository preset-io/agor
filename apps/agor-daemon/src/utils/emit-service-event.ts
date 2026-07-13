import { enqueueAfterTenantDatabaseCommit, getCurrentTenantId } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { HookContext, TenantContext } from '@agor/core/types';

const DEFAULT_EVENT_METHOD: Record<string, string> = {
  created: 'create',
  updated: 'update',
  patched: 'patch',
  removed: 'remove',
};

export type ManualServiceEvent = {
  /**
   * Service path the event belongs to (e.g. `'branches'`). Load-bearing: the
   * realtime publish handler keys tenant + branch/session RBAC scoping off
   * `context.path`.
   */
  path: string;
  /**
   * Service event name. Typically one of `created` | `updated` | `patched` |
   * `removed` (the method is inferred from these), but any custom event string
   * is supported — pass `method` to set the inferred CRUD method for those.
   */
  event: string;
  /** Record to broadcast (becomes both the event payload and `hook.result`). */
  data: unknown;
  /**
   * Request params carrying tenant/connection context. Load-bearing: without a
   * resolvable tenant here (or an ambient tenant DB scope), multi-tenant
   * publishing suppresses the event to service-only sockets.
   */
  params?: HookContext['params'];
  /** Optional record id (publisher uses it as a branch-id fallback and for logging). */
  id?: HookContext['id'];
  /** Overrides the CRUD method inferred from `event`. */
  method?: string;
};

/**
 * Manually emit a Feathers service event with a correctly-shaped publish
 * context.
 *
 * Some services persist through a raw adapter path (e.g. an overridden
 * `patch()` that calls `super.patch()`), which bypasses Feathers' automatic
 * event dispatch — so those call sites must emit the service event by hand.
 *
 * The shape of the emit matters. Feathers' transport-commons publish listener
 * passes the THIRD `emit` argument through UNCHANGED as the publish `hook`, and
 * only synthesizes a fake `{ path, service, app, result }` when that argument
 * is absent (`@feathersjs/transport-commons` `channels/index.ts`). Automatic
 * events, by contrast, emit the full HookContext (`@feathersjs/feathers`
 * `events.ts`). So both malformed shapes lose something the global publish
 * handler (`configureRealtimePublish`) needs:
 *   - passing NO third arg gets a synthesized `path`, but no `context.params`
 *     (no tenant/connection context), and
 *   - passing raw params as the third arg carries `context.params`-looking data
 *     at the wrong nesting AND loses `path` (Feathers won't synthesize it once a
 *     third arg is present).
 * Either way the handler can't resolve the tenant channel (multi-tenancy)
 * and/or the branch/session RBAC scope, so it degrades to global-scope
 * broadcast or service-only suppression.
 *
 * Build the hook shape once, here, so call sites can't drift on it.
 */
export function emitServiceEvent(app: Application, event: ManualServiceEvent): void {
  const ambientTenantId = getCurrentTenantId();
  const explicitTenantId = event.params?.tenant?.tenant_id;
  if (ambientTenantId && explicitTenantId && ambientTenantId !== explicitTenantId) {
    throw new Error(
      `Refusing to emit ${event.path}.${event.event}: explicit tenant does not match ambient tenant scope`
    );
  }

  // Realtime publication happens asynchronously, after the operation's ALS
  // scope may have ended. Snapshot tenant identity into the HookContext now.
  const params: HookContext['params'] = { ...(event.params ?? {}) };
  if (ambientTenantId && !explicitTenantId) {
    params.tenant = {
      tenant_id: ambientTenantId as TenantContext['tenant_id'],
      source: 'explicit',
    };
  }

  const emit = () => {
    const service = app.service(event.path as never) as unknown as {
      emit?: (name: string, data: unknown, hook: Partial<HookContext>) => void;
    };
    service.emit?.(event.event, event.data, {
      app,
      service,
      path: event.path,
      method: event.method ?? DEFAULT_EVENT_METHOD[event.event] ?? 'patch',
      event: event.event,
      id: event.id,
      result: event.data,
      params,
    } as Partial<HookContext>);
  };

  if (!enqueueAfterTenantDatabaseCommit(emit)) emit();
}
