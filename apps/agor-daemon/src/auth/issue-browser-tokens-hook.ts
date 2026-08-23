import type { SignOptions } from 'jsonwebtoken';
import { issueRuntimeTokenPair, runtimeTenantClaims } from './runtime-tokens.js';
import { authCredentialGenerationClaim, authTokenIssuedAtClaim } from './token-invalidation.js';
import { redactUserAuthMetadata } from './user-redaction.js';

/**
 * JWT payload types that identify machine credentials (executor sockets,
 * service-to-service calls) rather than an interactive browser client.
 */
const MACHINE_TOKEN_TYPES = new Set(['executor-session', 'service']);

export interface IssueBrowserTokensHookOptions {
  jwtSecret: string;
  accessTokenTtl: SignOptions['expiresIn'];
  refreshTokenTtl: SignOptions['expiresIn'];
  tenantClaim: string;
  now?: () => number;
  debug?: (...args: unknown[]) => void;
}

/**
 * After-create hook for the authentication service: replace the strategy's
 * access token with a browser access token and attach a refresh token.
 *
 * Machine-token logins (executor-session / service JWTs) are exempt from the
 * swap. Replacing a machine credential with a browser token would erase its
 * task/terminal scope and shorten the authority represented by the result.
 * Machine logins also must not receive long-lived refresh tokens meant for
 * interactive clients. The Socket.IO namespace normally invokes the strategy
 * directly. The provider guard below is defense in depth: an alternate socket
 * login path must never mint and discard a browser token pair.
 *
 * User redaction applies on every path that returns a user.
 */
export function createIssueBrowserTokensHook(options: IssueBrowserTokensHookOptions) {
  const {
    jwtSecret,
    accessTokenTtl,
    refreshTokenTtl,
    tenantClaim,
    now = Date.now,
    debug,
  } = options;

  // biome-ignore lint/suspicious/noExplicitAny: FeathersJS context type not fully typed
  return async (context: any) => {
    debug?.('✅ Authentication succeeded:', {
      strategy: context.result?.authentication?.strategy,
      hasUser: !!context.result?.user,
      user_id: context.result?.user?.user_id,
      hasAccessToken: !!context.result?.accessToken,
    });

    if (!context.result?.user) {
      return context;
    }

    if (context.params?.provider === 'socketio') {
      context.result.user = redactUserAuthMetadata(context.result.user);
      return context;
    }

    const payloadType = context.result.authentication?.payload?.type;
    if (typeof payloadType === 'string' && MACHINE_TOKEN_TYPES.has(payloadType)) {
      context.result.user = redactUserAuthMetadata(context.result.user);
      return context;
    }

    const tenantId =
      context.params?.tenant?.tenant_id ??
      (context.result.user as { tenant_id?: string }).tenant_id;
    const tokens = issueRuntimeTokenPair(
      context.result.user,
      jwtSecret,
      accessTokenTtl,
      refreshTokenTtl,
      {
        ...authCredentialGenerationClaim(context.result.user),
        ...authTokenIssuedAtClaim(now(), context.result.user),
        ...runtimeTenantClaims(tenantId, tenantClaim),
      }
    );
    context.result.accessToken = tokens.accessToken;
    context.result.refreshToken = tokens.refreshToken;
    context.result.user = redactUserAuthMetadata(context.result.user);
    return context;
  };
}
