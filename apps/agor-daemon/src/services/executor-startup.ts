import {
  type DeploymentAgenticToolPolicy,
  isDeploymentAgenticToolAvailable,
  isTenantAgenticToolEnabled,
} from '@agor/core/config';
import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { AgenticToolName, AuthenticatedParams, Session } from '@agor/core/types';
import type { SessionsServiceImpl } from '../declarations.js';
import { requireActiveAgenticTool } from '../utils/agentic-tool-runtime.js';

type ExecutorStartupSessionsService = Pick<
  SessionsServiceImpl,
  'get' | 'materializeAgenticToolPreset'
>;

export type ActiveExecutorSession = Session & { agentic_tool: AgenticToolName };

/** Load and validate the session state needed before any executor/process work begins. */
export async function prepareSessionForExecutorStart(
  db: TenantScopeAwareDatabase,
  sessionsService: ExecutorStartupSessionsService,
  sessionId: string,
  params: AuthenticatedParams,
  deploymentPolicy: DeploymentAgenticToolPolicy = { managed: false, installed: new Set() }
): Promise<ActiveExecutorSession> {
  const tenantId = getCurrentTenantId();
  if (!tenantId) throw new Error('Missing active tenant context for executor startup');

  return runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
    const session = await sessionsService.get(sessionId, params);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const agenticTool = requireActiveAgenticTool(session.agentic_tool);
    if (!isDeploymentAgenticToolAvailable(agenticTool, deploymentPolicy)) {
      throw new Error(`${agenticTool} is not installed for this deployment`);
    }
    if (!(await isTenantAgenticToolEnabled(agenticTool, tenantDb))) {
      throw new Error(`${agenticTool} is disabled for this workspace`);
    }
    const materializedSession = await sessionsService.materializeAgenticToolPreset(session, params);
    requireActiveAgenticTool(materializedSession.agentic_tool);
    return materializedSession as ActiveExecutorSession;
  });
}
