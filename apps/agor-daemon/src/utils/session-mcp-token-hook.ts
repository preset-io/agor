import type { AgorConfig } from '@agor/core/config';
import type { Application } from '@agor/core/feathers';
import type { AuthenticatedParams, HookContext, Session, UserID } from '@agor/core/types';
import { generateSessionToken } from '../mcp/tokens.js';
import { canReceiveMcpTokenForSession } from './mcp-token-authorization.js';

export interface SessionMcpTokenHookOptions {
  app: Application;
  config: AgorConfig;
  onAttached?: (session: Session) => void;
}

export interface SessionMcpTokenAfterHooksOptions
  extends Omit<SessionMcpTokenHookOptions, 'onAttached'> {
  onGetAttached?: (session: Session) => void;
  onCreateAttached?: (session: Session) => void;
}

/**
 * Build the shared sessions after:get / after:create MCP-token hook.
 *
 * Token issuance owns tenant binding semantics; this hook owns only caller
 * authorization and response enrichment. Keeping both session paths on this
 * function prevents request and background fetch behavior from drifting.
 */
export function createSessionMcpTokenHook(options: SessionMcpTokenHookOptions) {
  return async (context: HookContext): Promise<HookContext> => {
    if (options.config.daemon?.mcpEnabled === false) return context;

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

    const session = context.result as Session;
    const mcpToken = await generateSessionToken(options.app, session.session_id, userId as UserID);

    context.result = { ...session, mcp_token: mcpToken };
    options.onAttached?.(session);
    return context;
  };
}

/**
 * Build the paired hooks registered on the sessions service.
 *
 * Keeping the method mapping beside the shared hook implementation makes it
 * harder for create/get behavior to drift and gives integration tests one
 * canonical registration shape to exercise through Feathers.
 */
export function createSessionMcpTokenAfterHooks(options: SessionMcpTokenAfterHooksOptions) {
  return {
    get: createSessionMcpTokenHook({
      app: options.app,
      config: options.config,
      onAttached: options.onGetAttached,
    }),
    create: createSessionMcpTokenHook({
      app: options.app,
      config: options.config,
      onAttached: options.onCreateAttached,
    }),
  };
}
