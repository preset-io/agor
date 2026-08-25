import type { RegisterServicesContext } from '../../register-services.js';
import { createOpenCodeAuthService } from './auth-service.js';
import { createOpenCodeModelsService } from './models-service.js';

/** Thin host composition for package-owned OpenCode auth and catalog operations. */
export function registerOpenCodeServices(
  ctx: Pick<RegisterServicesContext, 'app' | 'db' | 'config' | 'requireAuth'>
): void {
  ctx.app.use('/opencode-auth', createOpenCodeAuthService(ctx.db, ctx.config));
  ctx.app.service('/opencode-auth').hooks({ before: { all: [ctx.requireAuth] } });
  ctx.app.service('/opencode-auth').publish(() => []);

  ctx.app.use('/opencode-models', createOpenCodeModelsService(ctx.db, ctx.config));
  ctx.app.service('/opencode-models').hooks({ before: { all: [ctx.requireAuth] } });
  ctx.app.service('/opencode-models').publish(() => []);
}
