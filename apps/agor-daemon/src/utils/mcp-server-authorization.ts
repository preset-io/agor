/**
 * Who may write an MCP server row, and what they may write.
 *
 * One function answers it for every write — the `mcp-servers` service hooks and
 * the marketplace connect endpoint both go through {@link authorizeMcpServerWrite}
 * — so the tenant's `mcp_member_policy`, the remote-transport restriction, and
 * the private-server ownership rule are decided in a single place instead of
 * being re-derived per entry point.
 *
 * Using a server is a separate question with a separate answer: see
 * `isMCPServerUsableInSession` in `@agor/core/mcp`, enforced where a server is
 * attached to a session and where a starting session's set is resolved.
 */

import {
  MCPServerRepository,
  resolveMcpMemberPolicy,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { Forbidden, NotAuthenticated, NotFound } from '@agor/core/feathers';
import { isMCPServerUsableBy } from '@agor/core/mcp';
import type {
  AuthenticatedParams,
  MCPMemberPolicy,
  MCPServer,
  MCPTransport,
  UserID,
} from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';

export type McpServerWriteMethod = 'create' | 'update' | 'patch' | 'remove';

export interface McpServerWriteRequest {
  method: McpServerWriteMethod;
  /** The row being changed or deleted; absent on create. */
  existing?: Pick<MCPServer, 'mcp_server_id' | 'owner_user_id' | 'transport'>;
  /** The submitted payload; absent on remove. */
  data?: {
    transport?: MCPTransport;
    owner_user_id?: UserID | string | null;
    catalog_entry_name?: string;
  };
}

export interface McpServerWriteDecision {
  /** The owner to persist, for a create the caller is not free to choose. */
  owner_user_id?: UserID;
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
 */
export interface McpCatalogInstallParams {
  mcpCatalogInstall?: { entry_name: string };
}

/**
 * The catalog provenance this write may persist, refusing any the client sent.
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
 */
function resolveCatalogProvenance(
  params: AuthenticatedParams | undefined,
  request: McpServerWriteRequest
): string | undefined {
  // Internal daemon calls and service accounts are trusted by their route and
  // write the column directly, the way any other server-side field is written.
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
  return (params as McpCatalogInstallParams).mcpCatalogInstall?.entry_name;
}

/**
 * A `stdio` server is a command line the executor process runs on its host.
 * Letting members configure one turns "may register an MCP server" into "may
 * run any binary as the executor user", which is not the grant either
 * permissive policy value is meant to hand out. Admins keep it.
 */
function assertRemoteTransport(transport: MCPTransport | undefined): void {
  if (transport === 'stdio') {
    throw new Forbidden(
      'Only admins can configure stdio MCP servers; members can configure remote (http/sse) servers'
    );
  }
}

function assertPolicyAllowsWrite(policy: MCPMemberPolicy): void {
  if (policy === 'use_existing_only') {
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
  const catalogEntryName = resolveCatalogProvenance(params, request);
  return catalogEntryName === undefined
    ? decision
    : { ...decision, catalog_entry_name: catalogEntryName };
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

  const policy = await resolveMcpMemberPolicy(db, userId, params.tenant?.tenant_id);
  assertPolicyAllowsWrite(policy);

  if (request.method === 'create') {
    assertRemoteTransport(request.data?.transport);
    const requestedOwner = request.data?.owner_user_id ?? undefined;
    if (requestedOwner && requestedOwner !== userId) {
      throw new Forbidden('You can only create MCP servers owned by yourself');
    }
    // `allow_private_only` means exactly that: the server the member creates is
    // theirs, whether or not they asked for it to be. `allow_crud` lets them
    // opt into a shared server, which is the whole difference between the two.
    if (policy === 'allow_private_only') return { owner_user_id: userId };
    return requestedOwner ? { owner_user_id: userId } : {};
  }

  const existing = request.existing;
  if (!existing) {
    throw new Forbidden('MCP server not found');
  }

  if (existing.owner_user_id) {
    if (existing.owner_user_id !== userId) {
      throw new Forbidden("You cannot modify another user's private MCP server");
    }
  } else if (policy === 'allow_private_only') {
    throw new Forbidden(
      'Your organization only allows members to manage their own private MCP servers'
    );
  }

  if (request.method !== 'remove') {
    assertRemoteTransport(request.data?.transport ?? existing.transport);
  }

  return {};
}

/** Load the row a patch/update/remove targets, for {@link authorizeMcpServerWrite}. */
export async function loadMcpServerForWrite(
  db: TenantScopeAwareDatabase,
  id: unknown
): Promise<MCPServer | undefined> {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return (await new MCPServerRepository(db).findById(id)) ?? undefined;
}

/**
 * Load a server named by a caller-supplied id, for the endpoints that act on
 * one directly: OAuth start / refresh / disconnect and capability discovery.
 *
 * These sit outside the session path, so the session-creator rule has nothing
 * to key on — the question here is whether *this caller* may touch this row at
 * all. A private server is answered as not-found rather than forbidden: to
 * everyone but its owner and an admin it does not exist.
 *
 * They need this because each one reads or writes something that belongs to
 * the server's owner — its OAuth client configuration, its shared token, its
 * discovered capability list — none of which the ordinary CRUD authorizer
 * covers.
 */
export async function loadMcpServerForCaller(
  db: TenantScopeAwareDatabase,
  serverId: string,
  params: AuthenticatedParams | undefined
): Promise<MCPServer> {
  const server = await new MCPServerRepository(db).findById(serverId);
  if (!server) throw new NotFound(`MCP server not found: ${serverId}`);

  // Internal and service-account callers are already trusted by their route.
  if (!params?.provider) return server;
  const user = params.user;
  if (!user) throw new NotAuthenticated('Authentication required');
  if ((user as { _isServiceAccount?: boolean })._isServiceAccount === true) return server;

  if (hasMinimumRole(user.role, ROLES.ADMIN)) return server;
  if (isMCPServerUsableBy(server, user.user_id)) return server;

  throw new NotFound(`MCP server not found: ${serverId}`);
}
