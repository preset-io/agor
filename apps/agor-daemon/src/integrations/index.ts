import type { AgorConfig } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import type { ModelConfigInput } from '@agor/core/models';
import type { AgenticToolName, AuthenticatedParams, Session, UserID } from '@agor/core/types';
import type { RegisterServicesContext } from '../register-services.js';
import { OPENCODE_DAEMON_INTEGRATION } from './opencode/index.js';

interface DaemonAgenticToolIntegration {
  name: AgenticToolName;
  tenantIdentityOnlyServicePaths: readonly string[];
  admitExecutor?(input: {
    tenantId: string | undefined;
    config: Pick<AgorConfig, 'execution' | 'multi_tenancy'>;
  }): void;
  getExecutorPayload?(input: {
    tenantId: string;
    session: Pick<Session, 'created_by' | 'unix_username'>;
    homeDir: string;
  }): Record<string, unknown>;
  resolveCreateModelFallback?(input: {
    db: TenantScopeAwareDatabase;
    branchId: string;
    executionOwnerId: UserID;
    params: AuthenticatedParams;
  }): Promise<ModelConfigInput | undefined>;
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

export async function admitAgenticToolExecutor<T>(
  input: {
    tool: AgenticToolName;
    tenantId: string | undefined;
    config: Pick<AgorConfig, 'execution' | 'multi_tenancy'>;
  },
  admitted: () => Promise<T>
): Promise<T> {
  INSTALLED_DAEMON_AGENTIC_TOOL_INTEGRATIONS.find(
    (integration) => integration.name === input.tool
  )?.admitExecutor?.({ tenantId: input.tenantId, config: input.config });
  return admitted();
}

export function getAgenticToolExecutorPayload(
  tool: AgenticToolName,
  input: {
    tenantId: string;
    session: Pick<Session, 'created_by' | 'unix_username'>;
    homeDir: string;
  }
): Record<string, unknown> {
  return (
    INSTALLED_DAEMON_AGENTIC_TOOL_INTEGRATIONS.find(
      (integration) => integration.name === tool
    )?.getExecutorPayload?.(input) ?? {}
  );
}

export async function resolveAgenticToolCreateModelFallback(input: {
  tool: AgenticToolName;
  db: TenantScopeAwareDatabase;
  branchId: string;
  executionOwnerId: UserID;
  params: AuthenticatedParams;
}): Promise<ModelConfigInput | undefined> {
  return INSTALLED_DAEMON_AGENTIC_TOOL_INTEGRATIONS.find(
    (integration) => integration.name === input.tool
  )?.resolveCreateModelFallback?.(input);
}
