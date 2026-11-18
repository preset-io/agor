import type { AgorConfig } from '@agor/core/config';
import { type Application, NotAuthenticated, Unavailable } from '@agor/core/feathers';
import type { AuthenticatedParams, HookContext, Session, TaskID, UserID } from '@agor/core/types';
import { authenticatedTaskExecutorRuntimeScope } from '../auth/executor-runtime-scope.js';
import {
  isTenantRestrictedRejection,
  readAdmittedTenantRestriction,
} from '../auth/tenant-access.js';
import { hasTerminationReadAuthority } from '../auth/termination-read-authority.js';
import { generateSessionToken } from '../mcp/tokens.js';
import { canReceiveMcpTokenForSession } from './mcp-token-authorization.js';

const NO_MCP_TOKEN = Symbol('no-mcp-token');

/** Server-side reads that never hand the session to an agent keep the caller's provider and auth but mint no MCP token. */
export function withoutSessionMcpToken<P extends object>(params: P): P {
  return { ...params, [NO_MCP_TOKEN]: true };
}

export function skipsSessionMcpToken(params: object | undefined): boolean {
  return (params as { [NO_MCP_TOKEN]?: true } | undefined)?.[NO_MCP_TOKEN] === true;
}

export interface SessionMcpTokenHookOptions {
  app: Application;
  config: AgorConfig;
  onAttached?: (session: Session) => void;
}

/**
 * Build the sessions after:get MCP-token hook.
 *
 * Token issuance owns tenant binding semantics; this hook owns only caller
 * authorization and response enrichment. Only a task executor reading its own
 * session receives a token, bound to its task, so it stops authenticating once
 * the task's executor is done. Browser, CLI and API callers never receive one.
 */
export function createSessionMcpTokenHook(options: SessionMcpTokenHookOptions) {
  return async (context: HookContext): Promise<HookContext> => {
    if (options.config.daemon?.mcpEnabled === false) return context;
    if (skipsSessionMcpToken(context.params)) return context;

    // Internal re-reads may carry an executor's params, and their results can be broadcast.
    if (!context.params.provider) return context;
    const session = context.result as Session;
    // Only a task executor reading its own session receives a token, bound to that task.
    const scope = authenticatedTaskExecutorRuntimeScope(context.params);
    if (!scope || scope.sessionId !== session.session_id) return context;
    const taskId = scope.taskId as TaskID;

    const callerUser = (context.params as AuthenticatedParams).user;
    if (
      !canReceiveMcpTokenForSession({
        callerUserId: callerUser?.user_id,
        callerRole: callerUser?.role,
      })
    ) {
      return context;
    }

    const userId = callerUser?.user_id;
    if (!userId) return context;

    if (!options.app.settings.authentication?.secret) {
      console.error('❌ JWT secret not configured - cannot generate MCP token');
      return context;
    }

    const { authentication } = context.params;
    let mcpToken: string;
    try {
      mcpToken = await generateSessionToken(
        options.app,
        session.session_id,
        userId as UserID,
        taskId,
        readAdmittedTenantRestriction,
        authentication?.strategy === 'jwt' ? { payload: authentication.payload } : undefined
      );
    } catch (error) {
      // A closed tenant mints no MCP credential; the session read itself still succeeds.
      if (isTenantRestrictedRejection(error)) return context;
      if (!(error instanceof Unavailable) && !(error instanceof NotAuthenticated)) throw error;
      // A failed read (codeless 503) fails only an executor get visibly, so no agent starts without MCP; create and termination reads go on without a token.
      if (context.method !== 'get' || hasTerminationReadAuthority(context)) return context;
      // A credential whose generation moved mid-request answers 401, like /mcp does.
      if (error instanceof NotAuthenticated) throw error;
      throw new Unavailable('Tenant access cannot be verified');
    }

    context.result = { ...session, mcp_token: mcpToken };
    options.onAttached?.(session);
    return context;
  };
}
