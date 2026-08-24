import { type ResolvedMultiTenancyConfig, resolveTenantContext } from '@agor/core/config';
import type { TenantContext, User, UserID } from '@agor/core/types';
import jwt, { type SignOptions } from 'jsonwebtoken';

export const RUNTIME_JWT_ISSUER = 'agor';
export const RUNTIME_JWT_AUDIENCE = 'https://agor.dev';

export type RuntimeTokenType = 'access' | 'refresh' | 'service' | 'executor-session';

export interface RuntimeTokenPayload {
  sub: UserID | string;
  type: RuntimeTokenType;
  [claim: string]: unknown;
}

export interface RuntimeTokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * Resolve tenant authority from an already verified Agor runtime token.
 *
 * Socket clients are never trusted-header boundaries. In
 * `required_from_auth` mode this reconciles only the configured signed claim
 * and Agor's canonical `tenant_id` alias; contradictory aliases fail closed.
 * Callers must verify the token signature, issuer, and audience first.
 */
export function resolveSignedRuntimeTenant(
  config: ResolvedMultiTenancyConfig | undefined,
  payload: unknown
): TenantContext | undefined {
  if (!config) return undefined;
  if (config.mode === 'required_from_auth') {
    const tenantId = readRuntimeTenantClaim(payload, config.auth_claim);
    return resolveTenantContext(
      {
        ...config,
        auth_claim: 'tenant_id',
        trusted_header: undefined,
      },
      {
        authPayload:
          payload && typeof payload === 'object'
            ? { ...payload, ...(tenantId ? { tenant_id: tenantId } : {}) }
            : payload,
      }
    );
  }
  return resolveTenantContext(config, { authPayload: payload });
}

export function runtimeTenantClaims(
  tenantId: string | undefined,
  claimName = 'tenant_id'
): Record<string, string> {
  if (!tenantId) return {};
  if (claimName === 'tenant_id') return { tenant_id: tenantId };
  return { tenant_id: tenantId, [claimName]: tenantId };
}

export function readRuntimeTenantClaim(
  payload: unknown,
  claimName = 'tenant_id'
): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const normalize = (value: unknown, name: string): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Invalid signed tenant claim: ${name}`);
    }
    return value.trim();
  };
  const canonical = normalize(record.tenant_id, 'tenant_id');
  const configured =
    claimName === 'tenant_id' ? canonical : normalize(record[claimName], claimName);
  if (configured && canonical && configured !== canonical) {
    throw new Error('Conflicting signed tenant claims');
  }
  return configured ?? canonical;
}

export function issueRuntimeToken(
  payload: RuntimeTokenPayload,
  jwtSecret: string,
  expiresIn: SignOptions['expiresIn'],
  options: Pick<SignOptions, 'audience'> = {}
): string {
  return jwt.sign(payload, jwtSecret, {
    expiresIn,
    issuer: RUNTIME_JWT_ISSUER,
    audience: options.audience ?? RUNTIME_JWT_AUDIENCE,
  });
}

export function issueRuntimeTokenPair(
  user: Pick<User, 'user_id'>,
  jwtSecret: string,
  accessTokenTtl: SignOptions['expiresIn'],
  refreshTokenTtl: SignOptions['expiresIn'],
  extraClaims: Record<string, unknown> = {}
): RuntimeTokenPair {
  return {
    accessToken: issueRuntimeToken(
      { sub: user.user_id, type: 'access', ...extraClaims },
      jwtSecret,
      accessTokenTtl
    ),
    refreshToken: issueRuntimeToken(
      { sub: user.user_id, type: 'refresh', ...extraClaims },
      jwtSecret,
      refreshTokenTtl
    ),
  };
}
