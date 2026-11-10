import { analyticsLogger } from '@agor/core/analytics';
import { runWithTenantContext } from '@agor/core/db';
import { NotAuthenticated } from '@agor/core/feathers';
import { PRODUCT_ANALYTICS_EVENTS } from '@agor/core/types';
import type { SignOptions } from 'jsonwebtoken';
import { issueRuntimeTokenPair, runtimeTenantClaims } from './runtime-tokens.js';
import {
  continueBrowserSession,
  readLaunchSubject,
  startBrowserSession,
} from './session-lifetime.js';
import {
  authCredentialGenerationClaim,
  authTokenIssuedAtClaim,
  type UserAuthTokenPayload,
} from './token-invalidation.js';
import { redactUserAuthMetadata } from './user-redaction.js';

/**
 * JWT payload types that identify machine credentials (executor sockets,
 * service-to-service calls) rather than an interactive browser client.
 */
const MACHINE_TOKEN_TYPES = new Set(['executor-session', 'service']);

export interface IssueBrowserTokensHookOptions {
  jwtSecret: string;
  accessTokenTtl: SignOptions['expiresIn'];
  refreshTokenTtl: number;
  /** Absolute lifetime in seconds of a launched session, counted from the launch. */
  sessionMaxLifetimeSeconds: number;
  /** Set when refresh revalidates launched sessions: JWT re-auth never extends any access token. */
  pinReauthenticatedAccessExpiry?: boolean;
  tenantClaim: string;
  /** Only set for a configured static-tenant deployment. Never a Cloud fallback. */
  staticTenantId?: string;
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
    sessionMaxLifetimeSeconds,
    pinReauthenticatedAccessExpiry = false,
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
    // Where refresh revalidates membership, re-auth must not turn an impersonation token into a refreshable session.
    const impersonated =
      pinReauthenticatedAccessExpiry &&
      context.result.authentication?.payload?.is_impersonated === true;
    if ((typeof payloadType === 'string' && MACHINE_TOKEN_TYPES.has(payloadType)) || impersonated) {
      context.result.user = redactUserAuthMetadata(context.result.user);
      return context;
    }

    const tenantId =
      context.params?.tenant?.tenant_id ??
      (context.result.user as { tenant_id?: string }).tenant_id;
    const nowMs = now();
    // JWT re-authentication continues the presented session. A launched session, or any
    // session where refresh revalidates membership, never gets a later access-token expiry,
    // so chaining re-auth can't stand in for a refresh.
    const presented = context.result.authentication?.payload as UserAuthTokenPayload | undefined;
    const reauthenticating = context.result.authentication?.strategy === 'jwt';
    const pinAccessExpiry =
      reauthenticating && (pinReauthenticatedAccessExpiry || !!readLaunchSubject(presented));
    if (pinAccessExpiry && typeof presented?.exp !== 'number') {
      throw new NotAuthenticated('Session expired, please login again');
    }
    const session = reauthenticating
      ? continueBrowserSession(presented, sessionMaxLifetimeSeconds, nowMs)
      : startBrowserSession(sessionMaxLifetimeSeconds, { nowMs });
    const tokens = issueRuntimeTokenPair(
      context.result.user,
      jwtSecret,
      accessTokenTtl,
      refreshTokenTtl,
      {
        ...authCredentialGenerationClaim(context.result.user),
        ...authTokenIssuedAtClaim(nowMs, context.result.user),
        ...runtimeTenantClaims(tenantId, tenantClaim),
        ...session.claims,
      },
      {
        notAfterSeconds: session.notAfterSeconds,
        ...(pinAccessExpiry ? { accessNotAfterSeconds: presented?.exp } : {}),
      }
    );
    context.result.accessToken = tokens.accessToken;
    context.result.refreshToken = tokens.refreshToken;
    // Only a fresh password login, never JWT revalidation, API keys, or sockets.
    // This tenant is the same trusted identity used for the newly issued tokens.
    const analyticsTenantId = tenantId ?? options.staticTenantId;
    if (context.result.authentication?.strategy === 'local' && analyticsTenantId) {
      runWithTenantContext(analyticsTenantId, () =>
        analyticsLogger.track(
          PRODUCT_ANALYTICS_EVENTS.LOGIN_SUCCEEDED,
          { method: 'local' },
          {
            userId: context.result.user.user_id,
          }
        )
      );
    }
    context.result.user = redactUserAuthMetadata(context.result.user);
    return context;
  };
}
