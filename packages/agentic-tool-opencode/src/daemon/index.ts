import type { AgorConfig } from '@agor/core/config';
import type { Session } from '@agor/core/types';
import { createOpenCodeExecutorContext } from '../shared/executor-context.js';
import { resolveOpenCodeTaskCredentialNamespace } from './credential-namespace.js';
import { assertOpenCodeExecutionAllowed } from './execution-admission.js';

export {
  assertOpenCodeNativeAuthSupported,
  type OpenCodeCredentialNamespace,
  resolveOpenCodeCredentialNamespace,
  resolveOpenCodeTaskCredentialNamespace,
} from './credential-namespace.js';
export { assertOpenCodeExecutionAllowed } from './execution-admission.js';

export const OPENCODE_DAEMON_CONTRIBUTION = {
  name: 'opencode',
  admitExecutor(input: {
    tenantId: string | undefined;
    config: Pick<AgorConfig, 'multi_tenancy'>;
  }) {
    assertOpenCodeExecutionAllowed(input);
  },
  getExecutorPayload(input: {
    tenantId: string;
    session: Pick<Session, 'created_by' | 'unix_username'>;
    homeDir: string;
  }) {
    return {
      agenticToolContext: createOpenCodeExecutorContext(
        resolveOpenCodeTaskCredentialNamespace(input).dataHome
      ),
    };
  },
} as const;
