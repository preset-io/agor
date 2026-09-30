import type { AgorConfig } from '@agor/core/config';
import { type Application, NotAuthenticated, Unavailable } from '@agor/core/feathers';
import type { AuthenticatedParams, HookContext, Session, UserID } from '@agor/core/types';
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
    if (skipsSessionMcpToken(context.params)) return context;

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
    let mcpToken: string;
    try {
      mcpToken = await generateSessionToken(
        options.app,
        session.session_id,
        userId as UserID,
        readAdmittedTenantRestriction
      );
    } catch (error) {
      // A closed tenant mints no MCP credential; the session read itself still succeeds.
      if (isTenantRestrictedRejection(error)) return context;
      if (!(error instanceof NotAuthenticated)) throw error;
      // A failed read (codeless 401) fails only a transport get visibly (503), so no agent starts without MCP; internal, create and termination reads go on without a token.
      if (
        context.method !== 'get' ||
        !context.params.provider ||
        hasTerminationReadAuthority(context)
      )
        return context;
      throw new Unavailable('Tenant access cannot be verified');
    }

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
