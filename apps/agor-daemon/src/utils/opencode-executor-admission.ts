import type { AgorConfig } from '@agor/core/config';
import { NotAuthenticated } from '@agor/core/feathers';
import type { AgenticToolName } from '@agor/core/types';
import { assertOpenCodeNativeAuthSupported } from './opencode-credential-namespace.js';

export async function admitOpenCodeExecutor<T>(
  input: {
    tool: AgenticToolName;
    tenantId: string | undefined;
    config: Pick<AgorConfig, 'multi_tenancy'>;
  },
  admitted: () => Promise<T>
): Promise<T> {
  if (input.tool === 'opencode') {
    if (!input.tenantId) {
      throw new NotAuthenticated('Missing tenant context for OpenCode execution');
    }
    assertOpenCodeNativeAuthSupported(input.config);
  }
  return admitted();
}
