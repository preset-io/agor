import {
  BoardRepository,
  BranchRepository,
  CapabilityPolicyRepository,
  createTenantScopedDatabaseProxy,
  getCurrentTenantDatabaseScope,
  RepoRepository,
  runWithTenantDatabaseScope,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import {
  capabilityPolicyPresetCapabilities,
  type HookContext,
  type Session,
  SessionStatus,
  type TenantID,
} from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { generateId } from '../../../packages/core/src/lib/ids';
import type { McpContext } from '../src/mcp/server';
import { tenantScopedToolProxy } from '../src/mcp/tenant-scope';
import { registerSessionTools } from '../src/mcp/tools/sessions';
import { SessionsService } from '../src/services/sessions';
import { ensureCanView, loadSessionBranch } from '../src/utils/branch-authorization';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

// Real repositories + Feathers standard-method scopes, but no executor or
// external credentials. Custom spawn/fork deliberately are NOT hook-wrapped.
export async function childAdmissionFixture(
  rawDb: Parameters<typeof createTenantScopedDatabaseProxy>[0],
  sdkHomeScope: Session['sdk_home_scope'] = 'branch',
  tenantId = 'default' as TenantID
) {
  const db = createTenantScopedDatabaseProxy(rawDb, { label: 'daemon database' });
  const seeded = await runWithTenantDatabaseScope(db, tenantId, async () => {
    const users = new UsersRepository(db);
    const owner = await users.create({
      email: `${generateId()}@example.invalid`,
      unix_username: 'owner-home',
      role: 'member',
    });
    const caller = await users.create({
      email: `${generateId()}@example.invalid`,
      unix_username: 'caller-home',
      role: 'member',
    });
    const repo = await new RepoRepository(db).create({
      slug: `spawn-scope-${generateId()}`,
      repo_type: 'remote',
      remote_url: 'https://example.invalid/test.git',
      local_path: `/tmp/${generateId()}`,
      default_branch: 'main',
    });
    const board = await new BoardRepository(db).create({
      name: 'Spawn scope test',
      created_by: owner.user_id,
      access_mode: 'private',
    });
    const branch = await new BranchRepository(db).create({
      repo_id: repo.repo_id,
      board_id: board.board_id,
      permission_binding: 'inherit',
      created_by: owner.user_id,
      name: 'spawn-scope',
      ref: 'main',
      branch_unique_id: Math.floor(Math.random() * 1_000_000),
      path: `/tmp/${generateId()}`,
    });
    const parent = await new SessionRepository(db).create({
      branch_id: branch.branch_id,
      created_by: owner.user_id,
      unix_username: 'old-owner-home',
      sdk_home_scope: sdkHomeScope,
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      model_config: { mode: 'alias', model: 'sonnet', updated_at: new Date().toISOString() },
      tasks: [],
      genealogy: { children: [] },
    });
    return { owner, caller, board, branch, parent };
  });

  const app = feathers();
  app.set('config', { execution: { unix_user_mode: 'simple' } });
  const sessionsService = new SessionsService(db, app as unknown as McpContext['app']);
  app.use('sessions', sessionsService as never);
  app.use('branches', { get: (id: string) => new BranchRepository(db).findById(id) });
  app.use('users', { get: (id: string) => new UsersRepository(db).findById(id) });
  for (const path of ['sessions', 'branches', 'users']) {
    app.service(path).hooks({
      around: {
        all: [
          async (context: HookContext, next) => {
            await runWithTenantDatabaseScope(
              db,
              context.params.tenant?.tenant_id ?? tenantId,
              next
            );
          },
        ],
      },
    });
  }
  app.service('sessions').hooks({
    before: {
      get: [
        loadSessionBranch(new SessionRepository(db), new BranchRepository(db)),
        ensureCanView(),
      ],
    },
  });
  const prompt = vi.fn(async () => {
    // The child transaction must end before prompt/executor orchestration.
    expect(getCurrentTenantDatabaseScope()).toBeUndefined();
    return { task_id: generateId(), status: 'queued' };
  });
  app.use('/sessions/:id/prompt', { create: prompt });

  function toolsFor(user = seeded.owner, tenant: string | undefined = tenantId) {
    const ctx = {
      app,
      db,
      sessionId: seeded.parent.session_id,
      userId: user.user_id,
      authenticatedUser: user,
      baseServiceParams: {
        user,
        provider: 'mcp',
        authenticated: true,
        ...(tenant ? { tenant: { tenant_id: tenant, source: 'explicit' } } : {}),
      },
    } as unknown as McpContext;
    const handlers: Record<string, Handler> = {};
    const server = {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        handlers[name] = handler;
      },
    } as unknown as McpServer;
    registerSessionTools(tenantScopedToolProxy(server, ctx), ctx);
    return { handlers, ctx };
  }

  async function sharing(enabled = true, preset: 'collaborator' | 'viewer' = 'collaborator') {
    await runWithTenantDatabaseScope(db, tenantId, async () => {
      const policies = new CapabilityPolicyRepository(db);
      await policies.setWorkspacePreferences(
        { session_sharing_enabled: enabled },
        seeded.owner.user_id
      );
      const policy = await policies.getBoardPolicies(seeded.board.board_id);
      policy.branch_template.allow_shared_session_prompts = enabled;
      policy.branch_template.access.sharing_mode = 'shared';
      policy.branch_template.access.others = {
        preset,
        capabilities: capabilityPolicyPresetCapabilities('branch_access', preset, 'read') ?? [],
        fs_access: 'read',
      };
      await policies.replaceBoardPolicies(seeded.board.board_id, policy, seeded.owner.user_id);
    });
  }

  const count = () =>
    runWithTenantDatabaseScope(db, tenantId, () => new SessionRepository(db).findAll());
  return { ...seeded, db, tenantId, app, sessionsService, prompt, toolsFor, sharing, count };
}
