import { OPENCODE_DAEMON_CONTRIBUTION } from '@agor/agentic-tool-opencode/daemon';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import type { AuthenticatedParams, UserID } from '@agor/core/types';
import type { RegisterServicesContext } from '../../register-services.js';

export { createOpenCodeAuthService, resolveOpenCodeCreateModelFallback } from './auth-service.js';

import { createOpenCodeAuthService, resolveOpenCodeCreateModelFallback } from './auth-service.js';

export const OPENCODE_DAEMON_INTEGRATION = {
  ...OPENCODE_DAEMON_CONTRIBUTION,
  tenantIdentityOnlyServicePaths: ['opencode-auth'],
  resolveCreateModelFallback(input: {
    db: TenantScopeAwareDatabase;
    branchId: string;
    executionOwnerId: UserID;
    params: AuthenticatedParams;
  }) {
    if (input.params.user?.user_id !== input.executionOwnerId) return Promise.resolve(undefined);
    return resolveOpenCodeCreateModelFallback(input.db, input.params, input.branchId);
  },
  registerServices(ctx: Pick<RegisterServicesContext, 'app' | 'db' | 'requireAuth'>) {
    ctx.app.use('/opencode-auth', createOpenCodeAuthService(ctx.db));
    ctx.app.service('/opencode-auth').hooks({ before: { all: [ctx.requireAuth] } });
    ctx.app.service('/opencode-auth').publish(() => []);
  },
} as const;
