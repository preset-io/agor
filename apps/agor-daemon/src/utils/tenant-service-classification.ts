import {
  TENANT_IDENTITY_ONLY_SERVICE_PATHS,
  TENANT_OWNED_SERVICE_PATHS,
} from '../register-hooks.js';
import {
  NON_SERVICE_REGISTERED_PATHS,
  normalizeRealtimePublishPath,
} from './realtime-publish-policy.js';

/**
 * Where a service's tenant database scope is armed — declared at registration.
 *
 * ## The defect class this exists to close
 *
 * One shape has now produced five separate defects on this codebase, three of
 * them after a reviewer had already looked, and one of them proved a shipped
 * recovery lane's repair sweep had never repaired anything:
 *
 *  - a route or callback registered outside `TENANT_OWNED_SERVICE_PATHS`, so
 *    nothing upstream arms a tenant database scope;
 *  - a free function or unbound repository reached from identity-only context
 *    (`runWithTenantContext`, a timer, `setImmediate`, a sweep callback);
 *  - `MissingTenantDatabaseScopeError` thrown, then laundered by a fail-closed
 *    catch into a generic refusal, or swallowed entirely;
 *  - and a suite that stubs every repository, so there is no guard to trip.
 *
 * Every fix so far was per-site. This makes the policy EXPLICIT AT
 * REGISTRATION, so that adding a service without deciding where its scope comes
 * from is not something a pull request can do quietly.
 *
 * ## What this is, stated precisely
 *
 * A **Feathers registration coverage gate**, plus a safer data-access
 * convention (`utils/tenant-bound-data-access.ts`). The gate compares
 * `Object.keys(app.services)` against a table of declarations and refuses to
 * boot when a path has none. That is the whole mechanism.
 *
 * It does NOT verify that a service's database access matches its declaration,
 * and it cannot: nothing here reads a handler, inspects a registrar, or
 * instruments a query. `tenant-service-classification.limits.test.ts` drives
 * each escape below against this assertion and pins the PASSING result, so the
 * limits are discoverable rather than assumed:
 *
 *  - a service declared `identity-only` that keeps a raw
 *    `TenantScopeAwareDatabase` and makes exactly the unscoped call every
 *    defect in this class was made of is admitted. A declaration is a claim,
 *    not a proof;
 *  - a `scoped` entry in {@link TENANT_SERVICE_CLASSIFICATIONS} is admitted
 *    whether or not its registration installs the hook. Only membership in
 *    {@link TENANT_OWNED_SERVICE_PATHS} — or registration through
 *    `createTenantScopedAuthenticatedRouteRegistrar` — installs one; a
 *    hand-written `scoped` here asserts something this file cannot check;
 *  - new code INSIDE an already-classified service needs no new declaration: a
 *    fresh method, a timer it starts, a sweep callback it registers;
 *  - Express handlers are not services. `app.post('/mcp-egress/:serverId', …)`
 *    never appears in `app.services`, so it is outside this gate entirely;
 *  - the assertion runs ONCE, at boot (Phase 3.6 in `index.ts`). Anything
 *    registered after it is never looked at.
 *
 * Closing those means connecting classification to the actual registrar or to
 * injected dependencies, which is a platform change rather than this
 * mechanism. What the gate does buy is the one thing every defect in the class
 * shared at registration time: a path nobody had decided about.
 *
 * ## The three answers
 *
 * `scoped`
 *   The registration itself arms a tenant database scope for the whole
 *   request — membership in {@link TENANT_OWNED_SERVICE_PATHS}, or registration
 *   through `createTenantScopedAuthenticatedRouteRegistrar`. Handlers may reach
 *   tenant repositories directly.
 *
 * `identity-only`
 *   The registration arms tenant IDENTITY and deliberately no request-long
 *   transaction, because the service crosses a provider/process/network
 *   boundary or is reached from a timer or sweep. Tenant identity may come from
 *   authentication or from verified sealed claims. Every database access must
 *   open its OWN short unit — through `TenantBoundDataAccess`
 *   (`utils/tenant-bound-data-access.ts`) or a repository bound with
 *   `bindRepositoryToTenantUnitOfWork`. Holding a raw handle here is the defect.
 *
 * `system`
 *   Narrowly reviewed: the service performs no tenant-owned database access at
 *   all. Process-local state, checked-in global data, or a pre-identity
 *   endpoint. Requires a `why` that says what makes that true, because this is
 *   the answer that turns the check off.
 *
 * ## The baseline
 *
 * Classifying every authenticated service in the daemon is a platform-wide
 * sweep and does not belong in a feature pull request. So the services that
 * predate this mechanism are listed in {@link UNCLASSIFIED_SERVICE_BASELINE}
 * and permitted, while anything NEW must answer. The baseline may only shrink:
 * see the constant's own comment for the two ratchets that enforce that.
 */
