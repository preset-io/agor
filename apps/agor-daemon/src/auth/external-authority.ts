import { createPublicKey } from 'node:crypto';
import {
  type AgorConfig,
  AgorUserLifecycleAuthority,
  resolveIdentityAuthority,
  resolveMultiTenancyConfig,
} from '@agor/core/config';
import {
  authorityOrdinal,
  ExternalUserAuthorityRepository,
  runWithTenantDatabaseTransaction,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import { Conflict, NotAuthenticated } from '@agor/core/feathers';
import { type ExternalUserAuthorityState, isUserRole } from '@agor/core/types';
import jwt from 'jsonwebtoken';
import { lockTenantAuthorizationFence } from '../services/tenant-authorization-fence.js';

/** Dedicated signed administrative channel. A launch assertion cannot authorize this route. */
export function createExternalAuthorityService(options: {
  db: TenantScopeAwareDatabase;
  config: AgorConfig;
  invalidated: (tenantId: string, userId: string) => void;
}) {
  const { config, db } = options;
  const settings = config.external_launch?.authority;
  const external =
    resolveIdentityAuthority(config).userLifecycle === AgorUserLifecycleAuthority.EXTERNAL;
  const tenancy = resolveMultiTenancyConfig(config);
  let key: ReturnType<typeof createPublicKey> | undefined;
  if (settings) {
    if (
      !external ||
      !config.external_launch?.issuer ||
      typeof settings.cell_id !== 'string' ||
      !settings.cell_id.trim() ||
      !Array.isArray(settings.tenant_ids) ||
      !settings.tenant_ids.length ||
      settings.tenant_ids.some((id) => typeof id !== 'string' || !id.trim())
    ) {
      throw new Error('Invalid external authority configuration');
    }
    key = createPublicKey(settings.public_key);
    if (key.asymmetricKeyType !== 'rsa')
      throw new Error('External authority requires an RSA public key');
  }
  return {
    async create(data: { assertion?: unknown }) {
      if (!key || !settings || !external)
        throw new NotAuthenticated('External authority unavailable');
      let tenantId: string;
      let state: ExternalUserAuthorityState;
      try {
        if (typeof data?.assertion !== 'string' || data.assertion.length > 16_384)
          throw new Error();
        const claims = jwt.verify(data.assertion, key, {
          algorithms: ['RS256'],
          issuer: config.external_launch!.issuer,
          audience: `agor-authority:${settings.cell_id}`,
          maxAge: 60,
        });
        if (
          typeof claims === 'string' ||
          claims.purpose !== 'external-authority-v1' ||
          claims.cell_id !== settings.cell_id ||
          typeof claims.tenant_id !== 'string' ||
          claims.workspace_id !== claims.tenant_id ||
          !settings.tenant_ids.includes(claims.tenant_id) ||
          typeof claims.sub !== 'string' ||
          !claims.sub ||
          claims.sub.length > 1024 ||
          typeof claims.jti !== 'string' ||
          !claims.jti ||
          typeof claims.iat !== 'number' ||
          !Number.isInteger(claims.iat) ||
          claims.iat > Date.now() / 1000 ||
          typeof claims.exp !== 'number' ||
          claims.exp <= claims.iat ||
          claims.exp > claims.iat + 60 ||
          claims.provider !==
            (config.external_launch!.provider_id || config.external_launch!.issuer) ||
          typeof claims.active !== 'boolean' ||
          !isUserRole(claims.role) ||
          ((claims.role === 'admin' || claims.role === 'superadmin') &&
            !config.external_launch!.allow_admin_roles) ||
          (claims.role === 'superadmin' && !config.execution?.allow_superadmin)
        )
          throw new Error();
        tenantId = claims.tenant_id;
        if (tenancy.mode === 'static' && tenancy.static_tenant_id !== tenantId) throw new Error();
        authorityOrdinal(claims.revision);
        authorityOrdinal(claims.login_epoch);
        state = {
          provider: claims.provider,
          issuer: claims.iss!,
          subject: claims.sub,
          revision: claims.revision,
          login_epoch: claims.login_epoch,
          active: claims.active,
          role: claims.role,
        };
      } catch {
        throw new NotAuthenticated('Invalid external authority assertion');
      }
      const result = await runWithTenantDatabaseTransaction(db, tenantId, async (scoped) => {
        await lockTenantAuthorizationFence(scoped);
        try {
          return await new ExternalUserAuthorityRepository(scoped).apply(state);
        } catch (error) {
          if (
            error instanceof Error &&
            ['Conflicting authority revision', 'Authority epoch must advance'].includes(
              error.message
            )
          ) {
            throw new Conflict(error.message);
          }
          throw error; // Database uncertainty never acknowledges applied authority.
        }
      });
      if (result.outcome === 'applied' && result.userId)
        options.invalidated(tenantId, result.userId);
      return {
        protocol: 1,
        applied_revision: result.row.revision,
        applied_login_epoch: result.row.login_epoch,
        outcome: result.outcome,
      };
    },
  };
}
