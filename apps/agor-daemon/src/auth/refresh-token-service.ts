import {
  type ResolvedMultiTenancyConfig,
  resolveMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
  type TenantResolutionInput,
} from '@agor/core/config';
import { NotAuthenticated } from '@agor/core/feathers';
import type { Params, User, UserID } from '@agor/core/types';
import jwt, { type SignOptions } from 'jsonwebtoken';
import {
  issueRuntimeTokenPair,
  RUNTIME_JWT_AUDIENCE,
  RUNTIME_JWT_ISSUER,
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
  usersService: {
    get(id: UserID, params?: Params): Promise<User>;
  };
  multiTenancy?: ResolvedMultiTenancyConfig;
}

function resolveRefreshTenantClaims(
  options: RefreshTokenServiceOptions,
  params: Params | undefined,
  decoded: UserAuthTokenPayload,
  user: User
): Record<string, unknown> {
  const multiTenancy = options.multiTenancy ?? resolveMultiTenancyConfig({});
  try {
    const tenant = resolveTenantContext(multiTenancy, {
      authPayload: decoded,
      params: params as TenantResolutionInput['params'],
      headers: (params as { headers?: Record<string, unknown> } | undefined)?.headers,
    });
    return { tenant_id: tenant.tenant_id };
  } catch (error) {
    if (multiTenancy.mode !== 'required_from_auth') {
      return { tenant_id: multiTenancy.static_tenant_id };
    }
    if (user.tenant_id) return { tenant_id: user.tenant_id };
    if (error instanceof TenantResolutionError) {
      throw new NotAuthenticated(error instanceof Error ? error.message : 'Missing tenant context');
    }
    throw error;
  }
}

export function createRefreshTokenService(options: RefreshTokenServiceOptions) {
  return {
    async create(data: { refreshToken: string }, params?: Params) {
      try {
        const decoded = jwt.verify(data.refreshToken, options.jwtSecret, {
          issuer: RUNTIME_JWT_ISSUER,
          audience: RUNTIME_JWT_AUDIENCE,
        }) as UserAuthTokenPayload;

        if (decoded.type !== 'refresh') {
          throw new Error('Invalid token type');
        }

        const user = await options.usersService.get(decoded.sub as UserID);
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
            ...resolveRefreshTenantClaims(options, params, decoded, user),
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
