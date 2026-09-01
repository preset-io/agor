import type { AgorConfig } from '@agor/core/config';
import {
  BranchRepository,
  RepoRepository,
  SessionRepository,
  TenantAgenticToolSettingsRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { SessionStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { SessionsService } from './sessions';

async function fixture(db: TenantScopeAwareDatabase) {
  const user = await new UsersRepository(db).create({
    email: `${generateId()}-sdk-home-session@example.com`,
    name: 'SDK home session owner',
  });
  const repo = await new RepoRepository(db).create({
    slug: `sdk-home-session-${generateId()}`,
    name: 'SDK home session repo',
    repo_type: 'remote',
    remote_url: 'https://example.com/sdk-home-session.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    repo_id: repo.repo_id,
    name: `sdk-home-${generateId()}`,
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    base_ref: 'main',
    new_branch: false,
    created_by: user.user_id,
  });
  return { user, branch };
}

function appWithMode(mode: 'inherit' | 'per_branch'): Application {
  const config = {
    execution: {
      unix_user_mode: 'sandbox',
      sandbox: { enabled: true, home_mode: 'per_user', sdk_home_mode: mode },
    },
  } as AgorConfig;
  return {
    get: (key: string) => (key === 'config' ? config : undefined),
  } as unknown as Application;
}

describe('SessionsService SDK-home admission', () => {
  dbTest('stamps the legacy-safe execution home while the deployment inherits', async ({ db }) => {
    const { user, branch } = await fixture(db);
    const service = new SessionsService(db, appWithMode('inherit'));

    const session = await service.create(
      {
        branch_id: branch.branch_id,
        created_by: user.user_id,
        agentic_tool: 'claude-code',
        status: SessionStatus.IDLE,
      },
      { _agenticConfigResolved: true } as never
    );

    expect(session.sdk_home_scope).toBe('execution_home');
    await expect(new BranchRepository(db).findById(branch.branch_id)).resolves.toMatchObject({
      sdk_home: undefined,
    });
  });

  dbTest('adopts the branch and stamps the fresh session in one admission', async ({ db }) => {
    const { user, branch } = await fixture(db);
    const service = new SessionsService(db, appWithMode('per_branch'));

    const session = await service.create(
      {
        branch_id: branch.branch_id,
        created_by: user.user_id,
        agentic_tool: 'claude-code',
        status: SessionStatus.IDLE,
      },
      { _agenticConfigResolved: true } as never
    );

    expect(session.sdk_home_scope).toBe('branch');
    await expect(new BranchRepository(db).findById(branch.branch_id)).resolves.toMatchObject({
      sdk_home: 'per_branch',
    });
  });

  dbTest(
    'admits an enabled built-in workload without requiring provider SDK state',
    async ({ db }) => {
      const { user, branch } = await fixture(db);
      await new TenantAgenticToolSettingsRepository(db).patch('workload', { enabled: true });
      const service = new SessionsService(db, appWithMode('per_branch'));

      await expect(
        service.create(
          {
            branch_id: branch.branch_id,
            created_by: user.user_id,
            agentic_tool: 'workload',
            status: SessionStatus.IDLE,
          },
          { _agenticConfigResolved: true } as never
        )
      ).resolves.toMatchObject({ agentic_tool: 'workload', sdk_home_scope: 'branch' });

      await expect(new BranchRepository(db).findById(branch.branch_id)).resolves.toMatchObject({
        sdk_home: 'per_branch',
      });
    }
  );

  dbTest('refuses an incompatible tool without adopting the branch', async ({ db }) => {
    const { user, branch } = await fixture(db);
    const service = new SessionsService(db, appWithMode('per_branch'));

    await expect(
      service.create(
        {
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'cursor',
          status: SessionStatus.IDLE,
        },
        { _agenticConfigResolved: true } as never
      )
    ).rejects.toThrow(/cannot use a branch SDK home/i);

    await expect(new BranchRepository(db).findById(branch.branch_id)).resolves.toMatchObject({
      sdk_home: undefined,
    });
    await expect(new SessionRepository(db).findAll()).resolves.toHaveLength(0);
  });

  dbTest(
    'admits local Codex native auth when the pinned sandbox overlay is available',
    async ({ db }) => {
      const { user, branch } = await fixture(db);
      await new UsersRepository(db).update(user.user_id, {
        agentic_auth_methods: { codex: 'subscription' },
      });
      const service = new SessionsService(db, appWithMode('per_branch'));

      await expect(
        service.create(
          {
            branch_id: branch.branch_id,
            created_by: user.user_id,
            agentic_tool: 'codex',
            status: SessionStatus.IDLE,
          },
          { _agenticConfigResolved: true } as never
        )
      ).resolves.toMatchObject({ sdk_home_scope: 'branch' });

      await expect(new BranchRepository(db).findById(branch.branch_id)).resolves.toMatchObject({
        sdk_home: 'per_branch',
      });
      await expect(new SessionRepository(db).findAll()).resolves.toHaveLength(1);
    }
  );

  dbTest('still refuses local Codex native auth without a per-user sandbox', async ({ db }) => {
    const { user, branch } = await fixture(db);
    await new UsersRepository(db).update(user.user_id, {
      agentic_auth_methods: { codex: 'subscription' },
    });
    const app = {
      get: (key: string) =>
        key === 'config'
          ? ({ execution: { sandbox: { sdk_home_mode: 'per_branch' } } } as AgorConfig)
          : undefined,
    } as unknown as Application;
    const service = new SessionsService(db, app);

    await expect(
      service.create(
        {
          branch_id: branch.branch_id,
          created_by: user.user_id,
          agentic_tool: 'codex',
          status: SessionStatus.IDLE,
        },
        { _agenticConfigResolved: true } as never
      )
    ).rejects.toThrow(/per-user sandbox credential overlay/i);

    await expect(new BranchRepository(db).findById(branch.branch_id)).resolves.toMatchObject({
      sdk_home: undefined,
    });
  });

  dbTest('rejects caller-controlled scope on create and patch', async ({ db }) => {
    const { user, branch } = await fixture(db);
    const service = new SessionsService(db, appWithMode('inherit'));

    await expect(
      service.create({
        branch_id: branch.branch_id,
        created_by: user.user_id,
        agentic_tool: 'claude-code',
        sdk_home_scope: 'branch',
      } as never)
    ).rejects.toThrow(/server-managed/);

    const session = await new SessionRepository(db).create({
      branch_id: branch.branch_id,
      created_by: user.user_id,
      agentic_tool: 'claude-code',
    });
    await expect(
      service.patch(session.session_id, { sdk_home_scope: 'branch' } as never)
    ).rejects.toThrow(/immutable and server-managed/);
  });
});
