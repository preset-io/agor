import type { AgorConfig } from '@agor/core/config';
import { BadRequest } from '@agor/core/feathers';
import type { Session } from '@agor/core/types';
import { createOpenCodeExecutorContext } from '../shared/executor-context.js';
import {
  hasCompleteOpenCodeModelConfig,
  OPENCODE_MODEL_CONFIG_PAIR_ERROR,
} from '../shared/index.js';
import { resolveOpenCodeTaskCredentialNamespace } from './credential-namespace.js';
import { assertOpenCodeExecutionAllowed } from './execution-admission.js';

export {
  assertOpenCodeNativeAuthSupported,
  type OpenCodeCredentialNamespace,
  type OpenCodeNativeUnixUserMode,
  resolveOpenCodeCredentialNamespace,
  resolveOpenCodeTaskCredentialNamespace,
} from './credential-namespace.js';
export { assertOpenCodeExecutionAllowed } from './execution-admission.js';

export const OPENCODE_DAEMON_CONTRIBUTION = {
  name: 'opencode',
  admitExecutor(input: {
    tenantId: string | undefined;
    config: Pick<AgorConfig, 'execution' | 'multi_tenancy'>;
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
    session: Pick<Session, 'created_by' | 'unix_username'>;
    homeDir: string;
  }) {
    const namespace = resolveOpenCodeTaskCredentialNamespace(input);
    return {
      namespaceKey: namespace.namespaceKey,
      executorPayload: {
        agenticToolContext: createOpenCodeExecutorContext(namespace.dataHome),
      },
    };
  },
} as const;
