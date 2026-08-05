import type { AgorConfig } from '@agor/core/config';
import { BadRequest, Forbidden, NotAuthenticated } from '@agor/core/feathers';
import { assertOpenCodeNativeAuthSupported } from './credential-namespace.js';

export function assertOpenCodeExecutionAllowed(input: {
  tenantId: string | undefined;
  config: Pick<AgorConfig, 'execution' | 'multi_tenancy'>;
  sessionOwnerId: string;
  prompterUserId: string | undefined;
}): void {
  if (!input.tenantId) {
    throw new NotAuthenticated('Missing tenant context for OpenCode execution');
  }
  assertOpenCodeNativeAuthSupported(input.config);
  if (!input.prompterUserId || input.prompterUserId !== input.sessionOwnerId) {
    throw new Forbidden('Only the OpenCode session owner can prompt this session.');
  }
  if (input.config.execution?.executor_command_template) {
    throw new BadRequest('OpenCode execution requires a locally containable executor process.');
  }
}
