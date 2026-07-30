import type { RegisterServicesContext } from '../../register-services.js';

export { createOpenCodeAuthService } from './auth-service.js';
export { createOpenCodeModelsService } from './models-service.js';

import { createOpenCodeAuthService } from './auth-service.js';
import { createOpenCodeModelsService } from './models-service.js';

export const OPENCODE_DAEMON_INTEGRATION = {
  name: 'opencode',
  tenantIdentityOnlyServicePaths: ['opencode-auth', 'opencode-models'],
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
