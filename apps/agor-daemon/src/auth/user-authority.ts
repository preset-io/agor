import {
  and,
  eq,
  externalUserAuthorityPredicate,
  runWithTenantDatabaseScope,
  select,
  sql,
  type TenantScopeAwareDatabase,
  userApiKeys,
  users,
} from '@agor/core/db';
import { NotAuthenticated } from '@agor/core/feathers';
import { traceBestEffort } from '@agor/core/tracing/datadog';
import type { UserRole } from '@agor/core/types';
import { getDaemonMetrics } from '../metrics/index.js';
import { resolveTracerModule } from '../tracing/datadog.js';
import {
  assertUserAccessEnabled,
  assertUserTokenNotInvalidated,
  sourceApiKeyClaims,
  type UserAuthTokenPayload,
} from './token-invalidation.js';

export type UserAuthorityCheck = (
  tenantId: string,
  userId: string,
  payload?: UserAuthTokenPayload
) => Promise<{ role: UserRole }>;

const checks = new WeakMap<object, UserAuthorityCheck>();
export function getUserAuthorityCheck(app: object): UserAuthorityCheck {
  const check = checks.get(app);
  if (!check) throw new NotAuthenticated('User authority unavailable');
  return check;
}

/** One nonsecret indexed projection; no cross-request positive cache. */
export function installUserAuthorityCheck(
  app: object,
  db: TenantScopeAwareDatabase,
  external?: { provider: string; issuer: string }
): UserAuthorityCheck {
  const tracer = resolveTracerModule();
  const check: UserAuthorityCheck = (tenantId, userId, payload) =>
    traceBestEffort(tracer, 'auth.authority', {}, async () => {
      const metrics = getDaemonMetrics(app);
      const started = performance.now();
      let result = 'unavailable';
      try {
        if (!tenantId || !userId) throw new NotAuthenticated('User authority unavailable');
        const sourceId = sourceApiKeyClaims(payload).source_api_key_id;
        metrics.increment('auth.authority.db_statements');
        const row = await runWithTenantDatabaseScope(db, tenantId, async (scoped) =>
          select(scoped, {
            role: users.role,
            external_current: externalUserAuthorityPredicate(userId, external),
            access_disabled: users.access_disabled,
            credential_generation: users.credential_generation,
            tokens_valid_after: users.tokens_valid_after,
            source_exists: sourceId
              ? sql<boolean>`EXISTS (SELECT 1 FROM ${userApiKeys}
                WHERE ${userApiKeys.id} = ${sourceId}
                AND ${userApiKeys.user_id} = ${userId}
                ${'tenant_id' in userApiKeys ? sql`AND ${userApiKeys.tenant_id} = ${tenantId}` : sql``})`
              : sql<boolean>`true`,
          })
            .from(users)
            .where(
              and(
                eq(users.user_id, userId),
                'tenant_id' in users ? eq(users.tenant_id, tenantId) : undefined
              )
            )
            .one()
        );
        result = 'denied';
        if (!row?.source_exists || !row.external_current)
          throw new NotAuthenticated('User authority revoked');
        assertUserAccessEnabled(row);
        if (
          payload?.type === 'access' ||
          payload?.type === 'refresh' ||
          (payload?.type === undefined && payload)
        ) {
          assertUserTokenNotInvalidated(
            { ...row, tokens_valid_after: row.tokens_valid_after ?? undefined },
            payload
          );
        }
        result = 'allowed';
        return { role: row.role as UserRole };
      } finally {
        metrics.increment('auth.authority.check', 1, { result });
        metrics.timing('auth.authority.duration', performance.now() - started, { result });
      }
    });
  checks.set(app, check);
  return check;
}