export type TenantServiceScopeClass = 'scoped' | 'identity-only' | 'system';

export interface TenantServiceClassification {
  scopeClass: TenantServiceScopeClass;
  /**
   * Why this answer. For `identity-only`, name the boundary that makes a
   * request-long transaction wrong; for `system`, say what makes "no
   * tenant-owned database access" true. Reviewers read this column.
   */
  why: string;
}

/**
 * Services that have declared where their tenant database scope is armed.
 *
 * Most of these were classified by the agent-initiated MCP OAuth feature — the
 * connect and recovery lanes, their browser preflights, the widget routes, the
 * Catalog connect lane, and the operator switches those lanes read. Services
 * registered since then answer here too.
 *
 * Paths already named by {@link TENANT_OWNED_SERVICE_PATHS} or
 * {@link TENANT_IDENTITY_ONLY_SERVICE_PATHS} are classified from those
 * inventories directly and are deliberately NOT repeated here: those lists are
 * what actually installs the hook, so re-stating them would create a second
 * place to be wrong. This table is for services registered outside both.
 */
export const TENANT_SERVICE_CLASSIFICATIONS: Record<string, TenantServiceClassification> = {
  // --------------------------------------------------------------------------
  // The two Slack lanes' browser preflights. Registered with a bare `app.use`
  // plus a `requireAuth` hook, so nothing upstream arms a scope: each opens one
  // for every read and for the consume CAS, keyed by the tenant its sealed
  // claims were verified against. This is the registration whose missing scope
  // made a valid link look revoked.
  // --------------------------------------------------------------------------
  'mcp-oauth-connect': {
    scopeClass: 'identity-only',
    why: 'Sealed-token preflight: opens its own scope per read/CAS from claim-verified tenant identity, and must not hold a transaction across the grant-liveness resolve.',
  },
  'mcp-slack-recovery': {
    scopeClass: 'identity-only',
    why: 'Same shape as mcp-oauth-connect for the recovery lane: claim-verified tenant, own short scope per read and for the consume CAS.',
  },

  // --------------------------------------------------------------------------
  // Widget lifecycle. Long routes: tenant identity for the request, short
  // database units at each access. The resolver threads
  // `runInTenantDatabaseScope` and its repositories are bound to the tenant
  // unit of work.
  // --------------------------------------------------------------------------
  'widgets/:id/submit': {
    scopeClass: 'identity-only',
    why: 'Resolution dispatches into a registry handler that may queue a task and broadcast; each database access opens its own unit via the threaded runInTenantDatabaseScope.',
  },
  'widgets/:id/oauth-resolve': {
    scopeClass: 'identity-only',
    why: 'Makes no provider call: it re-reads persisted grant liveness, with one short settle wait while a refresh this daemon started is in flight. The grant/server re-reads each open their own unit rather than holding one across that wait.',
  },
  'widgets/:id/dismiss': {
    scopeClass: 'identity-only',
    why: 'Same resolver and the same threaded scope as submit.',
  },

  // --------------------------------------------------------------------------
  // Catalog connect. Probes a remote endpoint before writing anything.
  // --------------------------------------------------------------------------
  'mcp-catalog/connect': {
    scopeClass: 'identity-only',
    why: 'Probes the entry endpoint over the network before installing; every write goes through a service that opens its own unit.',
  },
  'mcp-catalog/start-session': {
    scopeClass: 'identity-only',
    why: 'Multi-service orchestration after a Catalog install; each owning service enters its own tenant unit and runs its normal hooks.',
  },

  // --------------------------------------------------------------------------
  // The provider redirect. Unauthenticated at the transport — the tenant comes
  // from the sealed OAuth state — and it waits on a token exchange, so the
  // grant persistence runs in its own short write unit.
  // --------------------------------------------------------------------------
  'mcp-servers/oauth-callback': {
    scopeClass: 'identity-only',
    why: 'Provider redirect: tenant comes from verified sealed state, and the code exchange must not run inside a database transaction.',
  },

  // --------------------------------------------------------------------------
  // Operator surfaces the lanes read. Registered through the tenant-scoped
  // route registrar, so the scope is armed at registration.
  // --------------------------------------------------------------------------
  'api/v1/user/me': {
    scopeClass: 'scoped',
    why: 'Registered through createTenantScopedAuthenticatedRouteRegistrar; returns the authenticated caller projection only.',
  },
  'mcp-slack-connect/card': {
    scopeClass: 'scoped',
    why: 'Registered through createTenantScopedAuthenticatedRouteRegistrar; reads and writes one app variable in the request scope.',
  },
  'mcp-member-policy': {
    scopeClass: 'scoped',
    why: 'Registered through createTenantScopedAuthenticatedRouteRegistrar; one app-variable read/write in the request scope.',
  },
  'mcp-egress/status': {
    scopeClass: 'scoped',
    why: 'Registered through createTenantScopedAuthenticatedRouteRegistrar; the gateway-mode read runs in the request scope and the runtime status is process-local.',
  },

  // --------------------------------------------------------------------------
  // The browser reservation the connect widget uses to pre-open the provider
  // window while user activation is available.
  // --------------------------------------------------------------------------
  'mcp-servers/oauth-browser-reservations': {
    scopeClass: 'system',
    why: 'Touches no database: the reservation lives in a process-local map, and its authority is read from the live Socket.IO connection projection.',
  },

  // --------------------------------------------------------------------------
  // Branch provisioning retry (#2118). A long authenticated route, so nothing
  // upstream arms a scope, and it dispatches the provisioning executor before
  // it returns. Its sibling lifecycle routes ('branches/:id/start' and friends)
  // predate this mechanism and sit in the baseline; this one is new, so it
  // answers.
  // --------------------------------------------------------------------------
  'branches/:id/retire-teammate': {
    scopeClass: 'identity-only',
    why: 'Metadata-only retirement carries authenticated tenant identity and the write gate at registration. Branch/repo reads, the authority-fenced preference-and-archive admission, session archival and final read each open short tenant units in requestWorkspaceOperation; terminal closure and realtime delivery happen outside those units. No global or creator authority is used.',
  },
  'branches/:id/retry-provisioning': {
    scopeClass: 'identity-only',
    why: 'Long route that crosses the executor spawn boundary: the authorization read, the repo lookup, the failed -> creating CAS and the dispatch each open their own short unit via reposService.withTenantDatabase, so no transaction is held across the spawn.',
  },
};

