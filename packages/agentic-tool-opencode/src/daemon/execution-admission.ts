import type { AgorConfig } from '@agor/core/config';
import { NotAuthenticated } from '@agor/core/feathers';
import { assertOpenCodeNativeAuthSupported } from './credential-namespace.js';

export function assertOpenCodeExecutionAllowed(input: {
  tenantId: string | undefined;
  config: Pick<AgorConfig, 'execution' | 'multi_tenancy'>;
}): void {
  if (!input.tenantId) {
    throw new NotAuthenticated('Missing tenant context for OpenCode execution');
  }
  assertOpenCodeNativeAuthSupported(input.config);
}
