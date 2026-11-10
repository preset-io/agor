import { RepoRepository, runWithTenantDatabaseScope } from '@agor/core/db';
import { feathers } from '@agor/core/feathers';
import type { Application, Repo, RepoSlug, TenantID, UserID, UserRole } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import type { McpServer } from '@modelcontextprotocol/server';
import { expect } from 'vitest';
import { dbTest } from '../../../../../packages/core/src/db/test-helpers';
import { ReposService } from '../../services/repos.js';
import { requireAdminForEnvConfig, requireMinimumRole } from '../../utils/authorization.js';
import type { McpContext } from '../server.js';
import { registerRepoTools } from './repos.js';

type Handler = (
  input: Record<string, unknown>
) => Promise<{ content: Array<{ type: string; text: string }> }>;

dbTest(
  'agor_repos_update denies members with the admin error regardless of payload',
  async ({ db }) => {
    const tenantId = 'tenant-a' as TenantID;
    const repository = new RepoRepository(db);
    const inScope = <T>(work: () => Promise<T>) => runWithTenantDatabaseScope(db, tenantId, work);
    const seed = (slug: string) =>
      inScope(() =>
        repository.create({
          slug: slug as RepoSlug,
          name: slug,
          repo_type: 'remote',
          remote_url: `https://github.com/${slug}.git`,
          local_path: `/test/repos/${slug}`,
          default_branch: 'main',
        })
      );
    const shared = await seed('acme/shared');
    await seed('acme/existing');

    const app = feathers() as Application;
    app.set('config', {});
    app.use('repos', new ReposService(db, app));
    // Mirrors the registered repos patch chain, so no hook can answer before the service.
    app.service('repos').hooks({
      before: {
        patch: [
          requireMinimumRole(ROLES.MEMBER, 'update repositories'),
          requireAdminForEnvConfig(),
        ],
      },
    });
    const updateTool = (role: UserRole): Handler => {
      let handler: Handler | undefined;
      const server = {
        registerTool: (name: string, _config: unknown, fn: Handler) => {
          if (name === 'agor_repos_update') handler = fn;
        },
      } as unknown as McpServer;
      const baseServiceParams: McpContext['baseServiceParams'] = {
        provider: 'mcp',
        authenticated: true,
        tenant: { tenant_id: tenantId, source: 'auth_claim' },
        user: { user_id: 'caller' as UserID, role, email: 'caller@example.test' },
      };
      registerRepoTools(server, { app, db, baseServiceParams } as McpContext);
      if (!handler) throw new Error('Missing agor_repos_update tool');
      return handler;
    };

    const member = updateTool(ROLES.MEMBER);
    for (const patch of [
      { slug: 'acme/existing' },
      { slug: 'not a slug' },
      { remote_url: 'https://attacker.example/shared.git' },
      { default_branch: 'attacker' },
      { repo_type: 'local' },
    ]) {
      await expect(member({ repoId: shared.repo_id, ...patch })).rejects.toThrow(
        'Admin access is required to change repository settings'
      );
    }
    // A missing repository answers the same, so the denial is no existence oracle.
    await expect(
      member({ repoId: '550e8400-e29b-41d4-a716-446655440099', default_branch: 'x' })
    ).rejects.toThrow('Admin access is required to change repository settings');
    expect(await inScope(() => repository.findById(shared.repo_id))).toEqual(shared);

    const admin = updateTool(ROLES.ADMIN);
    await expect(admin({ repoId: shared.repo_id, slug: 'acme/existing' })).rejects.toThrow(
      "A repository with slug 'acme/existing' already exists"
    );
    const result = await admin({
      repoId: shared.repo_id,
      remote_url: 'https://github.com/acme/shared-moved.git',
      default_branch: 'develop',
    });
    expect(JSON.parse(result.content[0].text) as Repo).toMatchObject({
      remote_url: 'https://github.com/acme/shared-moved.git',
      default_branch: 'develop',
    });
    expect(await inScope(() => repository.findById(shared.repo_id))).toMatchObject({
      remote_url: 'https://github.com/acme/shared-moved.git',
      default_branch: 'develop',
    });
  }
);
