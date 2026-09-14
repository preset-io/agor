import type { MCPMarketplaceRepository } from '@agor/core/db';
import { NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, MCPMarketplaceOverview, UserID } from '@agor/core/types';

export class MCPMarketplaceService {
  constructor(private readonly repository: MCPMarketplaceRepository) {}

  async find(params?: AuthenticatedParams): Promise<MCPMarketplaceOverview> {
    const userId = params?.user?.user_id as UserID | undefined;
    if (!userId) throw new NotAuthenticated('Authentication required');
    return this.repository.overviewForUser(userId);
  }
}
