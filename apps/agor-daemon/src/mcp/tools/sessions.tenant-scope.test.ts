import {
  BranchRepository,
  CapabilityPolicyRepository,
  getCurrentTenantDatabaseScope,
  MissingTenantDatabaseScopeError,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  SessionRepository,
} from '@agor/core/db';
import type { Session } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../../packages/core/src/lib/ids';
import { childAdmissionFixture as fixture } from '../../../test/session-child-admission';
import type { SessionsService } from '../../services/sessions';

const spawnArgs = { prompt: 'Scope regression', enableCallback: false, mcpServerIds: [] };

describe('MCP child admission with the armed tenant database guard', () => {
  beforeEach(() => vi.stubEnv('AGOR_BASE_URL', 'http://agor.test'));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  dbTest(
    'reproduces the exact pre-fix catch-all and its underlying scope error',
    async ({ db }) => {
      const f = await fixture(db);
      const authority = vi.spyOn(BranchRepository.prototype, 'resolveSessionPromptAuthority');
      const { ctx } = f.toolsFor();
      await expect(
        runWithTenantContext(f.tenantId, () =>
          (f.app.service('sessions') as unknown as SessionsService).spawn(
            f.parent.session_id,
            spawnArgs,
            ctx.baseServiceParams
          )
        )
      ).rejects.toThrow('Cannot resolve session-sharing authority for this branch.');
      expect(authority).toHaveBeenCalledOnce();
      await expect(authority.mock.results[0].value).rejects.toBeInstanceOf(
        MissingTenantDatabaseScopeError
      );
      expect(await f.count()).toHaveLength(1);
      expect(f.prompt).not.toHaveBeenCalled();
    }
  );

  for (const mode of ['spawn', 'subsession', 'fork', 'btw']) {
    dbTest(
      `${mode} admits an owner without enabling sharing and prompts outside the DB scope`,
      async ({ db }) => {
        const f = await fixture(db);
        const { handlers } = f.toolsFor();
        const result = await handlers[
          mode === 'spawn' ? 'agor_sessions_spawn' : 'agor_sessions_prompt'
        ]({
          ...spawnArgs,
          sessionId: f.parent.session_id,
          mode,
        });
        const child = JSON.parse(result.content[0].text).session as Session;
        expect(child).toMatchObject({
          created_by: f.owner.user_id,
          unix_username: 'owner-home',
          branch_id: f.branch.branch_id,
          sdk_home_scope: 'branch',
        });
        expect(await f.count()).toHaveLength(2);
        expect(f.prompt).toHaveBeenCalledOnce();
        expect(getCurrentTenantDatabaseScope()).toBeUndefined();
      }
    );
  }

  dbTest(
    'inherits Others sharing for a foreign caller without requiring board visibility',
    async ({ db }) => {
      const f = await fixture(db);
      await f.sharing();
      const { handlers } = f.toolsFor(f.caller);
      const result = await handlers.agor_sessions_spawn(spawnArgs);
      expect(JSON.parse(result.content[0].text).session).toMatchObject({
        created_by: f.caller.user_id,
        unix_username: 'caller-home',
        sdk_home_scope: 'branch',
      });
      await runWithTenantDatabaseScope(f.db, f.tenantId, async () => {
        expect(
          (
            await new CapabilityPolicyRepository(f.db).resolveBoardAccess(
              f.board.board_id,
              f.caller.user_id
            )
          ).capabilities
        ).toEqual([]);
      });
    }
  );

  dbTest(
    'a cross-branch subsession uses the target parent policy and stays in that branch',
    async ({ db }) => {
      const f = await fixture(db);
      await f.sharing();
      const source = await runWithTenantDatabaseScope(f.db, f.tenantId, async () => {
        const sourceBranch = await new BranchRepository(f.db).create({
          repo_id: f.branch.repo_id,
          created_by: f.caller.user_id,
          name: 'remote-source',
          ref: 'main',
          branch_unique_id: 8_690_002,
          path: `/tmp/${generateId()}`,
        });
        return new SessionRepository(f.db).create({
          branch_id: sourceBranch.branch_id,
          created_by: f.caller.user_id,
          agentic_tool: 'claude-code',
          sdk_home_scope: 'branch',
        });
      });
      const { ctx, handlers } = f.toolsFor(f.caller);
      ctx.sessionId = source.session_id;
      const result = await handlers.agor_sessions_prompt({
        ...spawnArgs,
        mode: 'subsession',
        sessionId: f.parent.session_id,
      });
      expect(JSON.parse(result.content[0].text).session).toMatchObject({
        branch_id: f.branch.branch_id,
        created_by: f.caller.user_id,
        genealogy: { parent_session_id: f.parent.session_id },
      });
      // Owning the orchestration branch does not authorize a revoked target.
      await f.sharing(false);
      await expect(
        handlers.agor_sessions_prompt({
          ...spawnArgs,
          mode: 'subsession',
          sessionId: f.parent.session_id,
        })
      ).rejects.toThrow(/sharing/i);
      expect(await f.count()).toHaveLength(3);
      expect(f.prompt).toHaveBeenCalledOnce();
    }
  );

  for (const denial of [
    'workspace',
    'branch',
    'viewer',
    'superadmin',
    'execution_home',
    'missing_policy',
  ]) {
    dbTest(`fails closed without persisting or prompting a child: ${denial}`, async ({ db }) => {
      const f = await fixture(db, denial === 'execution_home' ? 'execution_home' : 'branch');
      await f.sharing(
        denial !== 'workspace',
        ['viewer', 'superadmin'].includes(denial) ? 'viewer' : 'collaborator'
      );
      await runWithTenantDatabaseScope(f.db, f.tenantId, async () => {
        const policies = new CapabilityPolicyRepository(f.db);
        if (denial === 'branch' || denial === 'missing_policy') {
          const policy = await policies.getBranchPolicy(f.branch.branch_id);
          await policies.replaceBranchPolicy(
            f.branch.branch_id,
            {
              ...policy,
              binding_mode: 'override',
              override_config: { ...policy.inherited_config!, allow_shared_session_prompts: false },
            },
            f.owner.user_id
          );
        }
      });
      if (denial === 'missing_policy') {
        vi.spyOn(BranchRepository.prototype, 'resolveSessionPromptAuthority').mockRejectedValueOnce(
          new Error('policy unavailable')
        );
      }
      const { handlers } = f.toolsFor(
        denial === 'superadmin' ? { ...f.caller, role: 'superadmin' } : f.caller
      );
      await expect(handlers.agor_sessions_spawn(spawnArgs)).rejects.toThrow(
        denial === 'missing_policy'
          ? 'Cannot resolve session-sharing authority'
          : ['viewer', 'superadmin'].includes(denial)
            ? /Only Collaborators and Managers/
            : /shar/i
      );
      expect(await f.count()).toHaveLength(1);
      expect(f.prompt).not.toHaveBeenCalled();
    });
  }

  dbTest(
    'refuses missing tenant identity and conflicting tenant context before child side effects',
    async ({ db }) => {
      const f = await fixture(db);
      const missing = f.toolsFor(f.owner, undefined);
      // Explicitly remove identity; the helper's optional parameter defaults for normal callers.
      delete missing.ctx.baseServiceParams.tenant;
      await expect(missing.handlers.agor_sessions_spawn(spawnArgs)).rejects.toThrow(
        'Cannot resolve session-sharing authority'
      );
      const { handlers } = f.toolsFor();
      await expect(
        Promise.resolve().then(() =>
          runWithTenantContext('foreign-tenant', () => handlers.agor_sessions_spawn(spawnArgs))
        )
      ).rejects.toThrow(/tenant/i);
      expect(await f.count()).toHaveLength(1);
      expect(f.prompt).not.toHaveBeenCalled();
    }
  );
});