/**
 * Services registered before this mechanism existed, permitted unclassified.
 *
 * **This list may only shrink.** Two ratchets enforce that:
 *
 *  1. An entry that is no longer registered, or that has since been classified,
 *     FAILS the check with "remove it from the baseline" — so the list cannot
 *     go stale and quietly keep permitting something.
 *  2. `check:multitenancy-boundaries` compares the `BASELINE-ENTRY` names in
 *     this file against `APPROVED_UNCLASSIFIED_SERVICE_BASELINE` in
 *     `scripts/check-multitenancy-boundaries.mjs`. A name that is not approved
 *     fails CI, and so does an approved name that has left this file without
 *     leaving the script — which is what keeps a classified service from being
 *     re-listed later. A count could not do either: swapping one entry for
 *     another leaves the total at 57.
 *
 * So the way to add a service is to classify it, not to list it here. Shrinking
 * it is a platform sweep for another day; a feature pull request classifies
 * what it owns and leaves the rest.
 *
 * Each line is one `BASELINE-ENTRY`, which is what the check script reads.
 */
export const UNCLASSIFIED_SERVICE_BASELINE: readonly string[] = [
  'session-streams', // BASELINE-ENTRY
  'messages/streaming', // BASELINE-ENTRY
  'tasks/streaming', // BASELINE-ENTRY
  'authentication', // BASELINE-ENTRY
  'authentication/refresh', // BASELINE-ENTRY
  'authentication/impersonate', // BASELINE-ENTRY
  'auth/launch', // BASELINE-ENTRY
  'config/resolve-api-key', // BASELINE-ENTRY
  'branches/:id/clean', // BASELINE-ENTRY
  'api/v1/user/api-keys', // BASELINE-ENTRY
  'mcp-servers/test-jwt', // BASELINE-ENTRY
  'templates', // BASELINE-ENTRY
  'health', // BASELINE-ENTRY
  'me/artifact-trust-grants', // BASELINE-ENTRY
  'sessions/:id/fork', // BASELINE-ENTRY
  'sessions/:id/spawn', // BASELINE-ENTRY
  'sessions/:id/prompt', // BASELINE-ENTRY
  'sessions/:id/initialize', // BASELINE-ENTRY
  'sessions/:id/spawn-prompt', // BASELINE-ENTRY
  'sessions/:id/stop', // BASELINE-ENTRY
  'sessions/:id/archive', // BASELINE-ENTRY
  'sessions/:id/unarchive', // BASELINE-ENTRY
  'sessions/:id/genealogy', // BASELINE-ENTRY
  'sessions/:id/env-selections', // BASELINE-ENTRY
  'sessions/:id/permission-decision', // BASELINE-ENTRY
  'sessions/:id/restart-cli', // BASELINE-ENTRY
  'sessions/:id/tasks/queue', // BASELINE-ENTRY
  'tasks/:id/run', // BASELINE-ENTRY
  'tasks/:id/complete', // BASELINE-ENTRY
  'tasks/:id/fail', // BASELINE-ENTRY
  'branches/:id/start', // BASELINE-ENTRY
  'branches/:id/stop', // BASELINE-ENTRY
  'branches/:id/restart', // BASELINE-ENTRY
  'branches/:id/nuke', // BASELINE-ENTRY
  'branches/:id/health', // BASELINE-ENTRY
  'branches/:id/render-environment', // BASELINE-ENTRY
  'branches/logs', // BASELINE-ENTRY
  'branches/:id/archive-or-delete', // BASELINE-ENTRY
  'branches/:id/unarchive', // BASELINE-ENTRY
  'branches/:id/execute-schedule-now', // BASELINE-ENTRY
  'branches/:id/fire-zone-trigger', // BASELINE-ENTRY
  'schedules/:id/run-now', // BASELINE-ENTRY
  'boards/:id/sessions', // BASELINE-ENTRY
  'board-comments/:id/reply', // BASELINE-ENTRY
  'board-comments/:id/toggle-reaction', // BASELINE-ENTRY
  'board-comments/:id/reposition', // BASELINE-ENTRY
  'repos/local', // BASELINE-ENTRY
  'repos/clone', // BASELINE-ENTRY
  'repos/:id/branches', // BASELINE-ENTRY
  'repos/:id/branches/:name', // BASELINE-ENTRY
  'repos/:id/import-agor-yml', // BASELINE-ENTRY
  'repos/:id/export-agor-yml', // BASELINE-ENTRY
  'artifacts/:id/payload', // BASELINE-ENTRY
  'artifacts/:id/console', // BASELINE-ENTRY
  'artifacts/:id/sandpack-error', // BASELINE-ENTRY
  'artifacts/:id/runtime-response/:requestId', // BASELINE-ENTRY
  'artifacts/:id/trust', // BASELINE-ENTRY
];

