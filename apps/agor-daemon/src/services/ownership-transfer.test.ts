import {
  BoardRepository,
  BranchMaintenanceRepository,
  BranchRepository,
  CardRepository,
  generateId,
  runWithTenantDatabaseTransaction,
  ScheduleRepository,
  UsersRepository,
} from '@agor/core/db';
import { capabilityPolicyPresetCapabilities, OWNERSHIP_TRANSFER_SERVICES } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { LOCAL_AUTHORIZATION_CACHE_INVALIDATION_EVENT } from '../realtime/routing';
import { ownershipApp, ownershipFixture, ownershipParams } from './ownership-transfer.test-support';

describe('management ownership transfer', () => {
  for (const binding of ['inherit', 'override'] as const) {
    dbTest(
      `transfers a ${binding} branch without reassigning its board, creator or policy`,
      async ({ db }) => {
        const f = await ownershipFixture(db, binding);
        const app = ownershipApp(db);
        const before = await f.policies.getBranchPolicy(f.branch.branch_id);
        const events: string[] = [];
        app.on(LOCAL_AUTHORIZATION_CACHE_INVALIDATION_EVENT, () => events.push('invalidate'));
        app.service('branches').on('patched', () => events.push('patched'));
        const result = await app.service(OWNERSHIP_TRANSFER_SERVICES.branch).patch(
          null,
          {
            expected_owner_user_id: f.owner.user_id,
            target_user_id: f.successor.user_id,
          },
          ownershipParams(f.owner.user_id, f.branch.branch_id)
        );
        expect(result).toMatchObject({
          scope: 'management_only',
          previous_owner_access: { capabilities: [] },
        });
        expect(await f.policies.getBranchPolicy(f.branch.branch_id)).toEqual({
          ...before,
          primary_owner_user_id: f.successor.user_id,
        });
        expect(await new BranchRepository(db).findById(f.branch.branch_id)).toMatchObject({
          created_by: f.owner.user_id,
        });
        expect(await f.policies.getBoardPolicies(f.board.board_id)).toMatchObject({
          primary_owner_user_id: f.owner.user_id,
        });
        expect(await new BoardRepository(db).canMutate(f.board.board_id, f.successor.user_id)).toBe(
          false
        );
        expect(events).toEqual(['invalidate', 'patched']);
        await expect(
          new BranchRepository(db).update(f.branch.branch_id, {
            primary_owner_user_id: f.owner.user_id,
          })
        ).rejects.toThrow('immutable');
        await expect(
          f.policies.replaceBranchPolicy(f.branch.branch_id, before, f.owner.user_id)
        ).rejects.toThrow('immutable');
      }
    );
  }

  dbTest(
    'board transfer grants card edit authority without changing card authorship or branch owners',
    async ({ db }) => {
      const f = await ownershipFixture(db);
      const cards = new CardRepository(db);
      const card = await cards.create({
        board_id: f.board.board_id,
        title: 'Elizabeth-created card',
        created_by: f.owner.user_id,
      });
      const before = await f.policies.getBoardPolicies(f.board.board_id);
      const app = ownershipApp(db);
      await app.service(OWNERSHIP_TRANSFER_SERVICES.board).patch(
        null,
        {
          expected_owner_user_id: f.owner.user_id,
          target_user_id: f.successor.user_id,
        },
        ownershipParams(f.owner.user_id, f.board.board_id)
      );
      expect(await f.policies.getBoardPolicies(f.board.board_id)).toEqual({
        ...before,
        primary_owner_user_id: f.successor.user_id,
      });
      expect(await new BoardRepository(db).canMutate(f.board.board_id, f.successor.user_id)).toBe(
        true
      );
      expect(await cards.findById(card.card_id)).toMatchObject({ created_by: f.owner.user_id });
      expect(await f.policies.getBranchPolicy(f.branch.branch_id)).toMatchObject({
        primary_owner_user_id: f.owner.user_id,
      });
      await expect(
        new BoardRepository(db).update(f.board.board_id, {
          primary_owner_user_id: f.owner.user_id,
        })
      ).rejects.toThrow('immutable');
    }
  );

  dbTest('preserves independent grants but Manager alone cannot transfer', async ({ db }) => {
    const f = await ownershipFixture(db);
    const policy = await f.policies.getBoardPolicies(f.board.board_id);
    policy.board_access.sharing_mode = 'shared';
    policy.board_access.entries = [f.owner, f.successor].map((user) => ({
      entry_id: generateId(),
      principal: { principal_type: 'user', user_id: user.user_id },
      preset: 'manager',
      capabilities: capabilityPolicyPresetCapabilities('board_access', 'manager')!,
      fs_access: 'none',
    }));
    await f.policies.replaceBoardPolicies(f.board.board_id, policy, f.owner.user_id);
    const app = ownershipApp(db);
    const service = app.service(OWNERSHIP_TRANSFER_SERVICES.board);
    const request = {
      expected_owner_user_id: f.owner.user_id,
      target_user_id: f.successor.user_id,
    };
    await expect(
      service.patch(null, request, ownershipParams(f.successor.user_id, f.board.board_id))
    ).rejects.toMatchObject({ code: 403 });
    const result = await service.patch(
      null,
      request,
      ownershipParams(f.owner.user_id, f.board.board_id)
    );
    expect(result.previous_owner_access).toMatchObject({
      is_primary_owner: false,
      capabilities: expect.arrayContaining(['board.policy.manage']),
    });
  });

  for (const kind of ['board', 'branch'] as const) {
    dbTest(
      `allows a freshly checked tenant admin to transfer a ${kind}, not stale admin claims`,
      async ({ db }) => {
        const f = await ownershipFixture(db);
        const app = ownershipApp(db);
        const id = kind === 'board' ? f.board.board_id : f.branch.branch_id;
        const service = app.service(OWNERSHIP_TRANSFER_SERVICES[kind]);
        const request = {
          expected_owner_user_id: f.owner.user_id,
          target_user_id: f.successor.user_id,
        };
        await expect(
          service.patch(null, request, {
            ...ownershipParams(f.viewer.user_id, id),
            user: { user_id: f.viewer.user_id, role: 'admin' },
          })
        ).rejects.toMatchObject({ code: 403 });
        await expect(
          service.patch(null, request, ownershipParams(f.admin.user_id, id))
        ).resolves.toMatchObject({ primary_owner_user_id: f.successor.user_id });
        await expect(
          service.patch(null, request, ownershipParams(f.admin.user_id, id))
        ).rejects.toMatchObject({ code: 409 });
      }
    );
  }

  dbTest(
    'rejects viewer/missing/self targets and unsupported fields without publication',
    async ({ db }) => {
      const f = await ownershipFixture(db);
      const app = ownershipApp(db);
      const published = vi.fn();
      app.service('boards').on('patched', published);
      const service = app.service(OWNERSHIP_TRANSFER_SERVICES.board);
      for (const target of [f.viewer.user_id, generateId(), f.owner.user_id]) {
        await expect(
          service.patch(
            null,
            { expected_owner_user_id: f.owner.user_id, target_user_id: target },
            ownershipParams(f.owner.user_id, f.board.board_id)
          )
        ).rejects.toMatchObject({ code: 400 });
      }
      await expect(
        service.patch(
          null,
          {
            expected_owner_user_id: f.owner.user_id,
            target_user_id: f.successor.user_id,
            transferCredentials: true,
          },
          ownershipParams(f.owner.user_id, f.board.board_id)
        )
      ).rejects.toMatchObject({ code: 400 });
      await expect(
        service.patch(
          null,
          { expected_owner_user_id: f.owner.user_id, target_user_id: f.successor.user_id },
          { route: { id: f.board.board_id } }
        )
      ).rejects.toMatchObject({ code: 401 });
      expect(published).not.toHaveBeenCalled();
      expect(await f.policies.getBoardPolicies(f.board.board_id)).toMatchObject({
        primary_owner_user_id: f.owner.user_id,
      });
    }
  );

  dbTest(
    'rolls back ownership and publication if the surrounding transaction fails',
    async ({ db }) => {
      const f = await ownershipFixture(db);
      const app = ownershipApp(db);
      const published = vi.fn();
      app.service('boards').on('patched', published);
      await expect(
        runWithTenantDatabaseTransaction(db, undefined, async () => {
          await app.service(OWNERSHIP_TRANSFER_SERVICES.board).patch(
            null,
            {
              expected_owner_user_id: f.owner.user_id,
              target_user_id: f.successor.user_id,
            },
            ownershipParams(f.owner.user_id, f.board.board_id)
          );
          throw new Error('abort');
        })
      ).rejects.toThrow('abort');
      expect(await f.policies.getBoardPolicies(f.board.board_id)).toMatchObject({
        primary_owner_user_id: f.owner.user_id,
      });
      expect(published).not.toHaveBeenCalled();
    }
  );

  dbTest('checks successor eligibility again after a role change', async ({ db }) => {
    const f = await ownershipFixture(db);
    await new UsersRepository(db).update(f.successor.user_id, { role: 'viewer' });
    await expect(
      ownershipApp(db).service(OWNERSHIP_TRANSFER_SERVICES.board).patch(
        null,
        {
          expected_owner_user_id: f.owner.user_id,
          target_user_id: f.successor.user_id,
        },
        ownershipParams(f.owner.user_id, f.board.board_id)
      )
    ).rejects.toMatchObject({ code: 400 });
  });

  dbTest('only one competing transfer can replace the expected owner', async ({ db }) => {
    const f = await ownershipFixture(db);
    const service = ownershipApp(db).service(OWNERSHIP_TRANSFER_SERVICES.board);
    const transfer = (target: string) =>
      service.patch(
        null,
        {
          expected_owner_user_id: f.owner.user_id,
          target_user_id: target,
        },
        ownershipParams(f.admin.user_id, f.board.board_id)
      );
    const results = await Promise.allSettled([
      transfer(f.successor.user_id),
      transfer(f.admin.user_id),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ code: 409 });
  });

  for (const operation of ['delete', 'cleanup'] as const) {
    dbTest(`rejects transfer during branch ${operation}`, async ({ db }) => {
      const f = await ownershipFixture(db);
      await new BranchMaintenanceRepository(db).claim(
        f.branch.branch_id,
        operation,
        f.owner.user_id
      );
      const app = ownershipApp(db);
      const published = vi.fn();
      app.service('branches').on('patched', published);
      await expect(
        app.service(OWNERSHIP_TRANSFER_SERVICES.branch).patch(
          null,
          {
            expected_owner_user_id: f.owner.user_id,
            target_user_id: f.successor.user_id,
          },
          ownershipParams(f.owner.user_id, f.branch.branch_id)
        )
      ).rejects.toMatchObject({ code: 400 });
      expect((await f.policies.getBranchPolicy(f.branch.branch_id)).primary_owner_user_id).toBe(
        f.owner.user_id
      );
      expect(published).not.toHaveBeenCalled();
    });
  }

  dbTest(
    'does not reassign schedules or bypass session sharing and execution-home boundaries',
    async ({ db }) => {
      const f = await ownershipFixture(db, 'override');
      const schedules = new ScheduleRepository(db);
      const schedule = await schedules.create({
        branch_id: f.branch.branch_id,
        created_by: f.owner.user_id,
        name: 'Original owner heartbeat',
        cron_expression: '0 * * * *',
        timezone_mode: 'utc',
        prompt: 'Heartbeat',
        agentic_tool_config: { agentic_tool: 'claude-code' },
        enabled: true,
        allow_concurrent_runs: false,
        retention: 5,
      });
      await ownershipApp(db).service(OWNERSHIP_TRANSFER_SERVICES.branch).patch(
        null,
        {
          expected_owner_user_id: f.owner.user_id,
          target_user_id: f.successor.user_id,
        },
        ownershipParams(f.owner.user_id, f.branch.branch_id)
      );
      expect(await schedules.findById(schedule.schedule_id)).toEqual(schedule);
      const input = {
        branch_id: f.branch.branch_id,
        caller_user_id: f.successor.user_id,
        session_owner_user_id: f.owner.user_id,
      };
      expect(
        await f.policies.resolveSessionPromptAuthority({
          ...input,
          session_sdk_home_scope: 'execution_home',
        })
      ).toMatchObject({ allowed: false, denial_reason: 'execution_home_sharing_disabled' });
      expect(
        await f.policies.resolveSessionPromptAuthority({
          ...input,
          session_sdk_home_scope: 'branch',
        })
      ).toMatchObject({ allowed: false, denial_reason: 'workspace_session_sharing_disabled' });
      await f.policies.setWorkspacePreferences({ session_sharing_enabled: true }, f.admin.user_id);
      expect(
        await f.policies.resolveSessionPromptAuthority({
          ...input,
          session_sdk_home_scope: 'branch',
        })
      ).toMatchObject({ allowed: false, denial_reason: 'branch_session_sharing_disabled' });
      const policy = await f.policies.getBranchPolicy(f.branch.branch_id);
      policy.override_config!.allow_shared_session_prompts = true;
      await f.policies.replaceBranchPolicy(f.branch.branch_id, policy, f.successor.user_id);
      expect(
        await f.policies.resolveSessionPromptAuthority({
          ...input,
          session_sdk_home_scope: 'branch',
        })
      ).toMatchObject({ allowed: true, execution_user_id: f.successor.user_id });
      expect(
        await f.policies.resolveSessionPromptAuthority({
          ...input,
          caller_user_id: f.owner.user_id,
          session_sdk_home_scope: 'branch',
        })
      ).toMatchObject({ allowed: false, denial_reason: 'branch_access_required' });
    }
  );
});
