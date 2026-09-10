import type { AgorConfig } from '@agor/core/config';
import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import { requireOpenCodeMode, resolveOpenCodeCapabilities } from './capabilities.js';

export function assertOpenCodeExecutionAllowed(input: {
  tenantId: string | undefined;
  config: Pick<AgorConfig, 'execution' | 'multi_tenancy' | 'agentic_tools'>;
  sessionOwnerId: string;
  prompterUserId: string | undefined;
}): void {
  if (!input.tenantId) {
    throw new NotAuthenticated('Missing tenant context for OpenCode execution');
  }
  // Execution admits only the modes whose launch path exists in this build;
  // the resolver reports every other topology with a structured reason.
  requireOpenCodeMode(
    resolveOpenCodeCapabilities(input.config),
    ['native-file', 'managed-projection'],
    'execution'
  );
  if (!input.prompterUserId || input.prompterUserId !== input.sessionOwnerId) {
    throw new Forbidden('Only the OpenCode session owner can prompt this session.');
  }
}
