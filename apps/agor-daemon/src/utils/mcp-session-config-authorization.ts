import { Forbidden } from '@agor/core/feathers';
import type { Session } from '@agor/core/types';
import type { TaskExecutorRuntimeScope } from '../auth/executor-runtime-scope.js';
import { checkSessionOwnerOrAdmin } from './branch-authorization.js';

/**
 * Authorize one session-scoped MCP configuration operation.
 *
 * An executor delegation is projection-only. Even when it names the exact
 * Session, it cannot attach, detach, initialize, or otherwise mutate MCP
 * configuration. Non-executor internal service accounts retain their existing
 * narrow daemon authority.
 */
export function authorizeMcpSessionConfigAccess(options: {
  user: { user_id?: string; role?: string; _isServiceAccount?: boolean };
  session: Pick<Session, 'session_id' | 'created_by'>;
  executorScope: TaskExecutorRuntimeScope | null;
  operation: 'projection' | 'mutation';
  allowSuperadmin?: boolean;
}): void {
  const { user, session, executorScope, operation, allowSuperadmin } = options;
  if (executorScope) {
    if (operation === 'projection' && executorScope.sessionId === session.session_id) return;
    throw new Forbidden(
      operation === 'mutation'
        ? 'Task executor credentials cannot mutate MCP session configuration'
        : 'Task executor credentials can project MCP configuration only for their exact Session'
    );
  }
  checkSessionOwnerOrAdmin(user, session, { allowSuperadmin });
}