const BASELINE = new Set(UNCLASSIFIED_SERVICE_BASELINE.map(normalizeRealtimePublishPath));

const DERIVED: ReadonlyMap<string, TenantServiceClassification> = new Map([
  ...TENANT_OWNED_SERVICE_PATHS.map((path): [string, TenantServiceClassification] => [
    normalizeRealtimePublishPath(path),
    {
      scopeClass: 'scoped',
      why: 'Named by TENANT_OWNED_SERVICE_PATHS, which installs the tenant database scope around hook.',
    },
  ]),
  ...TENANT_IDENTITY_ONLY_SERVICE_PATHS.map((path): [string, TenantServiceClassification] => [
    normalizeRealtimePublishPath(path),
    {
      scopeClass: 'identity-only',
      why: 'Named by TENANT_IDENTITY_ONLY_SERVICE_PATHS, which installs tenant identity without a request-long transaction.',
    },
  ]),
  ...Object.entries(TENANT_SERVICE_CLASSIFICATIONS).map(
    ([path, classification]): [string, TenantServiceClassification] => [
      normalizeRealtimePublishPath(path),
      classification,
    ]
  ),
]);

/**
 * The declared classification for a path, or `undefined` when nobody declared
 * one. `undefined` is not "no opinion" — it is the thing the check refuses.
 */
