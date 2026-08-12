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
 */

import {
  MCPServerRepository,
  resolveMcpMemberPolicy,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import {
  isMCPServerUsableBy,
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
import { hasMinimumRole, ROLES } from '@agor/core/types';

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
 * connect only ever installs for its own caller, and taking it from `params.user`
 * means no daemon-side caller can name someone else's identity by mistake.
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
 * Decided on the raw role rather than a normalized one. `normalizeRole` answers
 * MEMBER for an absent or empty value, so `hasMinimumRole(user.role, MEMBER)`
 * on its own would admit precisely the caller with no role to speak of. An
 * unrecognized role ranks 0 and is refused for the same reason: a role this
 * code does not know is not one it may assume is privileged.
 */
function isAtLeastMember(role: unknown): boolean {
  const named = typeof role === 'string' && role.length > 0;
  return named && hasMinimumRole(role, ROLES.MEMBER);
}

function assertAtLeastMember(role: unknown): void {
  if (!isAtLeastMember(role)) {
    throw new Forbidden('You need member access to configure MCP servers');
  }
}

/**
 * Whether this role and policy together permit configuring a server at all.
 *
 * The same decision {@link authorizeMcpServerWrite} makes, minus the per-request
 * detail, so a client can grey out a control instead of discovering the refusal
 * by being refused. It is exported so callers read the rule rather than
 * reconstructing it from `isAdmin` and a policy value — reducing role to a
 * boolean is what let the role floor go missing here in the first place.
 *
 * Advisory only. Nothing is authorized by this function; the write path decides.
 */
export function canConfigureMcpServers(role: unknown, policy: MCPMemberPolicy): boolean {
  if (typeof role === 'string' && hasMinimumRole(role, ROLES.ADMIN)) return true;
  if (!isAtLeastMember(role)) return false;
  return policy !== 'use_existing_only';
}

/**
 * A member widening their own server's reach, which is what
 * `allow_private_only` withholds. Only a change is refused: a payload that
 * restates the scope already stored — which is what every edit form sends —
 * has widened nothing, and refusing it would lock the owner out of a row that
 * predates the policy.
 */
function assertScopeUnchangedOrAllowed(
  policy: MCPMemberPolicy,
  requested: MCPScope | undefined,
  stored: MCPScope
): void {
  if (requested === undefined || requested === stored) return;
  if (mayMemberUseMCPScope(policy, requested)) return;
  throw new Forbidden(
    'Your organization only allows members private MCP servers, which reach the sessions they are attached to; ask an admin for a workspace-wide one'
  );
}

function assertPolicyAllowsWrite(policy: MCPMemberPolicy): void {
  if (!mayMemberWriteMCPServers(policy)) {
    throw new Forbidden(
      'Your organization does not allow members to configure MCP servers; ask an admin to add one'
    );
  }
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
  db: TenantScopeAwareDatabase,
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
  db: TenantScopeAwareDatabase,
  params: AuthenticatedParams | undefined,
  request: McpServerWriteRequest
): Promise<McpServerWriteDecision> {
  // Internal daemon calls and executor service accounts are not members;
  // they carry no policy and no ownership, matching `ensureMinimumRole`.
  if (!params?.provider) return {};
  const user = params.user;
  if (!user) throw new NotAuthenticated('Authentication required');
  if ((user as { _isServiceAccount?: boolean })._isServiceAccount === true) return {};

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
  if (hasMinimumRole(user.role, ROLES.ADMIN)) return {};

  assertAtLeastMember(user.role);

  const policy = await resolveMcpMemberPolicy(db, userId, params.tenant?.tenant_id);
  assertPolicyAllowsWrite(policy);

  if (request.method === 'create') {
    assertRemoteTransport(request.data?.transport);
    const requestedOwner = request.data?.owner_user_id ?? undefined;
    if (requestedOwner && requestedOwner !== userId) {
      throw new Forbidden('You can only create MCP servers owned by yourself');
    }
    // `allow_private_only` means exactly that: the server the member creates is
    // theirs and reaches only the sessions they attach it to, whether or not
    // they asked for either. Both are decided rather than refused, because
    // `global` is what several clients put in the payload by default rather
    // than something a person chose. `allow_crud` lets them opt into a shared
    // server, which is the whole difference between the two.
    if (policy === 'allow_private_only') {
      return { owner_user_id: userId, scope: MEMBER_PRIVATE_MCP_SCOPE };
    }
    return requestedOwner ? { owner_user_id: userId } : {};
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
