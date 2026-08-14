import type { BranchRepository, SessionRepository } from '@agor/core/db';
import { BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import type { AuthenticatedParams, Message, SessionID, UUID } from '@agor/core/types';
import { resolveSessionPromptAccess } from './branch-authorization.js';

/**
 * Bulk writes are for importing one bounded Session transcript. Keeping the
 * batch single-Session makes the authorization decision atomic and prevents a
 * partially authorized multi-Session import from becoming a confused deputy.
 */
export const MAX_MESSAGE_BULK_ROWS = 1_000;

export async function authorizeMessageBulkCreate(
  data: unknown,
  params: AuthenticatedParams,
  deps: {
    branchRbacEnabled: boolean;
    allowSuperadmin: boolean;
    sessionsRepository: Pick<SessionRepository, 'findById'>;
    branchRepository: Pick<BranchRepository, 'findById' | 'isOwner' | 'resolveUserPermission'>;
  }
): Promise<Message[]> {
  if (!Array.isArray(data) || data.length === 0) {
    throw new BadRequest('Message bulk create requires a non-empty array');
  }
  if (data.length > MAX_MESSAGE_BULK_ROWS) {
    throw new BadRequest(`Message bulk create is limited to ${MAX_MESSAGE_BULK_ROWS} rows`);
  }

  const records = data as Array<Partial<Message>>;
  const sessionIds = new Set<string>();
  for (const record of records) {
    if (!record || typeof record !== 'object' || typeof record.session_id !== 'string') {
      throw new BadRequest('Every bulk Message must include a session_id');
    }
    sessionIds.add(record.session_id);
  }
  if (sessionIds.size !== 1) {
    throw new BadRequest('All Messages in a bulk request must belong to one Session');
  }

  const sessionId = [...sessionIds][0] as SessionID;
  // Tenant ownership is not RBAC. Always resolve the derived parent inside
  // the trusted tenant scope, even when branch authorization is disabled or
  // the caller is an internal/executor identity. The repository repeats this
  // invariant so normal create and every internal call are covered too.
  const session = await deps.sessionsRepository.findById(sessionId);
  if (!session) throw new NotFound('Session not found');

  // Match the normal Message create hook: trusted internal calls and scoped
  // executor service accounts are not subject to branch RBAC. The executor
  // scope guard still validates every batch row before this handler runs.
  if (!deps.branchRbacEnabled || !params.provider || params.user?._isServiceAccount === true) {
    return records as Message[];
  }

  const userId = params.user?.user_id as UUID | undefined;
  if (!userId) throw new Forbidden('Authentication required to create messages');

  const branch = await deps.branchRepository.findById(session.branch_id);
  if (!branch) throw new NotFound('Branch not found');

  const [isOwner, branchPermission] = await Promise.all([
    deps.branchRepository.isOwner(branch.branch_id, userId),
    deps.branchRepository.resolveUserPermission(branch, userId),
  ]);
  const { allowed, effectiveLevel } = resolveSessionPromptAccess({
    branch,
    session,
    userId,
    isOwner,
    userRole: params.user?.role,
    allowSuperadmin: deps.allowSuperadmin,
    branchPermission,
  });
  if (!allowed) {
    throw new Forbidden(
      `You have '${effectiveLevel}' permission on this branch, which does not allow creating Messages in this Session`
    );
  }

  return records as Message[];
}
