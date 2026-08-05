import { resolvePackagedOpenCodeBinary } from '@agor/agentic-tool-opencode/runtime/binary';
import { loadConfigSync } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest } from '@agor/core/feathers';
import type { AuthenticatedParams, OpenCodeModelCatalog } from '@agor/core/types';
import type { ExecutorCommandResult } from '../../utils/spawn-executor.js';
import { resolveAuthenticatedOpenCodeSubjectContext } from './credential-namespace.js';
import { startOpenCodeExecutorInvocation } from './executor-command.js';
import { blockOpenCodeNativeStateNamespace } from './native-state-coordinator.js';

const MODEL_CATALOG_FAILURE = 'OpenCode model catalog could not be loaded. Try again.';

async function readModelCatalog(
  db: TenantScopeAwareDatabase,
  params?: AuthenticatedParams
): Promise<OpenCodeModelCatalog> {
  const config = loadConfigSync();
  const context = await resolveAuthenticatedOpenCodeSubjectContext(db, params, config);
  let result: ExecutorCommandResult;
  try {
    await resolvePackagedOpenCodeBinary();
    const handle = startOpenCodeExecutorInvocation(
      context.dataHome,
      { operation: 'read-model-catalog' },
      {
        asUser: context.asUser,
        env: context.executorEnv,
        logPrefix: '[OpenCode Models]',
        templateVariables: { unix_user: context.asUser ?? undefined },
      }
    );
    result = await handle.result;
    if (result.error?.code === 'EXECUTOR_CLEANUP_UNVERIFIED') {
      await blockOpenCodeNativeStateNamespace(context.namespaceKey, handle);
    }
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
