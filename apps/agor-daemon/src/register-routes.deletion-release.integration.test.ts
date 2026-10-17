import { spawn } from 'node:child_process';
import {
  BranchMaintenanceRepository,
  BranchRepository,
  createTenantScopedDatabaseProxy,
  type Database,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import { type BranchMaintenanceExecutionProcess, ROLES, type TenantID } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { seedEnvironmentCommandBranch } from '../../../packages/core/src/db/repositories/environment-commands.test-support';
import { dbTest as test } from '../../../packages/core/src/db/test-helpers';
import { retirementRouteApp } from '../test/retirement-route-app';
import { captureLocalProcessGroupIdentity } from './executor-tracking';
import type { BranchesService } from './services/branches';

const route = 'branches/:id/release-deletion';

async function fixture(raw: Database, identity?: BranchMaintenanceExecutionProcess) {
  const db = createTenantScopedDatabaseProxy(raw, { requireScope: true });
  const tenantId = 'deletion-release-route' as TenantID;
  const scoped = <T>(work: () => Promise<T>) => runWithTenantDatabaseScope(db, tenantId, work);
  const { branch, user } = await scoped(() => seedEnvironmentCommandBranch(db));
  const maintenance = new BranchMaintenanceRepository(db);
  const { claim } = await scoped(() => maintenance.claim(branch.branch_id, 'delete'));
  const invocation = await scoped(() => maintenance.beginExecution(claim));
  if (identity) await scoped(() => maintenance.recordExecutionProcess(claim, invocation, identity));
  await scoped(() => maintenance.claimExecution(claim, invocation));
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect(await scoped(() => maintenance.markStaleDeletion(claim, 30_000))).toBe(true);
  } finally {
    vi.useRealTimers();
  }
  const app = await retirementRouteApp(db, {
    multi_tenancy: { mode: 'static', static_tenant_id: tenantId },
    execution: {},
  });
  const params = {
    route: { id: branch.branch_id },
    user: { ...user, role: ROLES.ADMIN },
    tenant: { tenant_id: tenantId, source: 'explicit' as const },
  };
  const service = app.service('branches') as unknown as BranchesService;
  const read = () => scoped(() => new BranchRepository(db).findById(branch.branch_id));
  const retry = () => scoped(() => maintenance.claim(branch.branch_id, 'delete'));
  return { app, service, params, branch, read, retry };
}

test('registered release route independently requires administrator authority', async ({ db }) => {
  const { app, service, params, branch } = await fixture(db);
  const externalParams = { ...params, provider: 'rest' };
  // Isolate the route gate: removing it must fail even while the service gate remains.
  const release = vi.spyOn(service, 'forceReleaseDeletion').mockResolvedValue(branch);
  try {
    for (const role of [ROLES.MEMBER, ROLES.VIEWER]) {
      const unauthorized = { ...externalParams, user: { ...params.user, role } };
      await expect(app.service(route).create({}, unauthorized)).rejects.toMatchObject({
        code: 403,
      });
    }
    const anonymous = { ...externalParams, user: undefined };
    await expect(app.service(route).create({}, anonymous)).rejects.toMatchObject({ code: 401 });
    expect(release).not.toHaveBeenCalled();
    await app.service(route).create({}, externalParams);
    expect(release).toHaveBeenCalledOnce();
  } finally {
    release.mockRestore();
  }
});

test('direct release service rejects non-admins and missing callers without changing the fence', async ({
  db,
}) => {
  const { service, params, branch, read, retry } = await fixture(db);
  const before = await read();
  for (const user of [
    { ...params.user, role: ROLES.MEMBER },
    { ...params.user, role: ROLES.VIEWER },
    undefined,
  ]) {
    await expect(
      service.forceReleaseDeletion(branch.branch_id, { ...params, user })
    ).rejects.toMatchObject({ code: 403 });
    expect(await read()).toEqual(before);
    expect((await retry()).acquired).toBe(false);
  }
  await service.forceReleaseDeletion(branch.branch_id, params);
  expect((await read())?.deletion_error).toContain(params.user.user_id);
  expect((await retry()).acquired).toBe(true);
});

test('registered admin release preserves the tenant boundary and validates its body', async ({
  db,
}) => {
  const { app, params, read, retry } = await fixture(db);
  const before = await read();
  await expect(app.service(route).create({ force: true }, params)).rejects.toThrow('empty body');
  const foreignParams = {
    ...params,
    tenant: { ...params.tenant, tenant_id: 'foreign' as TenantID },
  };
  await expect(app.service(route).create({}, foreignParams)).rejects.toThrow();
  expect(await read()).toEqual(before);
  expect((await retry()).acquired).toBe(false);
  await app.service(route).create({}, params);
  expect((await retry()).acquired).toBe(true);
});

describe.runIf(process.platform === 'linux')('recorded executor administrator release', () => {
  test('refuses a live same-host group even after its heartbeat is stale, then permits release after exit', async ({
    db,
  }) => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    try {
      const identity = captureLocalProcessGroupIdentity(child.pid!)!;
      const { app, params, read, retry } = await fixture(db, identity);
      const before = await read();
      await expect(app.service(route).create({}, params)).rejects.toMatchObject({ code: 409 });
      expect(await read()).toEqual(before);
      expect((await retry()).acquired).toBe(false);
      const exited = new Promise((resolve) => child.once('exit', resolve));
      process.kill(-child.pid!, 'SIGKILL');
      await exited;
      await app.service(route).create({}, params);
      expect((await retry()).acquired).toBe(true);
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
    }
  });

  for (const field of ['boot_id', 'pid_namespace'] as const) {
    test(`retains explicit admin recovery when the executor's ${field} belongs to another host`, async ({
      db,
    }) => {
      const identity = { ...captureLocalProcessGroupIdentity(process.pid)!, [field]: 'elsewhere' };
      const { app, params, retry } = await fixture(db, identity);
      await app.service(route).create({}, params);
      expect((await retry()).acquired).toBe(true);
    });
  }
});
