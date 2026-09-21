import { type RegisterServicesContext, registerMCPServices } from '../../register-services.js';

/** Shared wiring only: each suite still owns its authentication, transport and real authority. */
export async function registerManagedTestServices(
  input: Pick<
    RegisterServicesContext,
    'db' | 'app' | 'config' | 'requireAuth' | 'daemonUrl' | 'mcpManagedOAuthServices'
  > &
    Partial<Pick<RegisterServicesContext, 'bundledUiAvailable'>>
) {
  return registerMCPServices({
    jwtSecret: 'synthetic-registration-test',
    bundledUiAvailable: false,
    DAEMON_PORT: 3030,
    UI_PORT: 5173,
    allowSuperadmin: false,
    deployment: {} as RegisterServicesContext['deployment'],
    mcpOAuthCallbackUrl: `${input.daemonUrl}/mcp-servers/oauth-callback`,
    mcpManagedOAuthRuntime: input.mcpManagedOAuthServices?.runtime,
    mcpOAuthPendingFlowAuthority: input.mcpManagedOAuthServices?.flows,
    ...input,
  });
}
