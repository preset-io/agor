import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Id,
  MCPCatalogEntry,
  MCPCatalogReadiness,
  MCPCatalogServerCandidate,
  UserID,
} from '@agor/core/types';
import { readCatalogSharing } from './mcp-catalog-access.js';
import { selectCatalogCandidate } from './mcp-catalog-credential-match.js';
import { catalogOAuthConfig } from './mcp-catalog-install-policy.js';

export interface MCPCatalogReadinessDeps {
  listCandidates(userId: UserID, params: AuthenticatedParams): Promise<MCPCatalogServerCandidate[]>;
  isGrantAuthorized(
    candidate: MCPCatalogServerCandidate,
    params: AuthenticatedParams
  ): Promise<boolean>;
}

interface ReadinessServiceApp {
  service(path: string): {
    get(id: Id, params?: AuthenticatedParams): Promise<unknown>;
  };
}

/** Side-effect-free advisory read; no probe, refresh, create, or mutation. */
export class MCPCatalogReadinessService {
  constructor(
    private readonly app: ReadinessServiceApp,
    private readonly deps: MCPCatalogReadinessDeps
  ) {}

  async get(id: Id, params?: AuthenticatedParams): Promise<MCPCatalogReadiness> {
    const userId = params?.user?.user_id as UserID | undefined;
    if (!userId || !params) throw new NotAuthenticated('Authentication required');
    const sharing = readCatalogSharing(params.query?.sharing);
    const catalogKey = String(id);
    const entry = (await this.app.service('mcp-catalog').get(catalogKey, {
      ...params,
      provider: undefined,
    })) as MCPCatalogEntry;
    if (!entry.remote_url || entry.transport === 'stdio') {
      throw new BadRequest('This catalog entry has no Marketplace-connectable remote endpoint');
    }
    const remoteEntry = entry as MCPCatalogEntry & { remote_url: string };
    const candidates = (await this.deps.listCandidates(userId, params)).filter(({ server }) =>
      sharing === 'shared' ? !server.owner_user_id : server.owner_user_id === userId
    );
    const knownOAuthInstall = candidates.some(
      ({ server }) =>
        server.source === 'catalog' &&
        server.catalog_entry_name === entry.name &&
        server.auth?.type === 'oauth'
    );

    if (entry.auth_type === 'oauth' || knownOAuthInstall) {
      const oauthPool =
        entry.auth_type === 'oauth'
          ? candidates
          : candidates.filter(
              ({ server }) =>
                server.source === 'catalog' && server.catalog_entry_name === entry.name
            );
      const selection = await selectCatalogCandidate(
        remoteEntry,
        catalogOAuthConfig(remoteEntry),
        oauthPool,
        userId,
        Date.now(),
        { isGrantAuthorized: (candidate) => this.deps.isGrantAuthorized(candidate, params) },
        sharing
      );
      if (selection.live) {
        return {
          catalog_key: catalogKey,
          state: selection.liveKind === 'catalog_install' ? 'installed_ready' : 'reusable_oauth',
        };
      }
      return {
        catalog_key: catalogKey,
        state: 'oauth_required',
        ...(selection.currentCatalog ? { reusable_configuration: true } : {}),
      };
    }

    if (entry.auth_type === 'credentials') {
      return { catalog_key: catalogKey, state: 'bearer_required' };
    }
    const selection = await selectCatalogCandidate(
      remoteEntry,
      { type: 'none' },
      candidates,
      userId,
      Date.now(),
      { isGrantAuthorized: async () => false },
      sharing
    );
    return {
      catalog_key: catalogKey,
      state: selection.currentCatalog ? 'installed_ready' : 'no_auth',
    };
  }
}
