import { NotAuthenticated, Unavailable } from '@agor/core/feathers';
import type { Params, User, UserID } from '@agor/core/types';
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { LaunchSessionRevalidator } from './launch-auth.js';
import {
  issueRuntimeTokenPair,
  RUNTIME_JWT_AUDIENCE,
  RUNTIME_JWT_ISSUER,
  readRuntimeTenantClaim,
  runtimeTenantClaims,
} from './runtime-tokens.js';
import {
  AUTH_REVALIDATED_AT_MS_CLAIM,
  type BrowserSessionClaims,
  continueBrowserSession,
} from './session-lifetime.js';
import {
  assertUserTokenNotInvalidated,
  authCredentialGenerationClaim,
  authTokenIssuedAtClaim,
  type UserAuthTokenPayload,
} from './token-invalidation.js';
import { redactUserAuthMetadata } from './user-redaction.js';

interface RefreshTokenServiceOptions {
  jwtSecret: string;
  accessTokenTtl: SignOptions['expiresIn'];
  refreshTokenTtl: number;
  /** Absolute lifetime of a launched session in seconds; refresh never extends one past it. */
  sessionMaxLifetimeSeconds: number;
  tenantClaim?: string;
  usersService: {
    get(id: UserID, params?: Params): Promise<User>;
  };
  /** Present only when external launch configures membership revalidation. */
  revalidateLaunchSession?: LaunchSessionRevalidator;
  now?: () => number;
}

export function createRefreshTokenService(options: RefreshTokenServiceOptions) {
  const now = options.now ?? Date.now;
  return {
    async create(data: { refreshToken: string }, _params?: Params) {
      try {
        const decoded = jwt.verify(data.refreshToken, options.jwtSecret, {
          issuer: RUNTIME_JWT_ISSUER,
          audience: RUNTIME_JWT_AUDIENCE,
        }) as UserAuthTokenPayload;

        if (decoded.type !== 'refresh') {
          throw new Error('Invalid token type');
        }

        const nowMs = now();
        let session = continueBrowserSession(decoded, options.sessionMaxLifetimeSeconds, nowMs);
        const tenantId = readRuntimeTenantClaim(decoded, options.tenantClaim);
        const userParams = (): Params =>
          tenantId
            ? ({
                tenant: { tenant_id: tenantId, source: 'auth_claim' },
                authentication: { payload: decoded },
              } as Params)
            : ({ authentication: { payload: decoded } } as Params);
        let user = await options.usersService.get(decoded.sub as UserID, userParams());
        assertUserTokenNotInvalidated(user, decoded);

        let sessionClaims: BrowserSessionClaims = session.claims;
        let accessNotAfterSeconds: number | undefined;
        if (options.revalidateLaunchSession) {
          // Re-check external membership and reproject the role before re-issuing.
          const revalidated = await options.revalidateLaunchSession({
            userId: user.user_id,
            payload: decoded,
          });
          if (revalidated) {
            // A revalidated session is a launched one, even if its token predates the subject claim.
            session = continueBrowserSession(decoded, options.sessionMaxLifetimeSeconds, nowMs, {
              launchSubject: revalidated.launchSubject,
            });
            sessionClaims = {
              ...session.claims,
              [AUTH_REVALIDATED_AT_MS_CLAIM]: revalidated.revalidatedAtMs,
            };
            // Outage grace caps access only: the refresh token must survive to retry after the grace.
            accessNotAfterSeconds = revalidated.notAfterSeconds;
            user = await options.usersService.get(decoded.sub as UserID, userParams());
            assertUserTokenNotInvalidated(user, decoded);
          }
        }

        // Use the same access-token TTL as the auth-service config. Both new
        // tokens carry millisecond issue time so fresh sign-ins immediately after
        // a password change remain usable, and the original sign-in time so the
        // session can never slide past its absolute lifetime.
        const tokens = issueRuntimeTokenPair(
          user,
          options.jwtSecret,
          options.accessTokenTtl,
          options.refreshTokenTtl,
          {
            ...authCredentialGenerationClaim(user),
            ...authTokenIssuedAtClaim(nowMs, user),
            ...runtimeTenantClaims(
              tenantId ?? (user as { tenant_id?: string }).tenant_id,
              options.tenantClaim
            ),
            ...sessionClaims,
          },
          { notAfterSeconds: session.notAfterSeconds, accessNotAfterSeconds }
        );

        // Return the full safe user object, matching POST /authentication.
        return {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          user: redactUserAuthMetadata(user),
        };
      } catch (error) {
        // A check that couldn't run is not a rejected credential: the client keeps it and retries.
        if (error instanceof Unavailable) throw error;
        throw new NotAuthenticated('Invalid or expired refresh token');
      }
    },
  };
}
