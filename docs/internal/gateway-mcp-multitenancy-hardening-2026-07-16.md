# Gateway and MCP multi-tenancy hardening

## Scope and operating models

This note records the pre-implementation audit for the gateway/MCP hardening
follow-up to #1903. It covers two supported operating models:

- **Static/single tenant:** SQLite or PostgreSQL, with one configured
  `multi_tenancy.static_tenant_id`. Existing callers do not need to send a
  tenant header.
- **Auth-resolved multi tenant:** PostgreSQL with
  `multi_tenancy.mode: required_from_auth`. Tenant identity must come from a
  verified credential, a configured trusted edge header, or explicit internal
  routing metadata. Missing or conflicting identity fails before tenant-owned
  data is read.

The database transaction remains a short unit of work. An MCP tool call,
listener lifetime, provider poll, or outbound network request must not hold a
tenant transaction open.

## Audited trust boundaries

### MCP bootstrap

Before this change, `/mcp` verified personal API keys through
`user_api_keys`, loaded the user, and validated internal session tokens through
`sessions` before it had established a request tenant. That is both rejected by
the guarded database proxy in `required_from_auth` and unsafe on a database
role that can bypass RLS. Internal MCP JWTs signed `session/user/jti/exp`, but
not the tenant, so a token did not carry a cryptographic tenant binding.

The MCP Streamable HTTP transport already keeps an immutable user and optional
Agor-session binding, but it did not retain or compare an immutable tenant
binding. Tenant context was inferred later from the loaded user, which is too
late for authentication bootstrap.

### Gateway lifecycle and dispatch

Gateway channel rows are tenant owned. Startup nevertheless refreshed and
started listeners inside the configured bootstrap/static tenant scope, so an
auth-resolved deployment did not reconcile other tenants after a restart.
`GatewayService.hasActiveChannels` was one process-wide boolean populated by a
tenant-local query; refreshing a tenant with no enabled channels could suppress
outbound routing and progress delivery for every other tenant.

Slack (Socket Mode), GitHub and Shortcut (polling), and Teams (webhook server)
all implement the same connector contract: `startListening(callback)`, optional
`stopListening()`, and `sendMessage()`. Provider callbacks do not carry an Agor
tenant. The shared gateway layer must therefore capture the channel tenant when
the listener is created and re-enter it before any tenant-owned work. No
connector-specific tenant behavior is required.

### Global discovery

The only gateway operation that needs cross-tenant visibility is startup
discovery of enabled channel routing references. It may return only
`(tenant_id, channel_id)`. Channel configuration, credentials, mappings,
sessions, users, and outbound rows remain tenant-local and are reloaded after
entering the discovered tenant.

PostgreSQL `FORCE ROW LEVEL SECURITY` means an unscoped query sees only the
implicit `default` tenant even for the table owner. Gateway discovery therefore
needs an explicit, narrowly named database capability rather than relying on a
raw connection or a superuser/BYPASSRLS daemon role.

## Security invariants

1. **One request tenant:** every available trusted tenant signal must agree.
   Static configuration, verified token binding, configured trusted header,
   authenticated claim, and explicit internal context may not disagree. The
   trusted header is a singleton: duplicate or comma/list values fail closed.
2. **Bootstrap before data:** no personal-key, user, session, or other
   tenant-owned lookup runs before the MCP request tenant is established.
   Personal API keys in auth-resolved mode therefore require the configured
   trusted header; unlike internal JWTs, existing opaque keys contain no signed
   tenant claim.
3. **Tenant-bound internal tokens:** every newly issued internal MCP JWT signs a
   non-empty tenant id. Issuance requires an active tenant; cache keys include
   it; validation rejects legacy/unbound tokens and checks session existence
   inside the signed tenant.
4. **Immutable stateful binding:** an MCP Streamable HTTP session is bound at
   initialize time to `(tenant, user, optional Agor session)`. Every subsequent
   request re-authenticates; tenant and user must match. The optional Agor
   session may be omitted and retained, but cannot be added or replaced, and is
   re-authorized before the stored handler context is refreshed.
5. **Short database units:** MCP authentication probes, tool repository calls,
   gateway discovery, channel reloads, and dispatch lookups each use short
   scopes. Transport sessions and provider network work retain tenant identity
   only, never a database transaction.
6. **Narrow global discovery:** startup uses an explicit system scope plus a
   PostgreSQL RLS capability that can discover enabled gateway routing refs.
   Each ref must include a tenant; the full channel is then reloaded in that
   tenant before credentials are used or a listener starts.
7. **Tenant-aware process state:** listener keys and the enabled-channel fast
   path include tenant identity. Refreshing/stopping one tenant cannot suppress,
   replace, or reuse another tenant's state.
8. **Callback and outbound scope:** listener callbacks enter the captured
   tenant before calling the gateway. Outbound/progress/stream dispatch uses
   only the current tenant's fast-path state and repositories.
9. **Fail closed:** absent, conflicting, stale, or forged tenant identity causes
   authentication failure or skips background work; it never falls back to the
   bootstrap tenant in `required_from_auth`.

## Deliberate follow-ups

- Scheduler and health-monitor cross-tenant discovery use the same conceptual
  system-scope pattern but do not receive the new gateway-specific RLS
  capability in this change. They should be audited separately rather than
  broadening gateway review into a generic control-plane rewrite.
- Other startup jobs, including orphan/restart reconciliation and the knowledge
  embedding indexer, still use bootstrap/static tenant parameters. Making those
  jobs genuinely cross-tenant needs job-specific discovery contracts and is a
  separate startup-services audit; the gateway capability must not be reused.
- Gateway listener stop/start serialization and persisted provider polling
  cursors are existing reliability topics, not tenant-isolation prerequisites.
- Opaque personal API keys could eventually embed a signed tenant routing hint,
  removing the trusted-header requirement for external MCP API-key clients in
  auth-claim-only deployments. That would require a versioned key format and
  migration/rotation plan and is intentionally out of scope.
