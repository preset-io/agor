/**
 * Who may write an MCP server row, and what they may write.
 *
 * One function answers it for every write — the `mcp-servers` service hooks and
 * the marketplace connect endpoint both go through {@link authorizeMcpServerWrite}
 * — so the tenant's `mcp_member_policy`, the remote-transport restriction, and
 * the ownership and reach a private server is held to are decided in a single
 * place instead of being re-derived per entry point.
 *
 * Using a server is a separate question with a separate answer: see
 * `isMCPServerUsableInSession` in `@agor/core/mcp`, enforced where a server is
 * attached to a session and where a starting session's set is resolved.
 *
 * The caller-side reads of that same rule live at the bottom of this file —
 * whether a caller may be shown a row, an attachment link, or load one by id.
 * They decide visibility, not policy, so they stay beside the write authorizer
 * rather than folding into it.
 *
 * Those reads answer "whose row is this?", which a role change does not revisit.
 * The endpoints that issue a credential rather than read one need the second
 * question too, so the role floor those carry lives here as well — see
 * {@link MCP_CAPABILITY_ISSUING_SERVICE_PATHS}.
 */

import {
  MCPServerRepository,
  resolveMcpMemberPolicy,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
  UsersRepository,
} from '@agor/core/db';
import { Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import {
  isAtLeastMemberRole,
  isMCPServerUsableBy,
  isMcpGrantSubjectEntitled,
  MEMBER_PRIVATE_MCP_SCOPE,
  mayMemberManageMCPServer,
  mayMemberUseMCPScope,
  mayMemberUseMCPTransport,
  mayMemberWriteMCPServers,
} from '@agor/core/mcp';
import type {
  AuthenticatedParams,
  MCPMemberPolicy,
  MCPScope,
  MCPServer,
  MCPTransport,
  UserID,
} from '@agor/core/types';
import { hasMinimumRole, isCanonicalFullUuid, ROLES } from '@agor/core/types';
import { runInOAuthTenantScope } from '../oauth-auth-helpers.js';

export type McpServerWriteMethod = 'create' | 'update' | 'patch' | 'remove';

export interface McpServerWriteRequest {
  method: McpServerWriteMethod;
  /** The row being changed or deleted; absent on create. */
  existing?: Pick<MCPServer, 'mcp_server_id' | 'owner_user_id' | 'transport' | 'scope'>;
  /** The submitted payload; absent on remove. */
  data?: {
    transport?: MCPTransport;
    scope?: MCPScope;
    owner_user_id?: UserID | string | null;
    catalog_entry_name?: string;
  };
}

export interface McpServerWriteDecision {
  /** The owner to persist, for a create the caller is not free to choose. */
  owner_user_id?: UserID;
  /** The scope to persist, for a create whose policy fixes it. */
  scope?: MCPScope;
  /** The catalog provenance to persist, which only the install path may name. */
  catalog_entry_name?: string;
}

type McpServerWriteAuthorizationDatabase = TenantScopeAwareDatabase | TenantScopedDatabase;

/**
 * The extra params the marketplace connect service sets on its own
 * `mcp-servers` create, naming the entry it resolved from the catalog.
 *
 * Connect deliberately calls that service with the caller's own params so the
 * member policy, the transport restriction, and ownership stamping each decide
 * exactly once — which leaves it indistinguishable from a hand-rolled
 * `POST /mcp-servers` unless it says so out of band. A request cannot: Feathers
 * builds external params from the route, query, headers, and authentication,
 * so a top-level key like this one is only ever set by daemon code.
 *
 * It carries the entry and nothing else. The caller's identity is already on
 * `params.user`, and reading the owner from there rather than from this key is
 * what keeps "installed by" from becoming a field a daemon-side caller states.
 */
export interface McpCatalogInstallParams {
  mcpCatalogInstall?: { entry_name: string };
}

/**
 * What a marketplace install writes that an ordinary write does not: the
 * catalog provenance, and the owner.
 *
 * Provenance is a fact about how a row got here, not a field its owner
 * maintains. The registry name is printed on every card in the marketplace and
 * marketplace connect reuses an install by matching it, so a stamp anyone may
 * submit is a claim anyone may forge — a member could present a server aimed
 * at their own endpoint as the catalog's GitHub entry and have the next
 * connect hand it to somebody.
 *
 * It is refused rather than quietly dropped. No client here round-trips a
 * fetched server into a write — the UI hydrates its form from one but rebuilds
 * an explicit payload field by field, and neither it nor the CLI mentions this
 * field at all — so a stamp arriving from a request is a confused client or a
 * hostile one, and silence would serve neither. Admins are refused too: this
 * is not an operator-maintained field.
 *
 * Ownership is decided here rather than left to {@link decidePolicyAndOwnership}
 * because an install is not an ordinary create. Connect writes a `session`-scoped
 * row from a fixed payload that names no owner, so under the ordinary rules two
 * callers end up with a shared server: `allow_crud` reads "no owner requested"
 * as opting into one, and an admin skips the ownership rules entirely. An
 * unowned row is usable by every user in the tenant (`isMCPServerUsableBy`),
 * which is the opposite of what installing from the marketplace asks for. So a
 * catalog install belongs to whoever installed it, under every policy and at
 * every role. Publishing a server the whole tenant may use is still available
 * — it is what `POST /mcp-servers` is for.
 *
 * The owner is read from the authenticated caller, not from the install params:
 * every authentication strategy hydrates `params.user` from the users table,
 * so its full canonical ID is trusted here. A member's request-supplied owner
 * remains untrusted and is policy-stamped or rejected below. Connect only ever
 * installs for its own caller, so no daemon-side caller can name someone else's
 * identity by mistake.
 */
function resolveCatalogInstall(
  params: AuthenticatedParams | undefined,
  request: McpServerWriteRequest
): { entry_name: string; owner_user_id: UserID } | undefined {
  // Internal daemon calls and service accounts are trusted by their route and
  // write the columns directly, the way any other server-side field is written.
  if (!params?.provider) return undefined;
  if ((params.user as { _isServiceAccount?: boolean } | undefined)?._isServiceAccount === true) {
    return undefined;
  }

  if (request.data?.catalog_entry_name !== undefined) {
    throw new Forbidden(
      'MCP server catalog provenance cannot be set by a request; install from the marketplace to record it'
    );
  }

  if (request.method !== 'create') return undefined;
  const entryName = (params as McpCatalogInstallParams).mcpCatalogInstall?.entry_name;
  if (entryName === undefined) return undefined;

  const userId = params.user?.user_id as UserID | undefined;
  if (!userId) throw new NotAuthenticated('Authentication required');
  return { entry_name: entryName, owner_user_id: userId };
}

/** Admins keep `stdio`; see {@link mayMemberUseMCPTransport} for why members do not. */
function assertRemoteTransport(transport: MCPTransport | undefined): void {
  if (!mayMemberUseMCPTransport(transport)) {
    throw new Forbidden(
      'Only admins can configure stdio MCP servers; members can configure remote (http/sse) servers'
    );
  }
}

/**
 * The floor the member policy sits on top of.
 *
 * These four verbs used to carry a role gate — `requireMinimumRole(ADMIN)` on
 * each of create/update/patch/remove — in front of any policy reasoning.
 * Routing them through this authorizer replaced that gate rather than adding
 * to it, and a policy gate only distinguishes admin from everyone else. `viewer`
 * is a real role beneath member ("Read-only access"), so without this it fell
 * into the member path and inherited whatever the tenant's policy grants:
 * configuring servers under `allow_private_only`, and under `allow_crud` an
 * unowned one that every session in the tenant can then reach.
 *
 * The rule itself is {@link isAtLeastMemberRole}, which a client asks too — a
 * floor enforced here and re-derived there is the arrangement that lost it.
 */
function assertAtLeastMember(role: unknown): void {
  if (!isAtLeastMemberRole(role)) {
    throw new Forbidden('You need member access to configure MCP servers');
  }
}

/**
 * Whether this role and policy together permit configuring a server at all,
 * for the endpoint that answers it to clients. The decision is
 * {@link canConfigureMCPServers}; nothing is authorized by reading it.
 */
export { canConfigureMCPServers as canConfigureMcpServers } from '@agor/core/mcp';

/**
 * The `/mcp-servers/*` endpoints that mint, refresh, or exchange a credential,
 * rather than exercising one that already exists.
 *
 * Ownership is a durable grant; role is current standing. `owner_user_id`
 * records who configured a row and is never revisited when a user's role
 * changes, so `loadMcpServerForCaller` keeps admitting the owner of a server
 * after they are demoted to `viewer` — it is answering "whose row is this?",
 * which demotion does not change the answer to. For reading a server one owns
 * that is defensible. For these endpoints it is not: starting an authorization
 * flow, exchanging a code, or refreshing a grant issues *new* capability, and a
 * read-only account may not acquire capability it did not already hold.
 * Discovery belongs here too — it opens the server's transport on its stored
 * credential and writes the result back onto the row.
 *
 * So each of these carries a role floor in front of the ownership check, the
 * way {@link authorizeMcpServerWrite} does for configuration CRUD. Ownership
 * still decides *which* server; role decides whether the caller may issue
 * against any at all.
 *
 * Registered by iterating this list rather than by adding a hook to each
 * `app.service(...).hooks(...)` call in turn: a floor that is correct and a
 * floor that runs are different claims, and the endpoints are spread over
 * ~1,800 lines of `register-services.ts`, so per-endpoint wiring is exactly
 * where the next one gets forgotten.
 *
 * This list is not the security boundary for durable credentials, and must not
 * be read as one. Whether a grant may be *stored* is decided at the two writes
 * that store it — `persistOAuthToken` and `refreshAndPersistToken` both call
 * `assertMcpGrantSubjectEntitled` themselves — precisely so that no list of
 * endpoints has to be complete for the rule to hold. An earlier revision tried
 * to keep this list honest with a source scan for minting calls; a scan
 * enumerates callers, and callers can be aliased, wrapped, or newly added, so
 * it was replaced by enforcement at the choke point.
 *
 * What this list *is*: the endpoints a person drives where the caller's own
 * role is the right question, and where refusing up front beats a provider
 * round-trip that fails at the write. Two of them (`discover`, `test-jwt`)
 * reach a provider on a stored credential without persisting a grant, so for
 * those this is the only check there is.
 *
 * Absent because they issue nothing:
 * - `oauth-disconnect` — revocation. Refusing a demoted user the ability to
 *   drop their own grant would strand the credential this change exists to
 *   contain, so it stays open at every role.
 * - `oauth-status`, `oauth-attempt-status` — reads of the caller's own state.
 */
export const MCP_CAPABILITY_ISSUING_SERVICE_PATHS = [
  // Reserves the one-shot socket/caller binding required before a blocking
  // flow may create provider/DCR side effects.
  'mcp-servers/oauth-browser-reservations',
  // Mints an authorization URL and a pending flow against a saved server.
  'mcp-servers/oauth-start',
  // Exchanges the authorization code and persists the resulting token.
  'mcp-servers/oauth-complete',
  // Forces a refresh, extending a grant's lifetime on demand.
  'mcp-servers/oauth-refresh',
  // Writes a shared token onto the named row and backfills its token endpoint.
  'mcp-servers/test-oauth',
  // Fetches an access token from a caller-supplied endpoint with
  // caller-supplied credentials.
  'mcp-servers/test-jwt',
  // Opens the server's transport on its stored credential and writes the
  // capability list back onto the row.
  'mcp-servers/discover',
] as const;

/**
 * Whether the user a credential would be minted *for* still stands where they
 * stood when the grant was first authorized.
 *
 * The caller floor above cannot answer this, because on these two surfaces the
 * caller is frequently not the subject:
 *
 * - `oauth-callback` is the provider's browser redirect. It carries no session
 *   at all — its authorization is the one-shot `state` — so the only identity
 *   available is the one the pending flow recorded when it started. A member
 *   who starts a flow, is demoted, and then completes the redirect would
 *   otherwise have a token exchanged and persisted: the floor is on the start,
 *   and nothing re-asked at the finish.
 * - `oauth-auth-headers` refreshes and persists new access tokens
 *   (`refreshAndPersistToken`), which is minting by the same definition, but is
 *   called by a delegated task executor or explicit daemon service account.
 *   The task executor carries its user, but the grant owner's standing is
 *   still read fresh; a daemon service identity has no user standing at all.
 *
 * So both ask this about the *subject* rather than the requester. `shared`
 * grants keep their admin floor — they were always admin-only to start
 * (`oauth-start`) — and per-user grants get the member floor they never had.
 *
 * Deliberately not a `hasMinimumRole` call: see {@link assertMcpCapabilityRole}
 * for why an absent role must not read as MEMBER here.
 */
export { isMcpGrantSubjectEntitled } from '@agor/core/mcp';

/**
 * {@link isMcpGrantSubjectEntitled} against the subject's stored role.
 *
 * The role is read here rather than taken from the request because on both
 * calling surfaces the subject is not the requester, so there is no
 * `params.user` to read it from — the callback has no session at all, and the
 * refresh path is driven by an executor. Reading it fresh is also what makes a
 * demotion land without waiting for anything to expire.
 *
 * Fails closed on an unknown or unnamed subject: a credential that cannot be
 * attributed to a current user is not one to keep minting.
 */
export async function isMcpGrantOwnerEntitled(
  db: TenantScopeAwareDatabase,
  tenantId: string | undefined,
  ownerUserId: string | undefined,
  oauthMode: 'per_user' | 'shared' | undefined
): Promise<boolean> {
  if (!ownerUserId) return false;
  const owner = await runInOAuthTenantScope(db, tenantId, () =>
    new UsersRepository(db).findById(ownerUserId)
  );
  if (!owner) return false;
  return isMcpGrantSubjectEntitled(owner.role, oauthMode);
}

/**
 * The role floor for the endpoints above.
 *
 * Shares {@link isAtLeastMemberRole} with the write path rather than reaching
 * for the generic `requireMinimumRole(ROLES.MEMBER)` hook: that one normalizes
 * through `normalizeRole`, which answers MEMBER for an absent or empty role, so
 * it admits precisely the caller carrying no role at all. The MCP floor is
 * decided on the raw role for that reason, and having two floors that disagree
 * on the same question is how the first one was lost.
 *
 * The bypasses match `ensureMinimumRole`: an internal daemon call carries no
 * provider, and an explicit daemon service account carries no role to floor.
 */
export function assertMcpCapabilityRole(
  params: AuthenticatedParams | undefined,
  action: string
): void {
  if (!params?.provider) return;
  const user = params.user;
  if (!user) throw new NotAuthenticated('Authentication required');
  if ((user as { _isServiceAccount?: boolean })._isServiceAccount === true) return;
  if (isAtLeastMemberRole(user.role)) return;
  throw new Forbidden(`You need member access to ${action}`);
}

/** {@link assertMcpCapabilityRole} as a Feathers hook, for the registration below. */
export function requireMcpCapabilityRole<T extends { params: AuthenticatedParams }>(
  action: string
): (context: T) => T {
  return (context) => {
    assertMcpCapabilityRole(context.params, action);
    return context;
  };
}

/**
 * Wire the floor onto every path in {@link MCP_CAPABILITY_ISSUING_SERVICE_PATHS}.
 *
 * A function rather than a loop inlined at the call site so a test can apply
 * the real wiring to a real app and drive it, instead of asserting against a
 * copy of the loop that could drift from the one that ships — the same reason
 * {@link createMcpServerWriteAuthorizationHook} is a factory.
 *
 * Feathers appends hooks, so the `ctx.requireAuth` each of these services
 * registers inline still runs first and this decides on an authenticated
 * caller. Called after those registrations for that reason.
 */
export function registerMcpCapabilityRoleFloor(app: {
  // Method syntax, not a function-typed property: under `strictFunctionTypes`
  // the latter checks `hooks`' parameter contravariantly and no structural
  // stand-in for Feathers' `HookOptions<A, S>` is assignable to it. Methods are
  // checked bivariantly, which is what lets a real app satisfy this without the
  // util importing the whole `Application` type just to name a loop.
  service(path: string): { hooks(map: unknown): unknown };
}): void {
  for (const path of MCP_CAPABILITY_ISSUING_SERVICE_PATHS) {
    app.service(path).hooks({
      before: { create: [requireMcpCapabilityRole('connect and authorize MCP servers')] },
    });
  }
}

/**
 * A member widening their own server's reach, which is what
 * `allow_private_only` withholds. Only a change is refused: a payload that
 * restates the scope already stored — which is what every edit form sends —
 * has widened nothing.
 */
function assertScopeUnchangedOrAllowed(
  policy: MCPMemberPolicy,
  requested: MCPScope | undefined,
  stored: MCPScope
): void {
  if (requested === undefined || requested === stored) return;
  if (mayMemberUseMCPScope(policy, requested)) return;
  throw new Forbidden(
    "This MCP server's reach cannot be widened to the whole workspace; your organization allows members private servers, which reach the sessions they are attached to"
  );
}

/**
 * Refuse a write the tenant's policy does not permit.
 *
 * The marketplace gets its own sentence. Installing a curated entry is a much
 * narrower thing than configuring an arbitrary server: the entry, endpoint,
 * transport, and auth recipe come from the checked-in catalog and live probe.
 * A pasted bearer token can go only to that pinned catalog endpoint and is
 * stored on the caller-owned row; OAuth is fixed to `per_user`, and credential
 * reuse can select only a live caller grant bound to the same resource and
 * catalog policy. The internal `marketplace` compatibility policy is derived,
 * never stored or accepted from this request, and survives only while the row
 * still matches the current catalog prescription; explicit saved-row modes and
 * configuration drift take the strict/general path instead. So somebody who
 * clicked Connect and is told their
 * organization "does not allow members to configure MCP servers" is being
 * answered about a broader capability than they asked for, and reasonably
 * reads it as the marketplace being broken.
 *
 * Neither sentence promises the grant is coming. `use_existing_only` refusing
 * the marketplace is the deliberate current state, not a gap waiting on a fix:
 * the policy value that would permit installing from the curated list without
 * permitting arbitrary configuration does not exist yet.
 */
function assertPolicyAllowsWrite(policy: MCPMemberPolicy, isCatalogInstall: boolean): void {
  if (mayMemberWriteMCPServers(policy)) return;
  throw new Forbidden(
    isCatalogInstall
      ? 'Your organization does not allow members to add MCP servers, so this entry cannot be installed; ask an admin to add it'
      : 'Your organization does not allow members to configure MCP servers; ask an admin to add one'
  );
}

/**
 * Decide a single MCP server write.
 *
 * Returns the fields the caller must persist rather than mutating the payload,
 * so a caller cannot accidentally keep a client-supplied owner or provenance.
 *
 * Policy and ownership are decided first, so a caller who may not write at all
 * learns that rather than which fields are service-controlled.
 */
export async function authorizeMcpServerWrite(
  db: McpServerWriteAuthorizationDatabase,
  params: AuthenticatedParams | undefined,
  request: McpServerWriteRequest
): Promise<McpServerWriteDecision> {
  const decision = await decidePolicyAndOwnership(db, params, request);
  const install = resolveCatalogInstall(params, request);
  return install === undefined
    ? decision
    : {
        ...decision,
        catalog_entry_name: install.entry_name,
        owner_user_id: install.owner_user_id,
      };
}

async function decidePolicyAndOwnership(
  db: McpServerWriteAuthorizationDatabase,
  params: AuthenticatedParams | undefined,
  request: McpServerWriteRequest
): Promise<McpServerWriteDecision> {
  // Internal daemon calls and explicit daemon service accounts are not members;
  // they carry no policy and no ownership, matching `ensureMinimumRole`.
  if (!params?.provider) return {};
  const user = params.user;
  if (!user) throw new NotAuthenticated('Authentication required');
  if ((user as { _isServiceAccount?: boolean })._isServiceAccount === true) return {};

  // Keep the role floor ahead of identity validation and all policy/database
  // work. Authentication supplies the users-table key; short IDs are public
  // addressing conveniences and are never resolved at this ownership boundary.
  const isAdmin = hasMinimumRole(user.role, ROLES.ADMIN);
  if (!isAdmin) assertAtLeastMember(user.role);
  if (!isCanonicalFullUuid(user.user_id)) {
    throw new NotAuthenticated('Authenticated user identity must be a canonical full UUID');
  }
  const userId = user.user_id as UserID;

  // Ownership binds a configured credential to one execution identity, so
  // moving it is not an edit — it hands that credential to someone else's
  // sessions. Nobody gets to do it through an ordinary write, admins included.
  if (request.method !== 'create' && request.method !== 'remove' && request.existing) {
    // A shared server reads back as `undefined` and is written as `null`, so
    // compare on absence rather than on which of the two arrived.
    const requestedOwner = request.data?.owner_user_id;
    if (
      requestedOwner !== undefined &&
      (requestedOwner ?? null) !== (request.existing.owner_user_id ?? null)
    ) {
      throw new Forbidden('MCP server ownership cannot be changed');
    }
  }

  // Admins administer every server, including private ones. They still cannot
  // use one they do not own — that is the session-side rule, not this one.
  if (isAdmin) return {};

  const policy = await resolveMcpMemberPolicy(db, userId, params.tenant?.tenant_id);
  // Only the marketplace connect service sets this, and it cannot arrive on a
  // request — see `McpCatalogInstallParams`. So it is a safe way to tell the
  // caller which of the two things they were refused.
  const isCatalogInstall = (params as McpCatalogInstallParams).mcpCatalogInstall !== undefined;
  assertPolicyAllowsWrite(policy, isCatalogInstall);

  if (request.method === 'create') {
    assertRemoteTransport(request.data?.transport);
    // An absent field and an explicit `null` are different requests. Only the
    // second is a decision to publish; the first is a caller who never
    // considered the question, which is most of them — the MCP tool does not
    // expose ownership at all. Collapsing the two with `??` made silence mean
    // "shared", so the ordinary create produced a row every session in the
    // tenant can reach, and left a deliberate publish unexpressible.
    const ownerNamed = request.data !== undefined && Object.hasOwn(request.data, 'owner_user_id');
    const requestedOwner = request.data?.owner_user_id ?? undefined;
    if (requestedOwner && requestedOwner !== userId) {
      throw new Forbidden('You can only create MCP servers owned by yourself');
    }
    // Publishing — a server with no owner, which every session in the tenant
    // can reach — is the one thing `allow_crud` grants that `allow_private_only`
    // does not, so it has to be asked for by name rather than fallen into.
    const publishing = ownerNamed && request.data?.owner_user_id === null;

    if (policy === 'allow_private_only') {
      // Refused rather than quietly turned into a private server. The caller
      // asked for something this policy does not permit; answering "created"
      // while creating something else reports one thing and does another, and
      // leaves the client no way to notice. The same policy already refuses the
      // shared case on patch a few lines below, and this module already refuses
      // a payload it will not honour rather than dropping it — see the
      // caller-supplied catalog stamp.
      if (publishing) {
        throw new Forbidden(
          'Your organization only allows members their own private MCP servers, so this one cannot be shared with the workspace'
        );
      }
      // The reach this policy fixes is taken rather than asked for: `global` is
      // what several clients put in a payload by default, not something a
      // person chose, so it is decided here the way ownership is.
      return { owner_user_id: userId, scope: MEMBER_PRIVATE_MCP_SCOPE };
    }

    return publishing ? {} : { owner_user_id: userId };
  }

  const existing = request.existing;
  if (!existing) {
    throw new Forbidden('MCP server not found');
  }

  if (!mayMemberManageMCPServer(existing, policy, userId)) {
    throw new Forbidden(
      existing.owner_user_id
        ? "You cannot modify another user's private MCP server"
        : 'Your organization only allows members to manage their own private MCP servers'
    );
  }

  if (request.method !== 'remove') {
    assertRemoteTransport(request.data?.transport ?? existing.transport);
    assertScopeUnchangedOrAllowed(policy, request.data?.scope, existing.scope);
  }

  return {};
}

/**
 * The `mcp-servers` write hook, as a factory rather than a closure inside the
 * service registration.
 *
 * A guard that is correct and a guard that runs are different claims, and the
 * second one is the one that was missing: every test of this module called the
 * authorizer directly, so nothing would have noticed the hook being dropped
 * from the service or a caller reaching the repository around it. Building the
 * hook here lets a test stand up the real service with the real hook and assert
 * the row that lands in the database — see `mcp-catalog-connect.install.test.ts`.
 */
export function createMcpServerWriteAuthorizationHook(
  db: TenantScopeAwareDatabase
): (context: McpServerWriteHookContext) => Promise<McpServerWriteHookContext> {
  return async (context) => {
    const method = context.method as McpServerWriteMethod;
    const items = Array.isArray(context.data) ? context.data : [context.data];
    const existing =
      method === 'create' ? undefined : await loadMcpServerForWrite(db, context.id ?? undefined);

    for (const item of items) {
      const data = (item ?? undefined) as McpServerWriteRequest['data'];
      const decision = await authorizeMcpServerWrite(db, context.params, {
        method,
        existing,
        data,
      });
      if (decision.owner_user_id !== undefined && data) {
        data.owner_user_id = decision.owner_user_id;
      }
      if (decision.scope !== undefined && data) {
        data.scope = decision.scope;
      }
      if (decision.catalog_entry_name !== undefined && data) {
        data.catalog_entry_name = decision.catalog_entry_name;
      }
    }

    return context;
  };
}

/** The slice of a Feathers hook context {@link createMcpServerWriteAuthorizationHook} reads. */
export interface McpServerWriteHookContext {
  method: string;
  id?: unknown;
  data?: unknown;
  params: AuthenticatedParams;
}

/** Load the row a patch/update/remove targets, for {@link authorizeMcpServerWrite}. */
export async function loadMcpServerForWrite(
  db: TenantScopeAwareDatabase,
  id: unknown
): Promise<MCPServer | undefined> {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return (await new MCPServerRepository(db).findById(id)) ?? undefined;
}

export interface SessionMcpServerVisibilityRow {
  owner_user_id?: string | null;
  session_created_by: string;
}

/**
 * A visible session is not enough to disclose every attached server ID. A
 * collaborator may read a session while its creator's private MCP definition
 * remains out of scope. Internal/service callers and admins retain the
 * existing control-plane visibility.
 */
export function isSessionMcpServerLinkVisibleToCaller(
  row: SessionMcpServerVisibilityRow,
  params: AuthenticatedParams | undefined
): boolean {
  if (!params?.provider) return true;
  const user = params.user;
  if (!user) return false;
  if ((user as { _isServiceAccount?: boolean })._isServiceAccount) return true;
  if (hasMinimumRole(user.role, ROLES.ADMIN)) return true;
  return isMCPServerUsableBy(row, row.session_created_by) && isMCPServerUsableBy(row, user.user_id);
}

export function isMcpServerUsableByCaller(
  server: MCPServer,
  params: AuthenticatedParams | undefined
): boolean {
  if (!params?.provider) return true;
  const user = params.user;
  if (!user) return false;
  if ((user as { _isServiceAccount?: boolean })._isServiceAccount) return true;
  return hasMinimumRole(user.role, ROLES.ADMIN) || isMCPServerUsableBy(server, user.user_id);
}

/**
 * Load a server named by a caller-supplied ID and enforce the direct-use
 * boundary. OAuth and discovery endpoints act on the saved configuration or
 * shared credential, so they cannot rely on session attachment checks.
 */
export async function loadMcpServerForCaller(
  db: TenantScopeAwareDatabase,
  serverId: string,
  params: AuthenticatedParams | undefined
): Promise<MCPServer> {
  const server = await new MCPServerRepository(db).findById(serverId);
  if (!server) throw new NotFound(`MCP server not found: ${serverId}`);

  if (!params?.provider) return server;
  if (!params.user) throw new NotAuthenticated('Authentication required');
  if (isMcpServerUsableByCaller(server, params)) return server;

  // Avoid an existence oracle for private server definitions.
  throw new NotFound(`MCP server not found: ${serverId}`);
}
