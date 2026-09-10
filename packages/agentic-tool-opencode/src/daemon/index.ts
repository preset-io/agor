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
import {
  resolveOpenCodeCredentialNamespace,
  resolveOpenCodeTaskCredentialNamespace,
} from './credential-namespace.js';
import { assertOpenCodeExecutionAllowed } from './execution-admission.js';

export {
  type OpenCodeCapabilities,
  type OpenCodeCapabilityConfig,
  OpenCodeUnsupportedError,
  requireOpenCodeMode,
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
    session: Pick<Session, 'created_by' | 'unix_username' | 'session_id' | 'sdk_native_state'>;
    taskId: string;
    homeDir: string;
    config: Pick<AgorConfig, 'execution' | 'multi_tenancy' | 'agentic_tools'>;
  }) {
    if (resolveOpenCodeCapabilities(input.config).mode === 'managed-projection') {
      // Hosted: pass logical identity only. The executor resolves paths under
      // its own home and resumes the accepted checkpoint recorded on the
      // Session by the last completion transition.
      const namespace = resolveOpenCodeCredentialNamespace({
        tenantId: input.tenantId,
        subjectUserId: input.session.created_by,
        homeDir: input.homeDir,
      });
      return {
        namespaceKey: namespace.namespaceKey,
        executorPayload: {
          agenticToolContext: createOpenCodeManagedExecutorContext({
            namespaceKey: namespace.namespaceKey,
            agorSessionId: input.session.session_id,
            taskId: input.taskId,
            accepted: input.session.sdk_native_state ?? null,
          }),
        },
      };
    }
    const namespace = resolveOpenCodeTaskCredentialNamespace(input);
    return {
      namespaceKey: namespace.namespaceKey,
      executorPayload: {
        agenticToolContext: createOpenCodeExecutorContext(namespace.dataHome),
      },
    };
  },
} as const;
