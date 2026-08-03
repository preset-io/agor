import { loadConfigSync } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type { AuthenticatedParams, OpenCodeModelCatalog } from '@agor/core/types';
import { runExecutorCommand } from '../../utils/spawn-executor.js';
import { resolveAuthenticatedOpenCodeSubjectContext } from './credential-namespace.js';
import { createOpenCodeExecutorInvocation } from './executor-command.js';

const MODEL_CATALOG_FAILURE = 'OpenCode model catalog could not be loaded. Try again.';

async function readModelCatalog(
  db: TenantScopeAwareDatabase,
  params?: AuthenticatedParams
): Promise<OpenCodeModelCatalog> {
  const config = loadConfigSync();
  const context = await resolveAuthenticatedOpenCodeSubjectContext(db, params, config);
  let result: Awaited<ReturnType<typeof runExecutorCommand>>;
  try {
    result = await runExecutorCommand(
      createOpenCodeExecutorInvocation(context.dataHome, {
        operation: 'read-model-catalog',
      }),
      {
        asUser: context.asUser,
        env: context.executorEnv,
        logPrefix: '[OpenCode Models]',
        templateVariables: { unix_user: context.asUser ?? undefined },
      }
    );
  } catch {
    throw new BadRequest(MODEL_CATALOG_FAILURE);
  }
  if (!result.success || !result.data) {
    throw new BadRequest(MODEL_CATALOG_FAILURE);
  }
  return result.data as OpenCodeModelCatalog;
}

export class OpenCodeModelsService {
  constructor(private readonly db: TenantScopeAwareDatabase) {}

  async find(params?: AuthenticatedParams): Promise<OpenCodeModelCatalog> {
    if (Object.keys(params?.query ?? {}).length > 0) {
      throw new BadRequest('OpenCode model catalog does not accept query parameters.');
    }
    return readModelCatalog(this.db, params);
  }
}

export function createOpenCodeModelsService(db: TenantScopeAwareDatabase) {
  return new OpenCodeModelsService(db);
}

export async function resolveOpenCodeCreateModelFallback(
  db: TenantScopeAwareDatabase,
  params: AuthenticatedParams
) {
  const catalog = await readModelCatalog(db, params);
  const suggestion = catalog.suggestedSelection;
  return suggestion
    ? { mode: 'exact' as const, provider: suggestion.providerId, model: suggestion.modelId }
    : undefined;
}
