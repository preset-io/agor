import { isTenantAgenticToolEnabled } from '@agor/core/config';
import {
  getCurrentTenantId,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { AuthenticatedParams, Session } from '@agor/core/types';
import type { SessionsServiceImpl } from '../declarations.js';

type ExecutorStartupSessionsService = Pick<
  SessionsServiceImpl,
  'get' | 'materializeAgenticToolPreset'
>;

/** Load and validate the session state needed before any executor/process work begins. */
export async function prepareSessionForExecutorStart(
  db: TenantScopeAwareDatabase,
  sessionsService: ExecutorStartupSessionsService,
  sessionId: string,
  params: AuthenticatedParams
): Promise<Session> {
  const tenantId = getCurrentTenantId();
  if (!tenantId) throw new Error('Missing active tenant context for executor startup');

  return runWithTenantDatabaseScope(db, tenantId, async (tenantDb) => {
    const session = await sessionsService.get(sessionId, params);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (!(await isTenantAgenticToolEnabled(session.agentic_tool, tenantDb))) {
      throw new Error(`${session.agentic_tool} is disabled for this workspace`);
    }
    return sessionsService.materializeAgenticToolPreset(session, params);
  });
}
