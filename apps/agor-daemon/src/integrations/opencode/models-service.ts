import { loadConfigSync } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type { AuthenticatedParams, OpenCodeModelCatalog } from '@agor/core/types';
import { runExecutorCommand } from '../../utils/spawn-executor.js';
import { resolveAuthenticatedOpenCodeSubjectContext } from './credential-namespace.js';
import { createOpenCodeExecutorInvocation } from './executor-command.js';

export class OpenCodeModelsService {
  constructor(private readonly db: TenantScopeAwareDatabase) {}

  async find(params?: AuthenticatedParams): Promise<OpenCodeModelCatalog> {
    const config = loadConfigSync();
    const context = await resolveAuthenticatedOpenCodeSubjectContext(this.db, params, config);
    if (Object.keys(params?.query ?? {}).length > 0) {
      throw new BadRequest('OpenCode model discovery does not accept query parameters.');
    }

    let result: Awaited<ReturnType<typeof runExecutorCommand>>;
    try {
      result = await runExecutorCommand(
        createOpenCodeExecutorInvocation(context.dataHome, {
          operation: 'discover-models',
        }),
        {
          asUser: context.asUser,
          env: context.executorEnv,
          logPrefix: '[OpenCode Models]',
          templateVariables: { unix_user: context.asUser ?? undefined },
        }
      );
    } catch {
      throw new BadRequest('OpenCode model discovery failed. Try again.');
    }
    if (!result.success || !result.data) {
      throw new BadRequest('OpenCode model discovery failed. Try again.');
    }
    return result.data as OpenCodeModelCatalog;
  }
}

export function createOpenCodeModelsService(db: TenantScopeAwareDatabase) {
  return new OpenCodeModelsService(db);
}

export async function resolveOpenCodeCreateModelFallback(
  db: TenantScopeAwareDatabase,
  params: AuthenticatedParams
) {
  const catalog = await createOpenCodeModelsService(db).find(params);
  const suggestion = catalog.suggestedSelection;
  return suggestion
    ? { mode: 'exact' as const, provider: suggestion.providerId, model: suggestion.modelId }
    : undefined;
}
