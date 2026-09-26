import {
  BranchRepository,
  createTenantScopedDatabaseProxy,
  runWithTenantDatabaseScope,
  UsersRepository,
} from '@agor/core/db';
import type { TenantID } from '@agor/core/types';
import { expect } from 'vitest';
import { dbTest } from '../../../packages/core/src/db/test-helpers';
import { retirementRouteApp } from '../test/retirement-route-app';
import { seedPreferenceRace } from './services/teammate-preference-race.test-support';
import {
  assertTenantServiceClassification,
  tenantServiceClassificationFor,
} from './utils/tenant-service-classification';

dbTest(
  'registered retirement route opens its own tenant units and preserves storage',
  async ({ db: raw }) => {
    const db = createTenantScopedDatabaseProxy(raw, { requireScope: true });
    const tenantId = 'retirement-route' as TenantID;
    const config = {
      multi_tenancy: { mode: 'static' as const, static_tenant_id: tenantId },
      execution: {},
    };
    const scoped = <T>(work: () => Promise<T>) => runWithTenantDatabaseScope(db, tenantId, work);
    const fixture = await scoped(() => seedPreferenceRace(db));
    const app = await retirementRouteApp(db, config);
    const path = 'branches/:id/retire-teammate';
    expect(tenantServiceClassificationFor(path)?.scopeClass).toBe('identity-only');
    expect(() =>
      assertTenantServiceClassification({ services: { [path]: app.service(path) } })
    ).not.toThrow();
    const params = {
      route: { id: fixture.branch.branch_id },
      user: fixture.user,
      tenant: { tenant_id: tenantId, source: 'explicit' as const },
    };
    await expect(app.service(path).create({ force: true }, params)).rejects.toThrow('empty body');
    const foreignParams = {
      ...params,
      tenant: { ...params.tenant, tenant_id: 'foreign' as TenantID },
    };
    await expect(app.service(path).create({}, foreignParams)).rejects.toThrow();
    await app.service(path).create({}, params);
    await scoped(async () => {
      expect(await new BranchRepository(db).findById(fixture.branch.branch_id)).toMatchObject({
        archived: true,
        path: fixture.branch.path,
        filesystem_status: 'ready',
      });
      expect(
        (await new UsersRepository(db).findById(fixture.user.user_id))?.primary_teammate_id
      ).toBeUndefined();
    });
  }
);
