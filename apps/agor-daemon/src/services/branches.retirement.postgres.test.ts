import {
  BoardRepository,
  BranchMaintenanceRepository,
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  generateId,
  initializeDatabase,
  rawRows,
  runWithTenantDatabaseScope,
  sql,
  UsersRepository,
} from '@agor/core/db';
import type { TenantID } from '@agor/core/types';
import { expect, it, vi } from 'vitest';
import { retirementRouteApp } from '../../test/retirement-route-app';
import { BoardsService } from './boards';
import {
  barrier,
  retirementService,
  seedPreferenceRace,
} from './teammate-preference-race.test-support';

const url = process.env.AGOR_TEST_POSTGRES_URL;
it.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'public retirement and board assignment serialize before the human actor lock (PostgreSQL/RLS)',
  async () => {
    const raw = createDatabase({ dialect: 'postgresql', url: url! });
    const peerRaw = createDatabase({ dialect: 'postgresql', url: url! });
    const db = createTenantScopedDatabaseProxy(raw, { requireScope: true });
    const peer = createTenantScopedDatabaseProxy(peerRaw, { requireScope: true });
    const tenantId = `retirement-${generateId()}` as TenantID;
    const locked = barrier();
    const release = barrier();
    let retire: Promise<unknown> | undefined;
    let assign: Promise<unknown> | undefined;
    try {
      await initializeDatabase(raw);
      expect(
        rawRows(
          await executeRaw(
            raw,
            sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
          )
        )
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const fixture = await runWithTenantDatabaseScope(db, tenantId, () => seedPreferenceRace(db));
      const params = {
        provider: 'rest',
        user: fixture.user,
        tenant: { tenant_id: tenantId, source: 'auth_claim' as const },
      };
      const original = BranchMaintenanceRepository.prototype.claim;
      vi.spyOn(BranchMaintenanceRepository.prototype, 'claim').mockImplementation(function (
        this: BranchMaintenanceRepository,
        id,
        kind,
        requestedBy,
        validate
      ) {
        return original.call(this, id, kind, requestedBy, async (tx) => {
          // Public retirement now owns its reference and Branch locks. Pause
          // immediately before the real validation clears matching User rows.
          if (id === fixture.branch.branch_id) {
            locked.release();
            await release.promise;
          }
          await validate?.(tx);
        });
      });
      const actorLock = vi.spyOn(UsersRepository.prototype, 'getWriteAuthorityProjectionForUpdate');
      // Public service methods, with a persisted human actor (not an actorless
      // repository shortcut). Preserve does not spawn an executor or touch files.
      retire = retirementService(db).retireTeammate(fixture.branch.branch_id, params);
      void retire.catch(() => {});
      await locked.promise;
      let peerPid = 0;
      assign = runWithTenantDatabaseScope(peer, tenantId, async () => {
        peerPid = Number(
          rawRows(await executeRaw(peer, sql`SELECT pg_backend_pid() AS pid`))[0].pid
        );
        return new BoardsService(peer).setPrimaryTeammate(
          { boardId: fixture.board.board_id, branchId: fixture.replacement.branch_id },
          params
        );
      });
      void assign.catch(() => {});
      // Observe the actual wait, not a sleep-based guess. Before the fix this is
      // the reference lock AFTER actor FOR UPDATE; after it, the authority fence.
      await vi.waitFor(async () => {
        expect(peerPid).not.toBe(0);
        const rows = rawRows(
          await executeRaw(raw, sql`SELECT wait_event FROM pg_stat_activity WHERE pid = ${peerPid}`)
        );
        expect(rows[0]?.wait_event).toBe('advisory');
      });
      const actorWasLockedBeforeRelease = actorLock.mock.calls.length > 0;
      release.release();
      const outcomes = await Promise.allSettled([retire, assign]);
      expect(
        outcomes.map((result) => result.status),
        JSON.stringify(outcomes)
      ).toEqual(['fulfilled', 'fulfilled']);
      expect(actorWasLockedBeforeRelease).toBe(false);
      expect(actorLock).toHaveBeenCalledWith(fixture.user.user_id);
      await runWithTenantDatabaseScope(db, tenantId, async () => {
        expect(
          (await new UsersRepository(db).findById(fixture.user.user_id))?.primary_teammate_id
        ).toBeUndefined();
        expect((await new BranchRepository(db).findById(fixture.branch.branch_id))?.archived).toBe(
          true
        );
        expect(
          (await new BoardRepository(db).findById(fixture.board.board_id))?.primary_teammate_id
        ).toBe(fixture.replacement.branch_id);
      });
      await expect(
        retirementService(peer).retireTeammate(fixture.replacement.branch_id, {
          ...params,
          tenant: { ...params.tenant, tenant_id: 'foreign' as TenantID },
        })
      ).rejects.toThrow();
    } finally {
      release.release();
      await Promise.allSettled([retire, assign]);
      vi.restoreAllMocks();
      for (const handle of [raw, peerRaw])
        await (handle as unknown as Database & { $client: { end(): Promise<void> } }).$client.end();
    }
  },
  60000
);

it.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'registered retirement route refuses another tenant before clearing any preferences (RLS)',
  async () => {
    const raw = createDatabase({ dialect: 'postgresql', url: url! });
    const db = createTenantScopedDatabaseProxy(raw, { requireScope: true });
    const tenantA = `route-a-${generateId()}` as TenantID;
    const tenantB = `route-b-${generateId()}` as TenantID;
    try {
      await initializeDatabase(raw);
      const a = await runWithTenantDatabaseScope(db, tenantA, () => seedPreferenceRace(db));
      const b = await runWithTenantDatabaseScope(db, tenantB, () => seedPreferenceRace(db));
      const app = await retirementRouteApp(db, {
        multi_tenancy: { mode: 'required_from_auth' },
        execution: {},
      });
      const route = app.service('branches/:id/retire-teammate');
      const foreignParams = {
        route: { id: a.branch.branch_id },
        user: b.user,
        tenant: { tenant_id: tenantB, source: 'auth_claim' as const },
      };
      await expect(route.create({}, foreignParams)).rejects.toThrow();
      await runWithTenantDatabaseScope(db, tenantA, async () => {
        expect((await new BranchRepository(db).findById(a.branch.branch_id))?.archived).toBe(false);
        expect((await new UsersRepository(db).findById(a.user.user_id))?.primary_teammate_id).toBe(
          a.branch.branch_id
        );
      });
      const ownerParams = {
        route: { id: a.branch.branch_id },
        user: a.user,
        tenant: { tenant_id: tenantA, source: 'auth_claim' as const },
      };
      await route.create({}, ownerParams);
      await runWithTenantDatabaseScope(db, tenantA, async () => {
        expect((await new BranchRepository(db).findById(a.branch.branch_id))?.archived).toBe(true);
        expect(
          (await new UsersRepository(db).findById(a.user.user_id))?.primary_teammate_id
        ).toBeUndefined();
      });
      await runWithTenantDatabaseScope(db, tenantB, async () => {
        expect((await new BranchRepository(db).findById(b.branch.branch_id))?.archived).toBe(false);
        expect((await new UsersRepository(db).findById(b.user.user_id))?.primary_teammate_id).toBe(
          b.branch.branch_id
        );
      });
    } finally {
      await (raw as unknown as Database & { $client: { end(): Promise<void> } }).$client.end();
    }
  },
  60000
);
