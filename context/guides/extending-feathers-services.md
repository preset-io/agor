# Extending FeathersJS Services

Where things live in `apps/agor-daemon/src/`:

- `register-services.ts` — `app.use(...)`; custom service methods must be listed in `methods`.
- `register-hooks.ts` — before/after hooks, including for custom methods; `TENANT_OWNED_SERVICE_PATHS`.
- `register-routes.ts` — custom routes such as `/sessions/:id/prompt`, registered with the
  tenant-scoped `registerAuthenticatedRoute` built by `createTenantScopedAuthenticatedRouteRegistrar`
  (`utils/tenant-authenticated-route.ts`). Don't call the unscoped one from `utils/authorization.ts`
  directly: custom routes skip the tenant hook inventory, so the registrar is what installs tenant
  DB scope and the write gate. Role checks go in the route's auth config, not inside the handler.

Use a service method (e.g. `boards.clone`) for actions on the service's own resource. Use a
custom route when the action needs path params or spans resources.

## Boot-time registration checks

`index.ts` refuses to boot unless every registered path is declared in:

- `REALTIME_PUBLISH_POLICY` (`utils/realtime-publish-policy.ts`). A path with no entry
  publishes to nobody.
- Tenant DB-scope classification: `TENANT_OWNED_SERVICE_PATHS`,
  `TENANT_IDENTITY_ONLY_SERVICE_PATHS`, or `TENANT_SERVICE_CLASSIFICATIONS`
  (`utils/tenant-service-classification.ts`).

## Events from custom methods

Feathers only auto-publishes events from top-level calls to standard methods. If a custom
method creates or mutates rows, `super.create()` and `this.emit()` inside it do **not** reach
connected clients. Instead:

1. Write through the repository in the service method.
2. Emit from an `after` hook for that method with
   `emitServiceEvent(app, { path, event, data: context.result, params: context.params })`
   (`utils/emit-service-event.ts`). Don't call raw `app.service(x).emit(...)`. Without the
   hook-shaped third argument the publisher loses `path`/`params`, so tenant and RBAC
   scoping degrade. See the `boards` `clone` hook in `register-hooks.ts`.

## Gate `update` wherever you gate `patch`

On a `DrizzleService` (`adapters/drizzle.ts`), `update` and single-id `patch` do the same thing:
`get`, then `repository.update(id, stripTenantMutation(data))` with a partial merge. `update` is
not a whole-row replace. If `'update'` is listed in `methods`, `PUT /<service>/:id` is routed. A
hook block that gates `patch` but not `update` leaves that route guarded only by the `all` chain.
Either gate `update` or leave it out of `methods`.
