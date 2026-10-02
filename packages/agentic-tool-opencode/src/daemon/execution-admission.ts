import type { AgorConfig } from '@agor/core/config';
import { Forbidden, NotAuthenticated } from '@agor/core/feathers';
import type { SessionSdkHomeScope } from '@agor/core/types';
import { requireOpenCodeSupported } from './capabilities.js';

export function assertOpenCodeExecutionAllowed(input: {
  tenantId: string | undefined;
  config: Pick<AgorConfig, 'execution' | 'multi_tenancy' | 'agentic_tools'>;
  sessionOwnerId: string;
  sessionSdkHomeScope: SessionSdkHomeScope;
  prompterUserId: string | undefined;
}): void {
  if (!input.tenantId) {
    throw new NotAuthenticated('Missing tenant context for OpenCode execution');
  }
  const capabilities = requireOpenCodeSupported(input.config);
  // Hosted branch-home Sessions hold only conversation state; session prompt authority admitted the caller.
  const shared =
    capabilities.mode === 'managed-projection' && input.sessionSdkHomeScope === 'branch';
  if (!input.prompterUserId || (!shared && input.prompterUserId !== input.sessionOwnerId)) {
    throw new Forbidden('Only the OpenCode session owner can prompt this session.');
  }
}
