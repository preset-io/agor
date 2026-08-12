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
import {
  assertSessionUnixIdentityUnchanged,
  type SessionCreatorLoader,
} from '../utils/branch-authorization.js';

type ExecutorStartupSessionsService = Pick<
  SessionsServiceImpl,
  'get' | 'materializeAgenticToolPreset'
>;

export type ActiveExecutorSession = Session & { agentic_tool: AgenticToolName };

/**
 * Supplied only by the Unix modes that make `session.unix_username` the OS
 * identity of the executor (`delegated`/`strict`). Omitted otherwise, so a
 * deployment that never impersonates per user pays no lookup.
 */
export interface ExecutorStartupUnixIdentityGuard {
  loadCreator: SessionCreatorLoader;
}

/**
 * Load and validate the session state needed before any executor/process work begins.
 *
 * This is the funnel every executor launch passes through: `/sessions/:id/prompt`,
 * the queue drainer, `/tasks/:id/run`, gateway and scheduled prompts all arrive
 * here via `SessionsService.executeTask`. The transport guards on
 * `messages.create` / `tasks.create` refuse a drifted `unix_username` earlier
 * and with a better error, but they do not cover every launch — the prompt
 * route admits its Task through the repository and treats the initial-message
 * write as best-effort — so the identity the executor is about to assume is
 * re-checked here, where it is about to be used.
 */
export async function prepareSessionForExecutorStart(
  db: TenantScopeAwareDatabase,
  sessionsService: ExecutorStartupSessionsService,
  sessionId: string,
  params: AuthenticatedParams,
  deploymentPolicy: DeploymentAgenticToolPolicy = { managed: false, installed: new Set() },
  unixIdentityGuard?: ExecutorStartupUnixIdentityGuard
): Promise<ActiveExecutorSession> {
  const tenantId = getCurrentTenantId();
  if (!tenantId) throw new Error('Missing active tenant context for executor startup');

  return runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
    const session = await sessionsService.get(sessionId, params);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (unixIdentityGuard) {
      await assertSessionUnixIdentityUnchanged(session, unixIdentityGuard.loadCreator);
    }
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