export function tenantServiceClassificationFor(
  path: string | null | undefined
): TenantServiceClassification | undefined {
  if (!path) return undefined;
  return DERIVED.get(normalizeRealtimePublishPath(path));
}

/** Every path that carries a declared classification, normalized. */
export function classifiedTenantServicePaths(): ReadonlySet<string> {
  return new Set(DERIVED.keys());
}

export function isBaselinedUnclassifiedService(path: string): boolean {
  return BASELINE.has(normalizeRealtimePublishPath(path));
}

export class TenantServiceClassificationError extends Error {
  constructor(public readonly unclassifiedPaths: string[]) {
    super(
      `No tenant scope classification for: ${unclassifiedPaths.join(', ')}.\n` +
        `Every service registered by the daemon must say where its tenant ` +
        `database scope is armed. Add the path to TENANT_OWNED_SERVICE_PATHS ` +
        `(scoped) or TENANT_IDENTITY_ONLY_SERVICE_PATHS (identity-only) in ` +
        `register-hooks.ts, or declare it in TENANT_SERVICE_CLASSIFICATIONS ` +
        `(apps/agor-daemon/src/utils/tenant-service-classification.ts). ` +
        `An identity-only service must reach the database through ` +
        `TenantBoundDataAccess or a bound repository, never a raw handle. ` +
        `UNCLASSIFIED_SERVICE_BASELINE is closed to new entries.`
    );
    this.name = 'TenantServiceClassificationError';
  }
}

type ServiceRegistry = { services?: Record<string, unknown> };

/**
 * Throw unless every service registered on `app` is classified or baselined.
 *
 * Called once at startup after all three registration phases, next to
 * `assertRealtimePublishPolicyCoverage` and for the same reason: it reads the
 * registration table, not request data, so a deployment that boots in CI boots
 * in production.
 */
export function assertTenantServiceClassification(app: unknown): void {
  const registered = Object.keys((app as ServiceRegistry).services ?? {});
  const unclassified = registered
    .map(normalizeRealtimePublishPath)
    .filter(
      (path) => !DERIVED.has(path) && !BASELINE.has(path) && !NON_SERVICE_REGISTERED_PATHS.has(path)
    )
    .sort();
  if (unclassified.length > 0) throw new TenantServiceClassificationError(unclassified);
}
