/**
 * Marketplace connect: install one catalog entry and hand back a session that
 * can use it.
 *
 * The request names a catalog entry and where the session should live, and
 * nothing else. URL, transport, and auth are read from the catalog row —
 * accepting them from the client would make this a way to register any server
 * at all without passing the `mcp_member_policy` gate that guards
 * `POST /mcp-servers`.
 *
 * It also does not re-implement that gate. The server row is created through
 * the `mcp-servers` service and the session through `sessions`, with the
 * caller's own params, so policy, ownership stamping, the remote-transport
 * restriction, branch permissions, and Unix identity all resolve exactly once,
 * in the places that already own them.
 *
 * Scope: curated entries, remote transport, no authentication. OAuth and
 * API-key entries need the credential model that does not exist yet.
 */

import { BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import { probeRemoteAuthType } from '@agor/core/mcp-catalog';
import type {
  AgenticToolName,
  AuthenticatedParams,
  CreateMCPServerInput,
  MCPCatalogEntry,
  MCPServer,
  MCPTransport,
  Session,
  UserID,
} from '@agor/core/types';

export interface MCPCatalogConnectData {
  /** Catalog entry UUID or its reverse-DNS registry name. */
  catalog_key: string;
  branch_id: string;
  agentic_tool: AgenticToolName;
}

export interface MCPCatalogConnectResult {
  mcp_server: MCPServer;
  session: Session;
  /** The entry's curated demonstration prompt, for the new session's composer. */
  starter_prompt?: string;
  /** True when an existing install was reused rather than a second row created. */
  reused_existing_server: boolean;
}

/** Catalog transports, as `mcp_servers` names them. */
function toServerTransport(entry: MCPCatalogEntry): MCPTransport {
  return entry.transport === 'sse' ? 'sse' : 'http';
}

/**
 * A readable, tool-namespace-safe server name from a reverse-DNS catalog name.
 *
 * `io.github.github/github-mcp-server` becomes `github-mcp-server`: the full
 * identity stays on `catalog_entry_name`, while this is what shows up in every
 * `mcp__<name>__<tool>` the agent sees.
 */
function serverNameFor(entry: MCPCatalogEntry): string {
  const lastSegment = entry.name.split('/').pop() ?? entry.name;
  const slug = lastSegment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'mcp-server';
}

/**
 * Whether two endpoint URLs name the same place.
 *
 * Normalised through `URL` so a trailing slash, a default port, or a
 * differently-cased host does not read as a different server and cost somebody
 * their install. Anything unparseable falls back to an exact comparison rather
 * than guessing.
 */
function sameEndpoint(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const normalize = (value: string): string => {
    try {
      const url = new URL(value.trim());
      url.pathname = url.pathname.replace(/\/+$/, '');
      return url.href;
    } catch {
      return value.trim();
    }
  };
  return normalize(a) === normalize(b);
}

/**
 * Whether `server` is still an install of `entry`.
 *
 * The stamp records where a row came from; this asks whether it is still that.
 * The two come apart because a member may point their own private server
 * wherever they like — which is theirs to do — so a stamp on its own would let
 * a redirected row stand in for the catalog's, and reuse would hand the next
 * caller an endpoint the catalog never named. A stamp nobody but the install
 * path can write (see `authorizeMcpServerWrite`) closes the forged half; this
 * closes the half where a legitimately stamped row is edited afterwards.
 *
 * Only the endpoint is compared, because only the endpoint is the catalog's to
 * fix. Name, labels, `enabled`, scope, headers, and credentials are the
 * owner's to tune, and a second row for a benign edit would be a worse outcome
 * than the duplicate reuse exists to prevent.
 */
function isInstallOf(server: MCPServer, entry: MCPCatalogEntry & { remote_url: string }): boolean {
  return (
    server.catalog_entry_name === entry.name &&
    server.transport === toServerTransport(entry) &&
    sameEndpoint(server.url, entry.remote_url)
  );
}

function assertConnectableEntry(entry: MCPCatalogEntry): asserts entry is MCPCatalogEntry & {
  remote_url: string;
} {
  if (!entry.curated) {
    throw new Forbidden(
      `Only reviewed catalog entries can be connected; ${entry.name} has not been reviewed`
    );
  }
  if (!entry.has_remote || !entry.remote_url || entry.transport === 'stdio') {
    throw new BadRequest(
      `${entry.name} has no remote endpoint; locally-run MCP servers are configured by an admin`
    );
  }
}

/**
 * The entry's authentication requirement, probing when the catalog has not
 * recorded one yet.
 *
 * The stored verdict comes from the registry sync, which an operator may never
 * turn on, so relying on it alone would make connect refuse every curated entry
 * on a default install. `unknown` means "not determined", never "open", so it
 * is resolved rather than assumed.
 */
async function resolveAuthRequirement(
  entry: MCPCatalogEntry & { remote_url: string }
): Promise<void> {
  const probed =
    entry.probed_auth_type === 'unknown' || entry.probed_auth_type === undefined
      ? (await probeRemoteAuthType(entry.remote_url)).probed_auth_type
      : entry.probed_auth_type;

  if (probed === 'none') return;

  if (probed === 'oauth' || probed === 'credentials') {
    throw new BadRequest(`${entry.name} requires authentication, which is not supported yet`);
  }
  throw new BadRequest(`${entry.name} could not be reached, so it cannot be connected`);
}

export interface MCPCatalogConnectService {
  create(
    data: MCPCatalogConnectData,
    params: AuthenticatedParams
  ): Promise<MCPCatalogConnectResult>;
}

export function createMCPCatalogConnectService(
  // biome-ignore lint/suspicious/noExplicitAny: Feathers app type is complex and varies
  app: any
): MCPCatalogConnectService {
  const service = (path: string) => app.service(path);

  /**
   * An install of this entry the caller can already use, if there is one.
   *
   * Matched on the registry name, so an entry the registry withdrew and
   * republished — a fresh row for the same server — still recognises the
   * install the user already has instead of adding a duplicate beside it. Both
   * sides carry the catalog's own `name` verbatim, which is what the entry is
   * unique on, so there is no second normalisation to keep in step.
   *
   * The name alone does not settle it, though: see {@link isInstallOf}. A row
   * that has stopped pointing at the entry's endpoint is passed over rather
   * than handed back, so a caller who has one of those and a real install gets
   * the real one.
   */
  const findExistingInstall = async (
    entry: MCPCatalogEntry & { remote_url: string },
    userId: UserID | undefined,
    params: AuthenticatedParams
  ): Promise<MCPServer | undefined> => {
    const result = await service('mcp-servers').find({
      ...params,
      provider: undefined,
      query: { ...(userId ? { usableByUserId: userId } : {}), $limit: 1000 },
    });
    const servers = (Array.isArray(result) ? result : result.data) as MCPServer[];
    return servers.find((server) => isInstallOf(server, entry));
  };

  return {
    async create(data, params) {
      if (!data?.catalog_key) throw new BadRequest('catalog_key is required');
      if (!data.branch_id) throw new BadRequest('branch_id is required');
      if (!data.agentic_tool) throw new BadRequest('agentic_tool is required');

      let entry: MCPCatalogEntry;
      try {
        entry = (await service('mcp-catalog').get(data.catalog_key, {
          ...params,
          query: {},
        })) as MCPCatalogEntry;
      } catch {
        throw new NotFound(`MCP catalog entry not found: ${data.catalog_key}`);
      }

      assertConnectableEntry(entry);
      await resolveAuthRequirement(entry);

      const userId = params.user?.user_id as UserID | undefined;
      const existing = await findExistingInstall(entry, userId, params);

      const createInput: CreateMCPServerInput = {
        name: serverNameFor(entry),
        display_name: entry.title ?? entry.name,
        description: entry.benefit ?? entry.description,
        transport: toServerTransport(entry),
        url: entry.remote_url,
        auth: { type: 'none' },
        // Session scope: an install is for the session it launched, not
        // silently for every session its owner will ever start.
        scope: 'session',
        source: 'user',
      };

      // Provenance is named on params rather than in the payload: the write
      // authorizer refuses a stamp that arrived from a request, so this is the
      // one path that can produce one. See `McpCatalogInstallParams`.
      const mcpServer =
        existing ??
        ((await service('mcp-servers').create(createInput, {
          ...params,
          mcpCatalogInstall: { entry_name: entry.name },
        })) as MCPServer);

      // Three writes across three services, so there is no transaction to lean
      // on. A server nobody can see is the worst thing to leave behind — it is
      // configuration the user never asked to keep and cannot find to remove —
      // so a failure after this point takes back the row this request created.
      // A reused install is somebody's existing state and is left alone.
      try {
        const session = (await service('sessions').create(
          {
            branch_id: data.branch_id,
            agentic_tool: data.agentic_tool,
            status: 'idle',
            title: entry.title ?? entry.name,
          },
          params
        )) as Session;

        await service('/sessions/:id/mcp-servers').create(
          { mcpServerId: mcpServer.mcp_server_id },
          { ...params, route: { id: session.session_id } }
        );

        return {
          mcp_server: mcpServer,
          session,
          starter_prompt: entry.starter_prompt,
          reused_existing_server: Boolean(existing),
        };
      } catch (error) {
        if (!existing) {
          try {
            await service('mcp-servers').remove(mcpServer.mcp_server_id, {
              ...params,
              provider: undefined,
            });
          } catch (cleanupError) {
            console.warn(
              `[mcp-catalog/connect] Left ${mcpServer.mcp_server_id} behind after a failed connect:`,
              cleanupError instanceof Error ? cleanupError.message : cleanupError
            );
          }
        }
        throw error;
      }
    },
  };
}
