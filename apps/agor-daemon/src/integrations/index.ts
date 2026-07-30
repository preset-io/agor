import type { AgenticToolName } from '@agor/core/types';
import type { RegisterServicesContext } from '../register-services.js';
import { OPENCODE_DAEMON_INTEGRATION } from './opencode/index.js';

interface DaemonAgenticToolIntegration {
  name: AgenticToolName;
  tenantIdentityOnlyServicePaths: readonly string[];
  registerServices(context: Pick<RegisterServicesContext, 'app' | 'db' | 'requireAuth'>): void;
}

const INSTALLED_DAEMON_AGENTIC_TOOL_INTEGRATIONS = [
  OPENCODE_DAEMON_INTEGRATION,
] as const satisfies readonly DaemonAgenticToolIntegration[];

export const AGENTIC_TOOL_TENANT_IDENTITY_ONLY_SERVICE_PATHS =
  INSTALLED_DAEMON_AGENTIC_TOOL_INTEGRATIONS.flatMap(
    (integration) => integration.tenantIdentityOnlyServicePaths
  );

export function registerAgenticToolIntegrationServices(
  context: Pick<RegisterServicesContext, 'app' | 'db' | 'requireAuth'>
): void {
  for (const integration of INSTALLED_DAEMON_AGENTIC_TOOL_INTEGRATIONS) {
    integration.registerServices(context);
  }
}
