import { NotAuthenticated } from '@agor/core/feathers';
import type { Params, User, UserID } from '@agor/core/types';
import jwt, { type SignOptions } from 'jsonwebtoken';
import {
  issueRuntimeTokenPair,
  RUNTIME_JWT_AUDIENCE,
  RUNTIME_JWT_ISSUER,
  readRuntimeTenantClaim,
  runtimeTenantClaims,
} from './runtime-tokens.js';
import {
  assertUserTokenNotInvalidated,
  authTokenIssuedAtClaim,
  type UserAuthTokenPayload,
} from './token-invalidation.js';
import { redactUserAuthMetadata } from './user-redaction.js';

interface RefreshTokenServiceOptions {
  jwtSecret: string;
  accessTokenTtl: SignOptions['expiresIn'];
  refreshTokenTtl: SignOptions['expiresIn'];
  tenantClaim?: string;
  usersService: {
    get(id: UserID, params?: Params): Promise<User>;
  };
}

export function createRefreshTokenService(options: RefreshTokenServiceOptions) {
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

        const tenantId = readRuntimeTenantClaim(decoded, options.tenantClaim);
        const user = await options.usersService.get(
          decoded.sub as UserID,
          tenantId
            ? ({
                tenant: { tenant_id: tenantId, source: 'auth_claim' },
                authentication: { payload: decoded },
              } as Params)
            : ({ authentication: { payload: decoded } } as Params)
        );
        assertUserTokenNotInvalidated(user, decoded);

        // Use the same access-token TTL as the auth-service config. Refresh tokens
        // get the standard long TTL and both new tokens carry millisecond issue
        // time so fresh sign-ins immediately after a password change remain usable.
        const tokens = issueRuntimeTokenPair(
          user,
          options.jwtSecret,
          options.accessTokenTtl,
          options.refreshTokenTtl,
          {
            ...authTokenIssuedAtClaim(Date.now(), user),
            ...runtimeTenantClaims(
              tenantId ?? (user as { tenant_id?: string }).tenant_id,
              options.tenantClaim
            ),
          }
        );

        // Return the full safe user object, matching POST /authentication.
        return {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          user: redactUserAuthMetadata(user),
        };
      } catch (_error) {
        throw new NotAuthenticated('Invalid or expired refresh token');
      }
    },
  };
}
