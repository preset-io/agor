import { createOpenCodeKnownModelCatalog, OPENCODE_VERSION } from '@agor/agentic-tool-opencode';
import { resolveOpenCodeCapabilities } from '@agor/agentic-tool-opencode/daemon';
import type { AgorConfig } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { BadRequest, NotAuthenticated } from '@agor/core/feathers';
import type { AuthenticatedParams, DeepReadonly, OpenCodeModelCatalog } from '@agor/core/types';
import type { ExecutorCommandResult } from '../../utils/spawn-executor.js';
import {
  resolveAuthenticatedOpenCodeSubjectContext,
  resolveManagedOpenCodeSubject,
} from './credential-namespace.js';
import { startOpenCodeExecutorInvocation } from './executor-command.js';
import { blockOpenCodeNativeStateNamespace } from './native-state-coordinator.js';

const MODEL_CATALOG_FAILURE = 'OpenCode model catalog could not be loaded. Try again.';
const OPEN_CODE_MODEL_STATUSES = new Set(['active', 'alpha', 'beta', 'deprecated']);

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOpenCodeModelCatalog(value: unknown): value is OpenCodeModelCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const catalog = value as Partial<OpenCodeModelCatalog>;
  if (!isString(catalog.runtimeVersion) || !Array.isArray(catalog.providers)) return false;
  if (
    catalog.suggestedSelection !== undefined &&
    (!catalog.suggestedSelection ||
      typeof catalog.suggestedSelection !== 'object' ||
      Array.isArray(catalog.suggestedSelection) ||
      !isString(catalog.suggestedSelection.providerId) ||
      !isString(catalog.suggestedSelection.modelId))
  ) {
    return false;
  }
  return catalog.providers.every(
    (provider) =>
      provider &&
      isString(provider.id) &&
      isString(provider.name) &&
      typeof provider.availableForSelection === 'boolean' &&
      (provider.suggestedModel === undefined || isString(provider.suggestedModel)) &&
      Array.isArray(provider.models) &&
      provider.models.every(
        (model) =>
          model &&
          isString(model.id) &&
          isString(model.name) &&
          OPEN_CODE_MODEL_STATUSES.has(model.status)
      )
  );
}

async function readModelCatalog(
  db: TenantScopeAwareDatabase,
  config: DeepReadonly<AgorConfig>,
  params?: AuthenticatedParams
): Promise<OpenCodeModelCatalog> {
  const context = await resolveAuthenticatedOpenCodeSubjectContext(db, config, params);
  let result: ExecutorCommandResult;
  try {
    const handle = startOpenCodeExecutorInvocation(
      context.dataHome,
      { operation: 'read-model-catalog' },
      {
        env: context.executorEnv,
        logPrefix: '[OpenCode Models]',
      }
    );
    result = await handle.result;
    if (result.error?.code === 'EXECUTOR_CLEANUP_UNVERIFIED') {
      await blockOpenCodeNativeStateNamespace(context.namespaceKey, handle);
    }
  } catch {
    throw new BadRequest(MODEL_CATALOG_FAILURE);
  }
  if (!result.success || !isOpenCodeModelCatalog(result.data)) {
    throw new BadRequest(MODEL_CATALOG_FAILURE);
  }
  return result.data;
}

export class OpenCodeModelsService {
  constructor(
    private readonly db: TenantScopeAwareDatabase,
    private readonly config: DeepReadonly<AgorConfig>
  ) {}

  async find(params?: AuthenticatedParams): Promise<OpenCodeModelCatalog> {
    if (Object.keys(params?.query ?? {}).length > 0) {
      throw new BadRequest('OpenCode model catalog does not accept query parameters.');
    }
    if (!params?.user?.user_id) throw new NotAuthenticated('Sign in before using OpenCode.');
    // Unsupported deployments answer with the known catalog marked unavailable
    // plus the structured reason, so readiness renders a permanent notice
    // instead of retrying an operation that can never succeed here.
    const capabilities = resolveOpenCodeCapabilities(this.config);
    if (capabilities.mode === 'unsupported') {
      const known = createOpenCodeKnownModelCatalog(null);
      return {
        runtimeVersion: OPENCODE_VERSION,
        providers: known.providers.map((provider) => ({
          ...provider,
          availableForSelection: false,
        })),
        unsupported: capabilities.reason,
      };
    }
    if (capabilities.mode === 'managed-projection') {
      // Saved-key presence is the only availability evidence in hosted mode;
      // no executor or OpenCode server is started to read a catalog.
      const subject = await resolveManagedOpenCodeSubject(this.db, params);
      return {
        runtimeVersion: OPENCODE_VERSION,
        ...createOpenCodeKnownModelCatalog(subject.savedProviderIds),
      };
    }
    return readModelCatalog(this.db, this.config, params);
  }
}

export function createOpenCodeModelsService(
  db: TenantScopeAwareDatabase,
  config: DeepReadonly<AgorConfig>
) {
  return new OpenCodeModelsService(db, config);
}
