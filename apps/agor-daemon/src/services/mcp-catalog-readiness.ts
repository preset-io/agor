import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Id,
  MCPCatalogEntry,
  MCPCatalogReadiness,
  MCPServer,
  MCPServerID,
  UserID,
} from '@agor/core/types';
import { compatibleCatalogOAuthPeers } from './mcp-catalog-credential-match.js';
import { catalogOAuthConfig, isCurrentCatalogInstall } from './mcp-catalog-install-policy.js';

export interface MCPCatalogReadinessDeps {
  readGrantResourceUri(
    serverId: MCPServerID,
    params: AuthenticatedParams
  ): Promise<string | undefined>;
}

interface ReadinessServiceApp {
  service(path: string): {
    get(id: Id, params?: AuthenticatedParams): Promise<unknown>;
    find(params?: AuthenticatedParams): Promise<unknown>;
  };
}

/**
 * Advisory, side-effect-free readiness for one static catalog entry. It does
 * not probe, refresh, create, attach, or mutate a session. Connect remains the
 * authority and rechecks the endpoint and credential at click time.
 */
export class MCPCatalogReadinessService {
  constructor(
    private readonly app: ReadinessServiceApp,
    private readonly deps: MCPCatalogReadinessDeps
  ) {}

  async get(id: Id, params?: AuthenticatedParams): Promise<MCPCatalogReadiness> {
    const userId = params?.user?.user_id as UserID | undefined;
    if (!userId || !params) throw new NotAuthenticated('Authentication required');

    const catalogKey = String(id);
    const entry = (await this.app.service('mcp-catalog').get(catalogKey, {
      ...params,
      provider: undefined,
    })) as MCPCatalogEntry;
    if (!entry.remote_url || entry.transport === 'stdio') {
      throw new BadRequest('This catalog entry has no Marketplace-connectable remote endpoint');
    }
    const remoteEntry = entry as MCPCatalogEntry & { remote_url: string };

    const result = (await this.app.service('mcp-servers').find({
      ...params,
      provider: undefined,
      query: { usableByUserId: userId, $limit: 1000 },
    })) as MCPServer[] | { data: MCPServer[] };
    const servers = (Array.isArray(result) ? result : result.data) as MCPServer[];

    const knownOAuthInstall = servers.some(
      (server) =>
        server.source === 'catalog' &&
        server.catalog_entry_name === entry.name &&
        server.auth?.type === 'oauth'
    );
    if (entry.auth_type === 'oauth' || knownOAuthInstall) {
      // A stale static auth label cannot erase what a prior authoritative
      // Connect learned. For a non-OAuth label, consider only that entry's own
      // install — never infer reuse from an unrelated manual OAuth row.
      const oauthPool =
        entry.auth_type === 'oauth'
          ? servers
          : servers.filter(
              (server) => server.source === 'catalog' && server.catalog_entry_name === entry.name
            );
      const peers = await compatibleCatalogOAuthPeers(remoteEntry, oauthPool, {
        readGrantResourceUri: (serverId) => this.deps.readGrantResourceUri(serverId, params),
      });
      const now = Date.now();
      const live = peers.find((server) => {
        const expiresAt = server.auth?.oauth_token_expires_at;
        return Boolean(server.auth?.oauth_access_token) && !(expiresAt && expiresAt <= now);
      });
      if (live) {
        const prescribed = catalogOAuthConfig(remoteEntry);
        const installed =
          live.source === 'catalog' &&
          live.catalog_entry_name === entry.name &&
          isCurrentCatalogInstall(live, remoteEntry, prescribed, {
            reconcileMissingCompatibilityMode: true,
          });
        return { catalog_key: catalogKey, state: installed ? 'installed_ready' : 'reusable_oauth' };
      }
      return { catalog_key: catalogKey, state: 'oauth_required' };
    }

    if (entry.auth_type === 'credentials') {
      return { catalog_key: catalogKey, state: 'bearer_required' };
    }

    const installed = servers.some(
      (server) =>
        server.enabled &&
        server.source === 'catalog' &&
        server.catalog_entry_name === entry.name &&
        isCurrentCatalogInstall(server, remoteEntry, { type: 'none' })
    );
    return { catalog_key: catalogKey, state: installed ? 'installed_ready' : 'no_auth' };
  }
}
