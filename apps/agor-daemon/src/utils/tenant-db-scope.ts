import {
  type AgorConfig,
  resolveMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
} from '@agor/core/config';
import { type Database, getCurrentTenantId, runWithTenantDatabaseScope } from '@agor/core/db';
import { NotAuthenticated } from '@agor/core/feathers';
import type { HookContext, TenantID } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../auth/runtime-tokens.js';

interface TenantDatabaseScopeOptions {
  db: Database;
  config: AgorConfig;
  jwtSecret: string;
}

function readHeaderValue(
  headers: Record<string, unknown> | undefined,
  name: string
): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  }
  return null;
}

export function createTenantDatabaseScopeAroundHook(options: TenantDatabaseScopeOptions) {
  const multiTenancy = resolveMultiTenancyConfig(options.config);

  const bearerPayloadFromHeaders = (headers: Record<string, unknown> | undefined): unknown => {
    const authorization = readHeaderValue(headers, 'authorization');
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match || !options.jwtSecret) return undefined;
    try {
      return jwt.verify(match[1], options.jwtSecret, {
        issuer: RUNTIME_JWT_ISSUER,
        audience: RUNTIME_JWT_AUDIENCE,
      });
    } catch {
      // Let the normal Feathers auth hook return the canonical auth failure.
      return undefined;
    }
  };

  const resolveTenantForDatabaseScope = (context: HookContext) => {
    const params = context.params as HookContext['params'] & {
      headers?: Record<string, unknown>;
      connection?: { tenant?: unknown; data?: { tenant?: unknown } };
    };
    const connectionTenant = params.connection?.tenant ?? params.connection?.data?.tenant;
    if (
      connectionTenant &&
      typeof connectionTenant === 'object' &&
      'tenant_id' in connectionTenant
    ) {
      return connectionTenant as ReturnType<typeof resolveTenantContext>;
    }

    const inheritedTenantId = getCurrentTenantId();
    if (inheritedTenantId) {
      return { tenant_id: inheritedTenantId as TenantID, source: 'explicit' as const };
    }

    return resolveTenantContext(multiTenancy, {
      params,
      authPayload: params.authentication?.payload ?? bearerPayloadFromHeaders(params.headers),
      headers: params.headers,
    });
  };

  return async (context: HookContext, next: () => Promise<void>): Promise<void> => {
    try {
      context.params.tenant = resolveTenantForDatabaseScope(context);
    } catch (error) {
      if (error instanceof TenantResolutionError) {
        throw new NotAuthenticated(error.message);
      }
      throw error;
    }

    await runWithTenantDatabaseScope(options.db, context.params.tenant?.tenant_id, next);
  };
}
