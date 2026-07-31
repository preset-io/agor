import { OPENCODE_DAEMON_CONTRIBUTION } from '@agor/agentic-tool-opencode/daemon';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import type { AuthenticatedParams, UserID } from '@agor/core/types';
import type { RegisterServicesContext } from '../../register-services.js';

export { createOpenCodeAuthService } from './auth-service.js';
export {
  createOpenCodeModelsService,
  resolveOpenCodeCreateModelFallback,
} from './models-service.js';

import { createOpenCodeAuthService } from './auth-service.js';
import {
  createOpenCodeModelsService,
  resolveOpenCodeCreateModelFallback,
} from './models-service.js';

export const OPENCODE_DAEMON_INTEGRATION = {
  ...OPENCODE_DAEMON_CONTRIBUTION,
  tenantIdentityOnlyServicePaths: ['opencode-auth', 'opencode-models'],
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

    ctx.app.use('/opencode-models', createOpenCodeModelsService(ctx.db), {
      methods: ['find'],
    });
    ctx.app.service('/opencode-models').hooks({ before: { all: [ctx.requireAuth] } });
    ctx.app.service('/opencode-models').publish(() => []);
  },
} as const;
