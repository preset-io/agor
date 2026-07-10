import {
  BranchRepository,
  generateId,
  KnowledgeNamespaceRepository,
  RepoRepository,
  shortId,
  UsersRepository,
} from '@agor/core/db';
import type { BranchID, UserID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { ensureTeammateKnowledgeNamespace } from './teammate-knowledge';

describe('ensureTeammateKnowledgeNamespace', () => {
  dbTest('creates an open primary namespace and stores teammate kb config', async ({ db }) => {
    const user = await new UsersRepository(db).create({
      user_id: generateId() as UserID,
      email: `teammate-kb-${Date.now()}@test.local`,
      name: 'Teammate Owner',
      role: 'member',
    });
    const repo = await new RepoRepository(db).create({
      repo_id: generateId(),
      slug: `teammate-kb-repo-${Date.now()}`,
      name: 'Teammate KB Repo',
      repo_type: 'remote',
      remote_url: 'https://github.com/test/repo.git',
      local_path: '/tmp/repo',
      default_branch: 'main',
    });
    const branch = await new BranchRepository(db).create({
      branch_id: generateId() as BranchID,
      repo_id: repo.repo_id,
      name: 'teammate-branch',
      ref: 'teammate-branch',
      branch_unique_id: 1,
      created_by: user.user_id,
      custom_context: {
        teammate: { kind: 'teammate', displayName: 'Helper' },
      },
    });

    const result = await ensureTeammateKnowledgeNamespace(db, branch.branch_id, user.user_id);

    expect(result.namespace).toMatchObject({
      slug: `teammate-${shortId(branch.branch_id)}`,
      display_name: 'Helper Memory',
      kind: 'branch',
      branch_id: branch.branch_id,
      repo_id: repo.repo_id,
      visibility_default: 'public',
      others_can: 'write',
      owner_user_id: user.user_id,
    });
    expect(result.branch.custom_context?.teammate).toMatchObject({
      kind: 'teammate',
      displayName: 'Helper',
      kb: {
        primary_namespace_id: result.namespace.namespace_id,
        primary_namespace_slug: result.namespace.slug,
        memory_path_template: 'memory/{{YYYY-MM-DD}}.md',
        default_visibility: 'public',
        global_access: 'write',
      },
    });

    const acl = await new KnowledgeNamespaceRepository(db).listNamespaceAcl(
      result.namespace.namespace_id
    );
    expect(acl).toEqual([
      expect.objectContaining({
        subject_type: 'user',
        subject_id: user.user_id,
        permission: 'own',
      }),
    ]);

    const again = await ensureTeammateKnowledgeNamespace(db, branch.branch_id, user.user_id);
    expect(again.namespace.namespace_id).toBe(result.namespace.namespace_id);
  });
});
