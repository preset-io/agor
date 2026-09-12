import {
  type BranchWorkspaceConfig,
  type DeploymentAgenticToolPolicy,
  isDeploymentAgenticToolAvailable,
  isTenantAgenticToolEnabled,
  usesReplicatedWorkspace,
} from '@agor/core/config';
import {
  BranchWorkspaceRepository,
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import type {
  AgenticToolName,
  AuthenticatedParams,
  BranchID,
  Session,
  TenantID,
} from '@agor/core/types';
import { assertNativeWorkspaceAdmission } from '../branch-workspace-admission.js';
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
 * Supplied only in `delegated` mode, where an execution-home Session's
 * `unix_username` is the opaque home key forwarded to the external substrate.
 * Branch-home Sessions skip the creator check and resolve the current actor's
 * key later. Local modes omit the guard and pay no lookup.
 *
 * `loadCreator` receives the tenant-scoped handle this startup opened, so the
 * creator read cannot escape the session's tenant.
 */
export interface ExecutorStartupUnixIdentityGuard {
  loadCreator: (tenantDb: TenantScopedDatabase) => SessionCreatorLoader;
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
  unixIdentityGuard?: ExecutorStartupUnixIdentityGuard,
  workspaceConfig?: BranchWorkspaceConfig
): Promise<ActiveExecutorSession> {
  const tenantId = getCurrentTenantId();
  if (!tenantId) throw new Error('Missing active tenant context for executor startup');

  return runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
    const session = await sessionsService.get(sessionId, params);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    // Only historical execution-home sessions resume through the creator's
    // immutable home stamp. Branch-scoped sessions use the current prompt
    // actor's delegated key and branch-owned SDK state, so creator drift is
    // irrelevant and must not prevent legitimate branch sharing.
    if (unixIdentityGuard && (session.sdk_home_scope ?? 'execution_home') === 'execution_home') {
      await assertSessionUnixIdentityUnchanged(session, unixIdentityGuard.loadCreator(tenantDb));
    }
    const replicatedRequired =
      workspaceConfig?.native_adapter === 'claude_workspace' &&
      !!session.branch_id &&
      usesReplicatedWorkspace(workspaceConfig, tenantId, session.branch_id);
    if (session.branch_id) {
      const workspace = await new BranchWorkspaceRepository(tenantDb, {
        tenantId: tenantId as TenantID,
        branchId: session.branch_id as BranchID,
      }).read();
      if (replicatedRequired) {
        if (session.agentic_tool !== 'claude-code')
          throw new Error(
            'This branch requires the Claude replicated workspace adapter; legacy execution is refused'
          );
        if (workspace.state && workspace.state.authority !== 'worker-sql')
          throw new Error('Existing workspace authority requires explicit migration');
        if (!workspace.state)
          await new BranchWorkspaceRepository(tenantDb, {
            tenantId: tenantId as TenantID,
            branchId: session.branch_id as BranchID,
          }).mutate((state, now) => ({
            state: state ?? {
              schema: 1,
              authority: 'worker-sql',
              scope: { tenantId: tenantId as TenantID, branchId: session.branch_id as BranchID },
              revision: 0,
              epoch: 0,
              host: null,
              leaseUntil: 0,
              tree: {},
              versions: {},
              active: {},
              receipts: {},
              updatedAt: now,
            },
            result: undefined,
          }));
      } else {
        assertNativeWorkspaceAdmission({
          config: {},
          tenantId,
          branchId: session.branch_id,
          state: workspace.state,
        });
      }
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
