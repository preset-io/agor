import type { RefreshTokenFamiliesRepository } from '@agor/core/db';
import { NotAuthenticated } from '@agor/core/feathers';
import type { Params, User, UserID } from '@agor/core/types';
import { hasMinimumRole, ROLES } from '@agor/core/types';
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
  refreshFamilies: RefreshTokenFamiliesRepository;
}

interface RefreshClaims extends UserAuthTokenPayload {
  family_id?: string;
  jti?: string;
}

export function createRefreshTokenService(options: RefreshTokenServiceOptions) {
  return {
    async create(
      data: {
        refreshToken?: string;
        accessToken?: string;
        action?: 'logout' | 'revoke-all';
        userId?: UserID;
      },
      _params?: Params
    ) {
      try {
        if (data.action === 'revoke-all') {
          if (!data.accessToken) throw new Error('Authentication required');
          const accessClaims = jwt.verify(data.accessToken, options.jwtSecret, {
            issuer: RUNTIME_JWT_ISSUER,
            audience: RUNTIME_JWT_AUDIENCE,
          }) as RefreshClaims;
          if (accessClaims.type !== 'access') throw new Error('Invalid access token');
          const accessTenant = readRuntimeTenantClaim(accessClaims, options.tenantClaim);
          const caller = await options.usersService.get(
            accessClaims.sub as UserID,
            accessTenant
              ? ({
                  tenant: { tenant_id: accessTenant, source: 'auth_claim' },
                  authentication: { payload: accessClaims },
                } as Params)
              : ({ authentication: { payload: accessClaims } } as Params)
          );
          assertUserTokenNotInvalidated(caller, accessClaims);
          const target = data.userId ?? caller.user_id;
          if (target !== caller.user_id && !hasMinimumRole(caller.role, ROLES.ADMIN))
            throw new Error('Forbidden');
          const tenantId =
            accessTenant ?? (caller as { tenant_id?: string }).tenant_id ?? 'default';
          await options.refreshFamilies.revokeAll(target, tenantId);
          return { revoked: true };
        }
        if (!data.refreshToken) throw new Error('Missing refresh token');
        const decoded = jwt.verify(data.refreshToken, options.jwtSecret, {
          issuer: RUNTIME_JWT_ISSUER,
          audience: RUNTIME_JWT_AUDIENCE,
        }) as RefreshClaims;

        if (decoded.type !== 'refresh') {
          throw new Error('Invalid token type');
        }

        const tenantId = readRuntimeTenantClaim(decoded, options.tenantClaim);
        const scopedTenantId = tenantId ?? 'default';
        if (!decoded.family_id || !decoded.jti) throw new Error('Untracked refresh token');
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

        if (data.action === 'logout') {
          await options.refreshFamilies.revokeFamily(
            decoded.family_id,
            scopedTenantId,
            user.user_id
          );
          return { revoked: true };
        }

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
          },
          decoded.family_id
        );

        const rotated = await options.refreshFamilies.rotate({
          familyId: decoded.family_id,
          tenantId: scopedTenantId,
          userId: user.user_id,
          tokenId: decoded.jti,
          nextTokenId: tokens.refreshTokenId,
        });
        if (!rotated) throw new Error('Refresh token reuse detected');

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
