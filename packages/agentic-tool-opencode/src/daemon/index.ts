import type { AgorConfig } from '@agor/core/config';
import { BadRequest } from '@agor/core/feathers';
import type { Session } from '@agor/core/types';
import {
  createOpenCodeExecutorContext,
  createOpenCodeManagedExecutorContext,
} from '../shared/executor-context.js';
import {
  hasCompleteOpenCodeModelConfig,
  OPENCODE_MODEL_CONFIG_PAIR_ERROR,
} from '../shared/index.js';
import { resolveOpenCodeCapabilities } from './capabilities.js';
import { resolveOpenCodeTaskCredentialNamespace } from './credential-namespace.js';
import { assertOpenCodeExecutionAllowed } from './execution-admission.js';

export {
  type OpenCodeCapabilities,
  type OpenCodeCapabilityConfig,
  OpenCodeUnsupportedError,
  requireOpenCodeSupported,
  resolveOpenCodeCapabilities,
} from './capabilities.js';
export {
  assertOpenCodeNativeAuthSupported,
  type OpenCodeCredentialNamespace,
  type OpenCodeNativeUnixUserMode,
  resolveOpenCodeCredentialNamespace,
  resolveOpenCodeTaskCredentialNamespace,
} from './credential-namespace.js';
export { assertOpenCodeExecutionAllowed } from './execution-admission.js';
export {
  hostedOpenCodeModelCatalog,
  hostedOpenCodeProviderDiscovery,
  isHostedOpenCodeProvider,
} from './hosted-providers.js';

export const OPENCODE_DAEMON_CONTRIBUTION = {
  name: 'opencode',
  admitExecutor(input: {
    tenantId: string | undefined;
    config: Pick<AgorConfig, 'execution' | 'multi_tenancy' | 'agentic_tools'>;
    modelConfig?: Pick<NonNullable<Session['model_config']>, 'provider' | 'model'>;
    sessionOwnerId: string;
    prompterUserId: string | undefined;
  }) {
    assertOpenCodeExecutionAllowed(input);
    if (!hasCompleteOpenCodeModelConfig(input.modelConfig)) {
      throw new BadRequest(OPENCODE_MODEL_CONFIG_PAIR_ERROR);
    }
  },
  getExecutorLaunch(input: {
    tenantId: string;
    session: Pick<Session, 'created_by' | 'unix_username' | 'session_id'>;
    taskId: string;
    homeDir: string;
    config: Pick<AgorConfig, 'execution' | 'multi_tenancy' | 'agentic_tools'>;
  }):
    | { requiresLocalContainment: true; namespaceKey: string; executorPayload: object }
    | { requiresLocalContainment: false; executorPayload: object } {
    if (resolveOpenCodeCapabilities(input.config).mode === 'managed-projection') {
      // Hosted: native state lives in the owner's executor home, so no daemon fence applies.
      return {
        requiresLocalContainment: false,
        executorPayload: {
          agenticToolContext: createOpenCodeManagedExecutorContext(
            input.session.session_id,
            input.taskId
          ),
        },
      };
    }
    const namespace = resolveOpenCodeTaskCredentialNamespace(input);
    return {
      requiresLocalContainment: true,
      namespaceKey: namespace.namespaceKey,
      executorPayload: {
        agenticToolContext: createOpenCodeExecutorContext(namespace.dataHome),
      },
    };
  },
} as const;
