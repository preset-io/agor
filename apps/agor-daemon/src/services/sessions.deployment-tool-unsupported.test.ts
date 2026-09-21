/**
 * OpenCode can be installed yet unsupported by this deployment's execution
 * topology (hosted workspace without the hosted native-state contract). The
 * sessions service must refuse to create or switch to such a tool with the
 * same structured reason the settings and prompt paths report, before any
 * session row exists (scenarios OC-02 and OC-62; scheduled, fork, and spawn
 * creation all route through `create`).
 */
import {
  BranchRepository,
  generateId,
  RepoRepository,
  SessionRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { BadRequest } from '@agor/core/feathers';
import type { AgenticToolName, Session, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { SessionsService } from './sessions';

const STUB_APP = {} as unknown as Application;
const TEST_USER_ID = '00000000-0000-7000-8000-000000000001' as UUID;
const UNSUPPORTED_CODE = 'hosted_native_state_disabled';

async function createBranch(db: any): Promise<UUID> {
  await new UsersRepository(db).create({
    user_id: TEST_USER_ID,
    email: `tool-unsupported-${generateId()}@example.com`,
    name: 'Test User',
  });
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `repo-${generateId()}`,
    name: 'Test Repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/test-repo',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'feature',
    ref: 'feature',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: '/tmp/test-repo',
    base_ref: 'main',
    new_branch: false,
    created_by: TEST_USER_ID,
  });
  return branch.branch_id as UUID;
}

function unsupportedOpenCode(tool: AgenticToolName): BadRequest | undefined {
  if (tool !== 'opencode') return undefined;
  return new BadRequest('OpenCode is not available in this workspace', {
    code: UNSUPPORTED_CODE,
  });
}

describe('SessionsService deployment tool unsupported refusal', () => {
  dbTest('refuses to create an OpenCode session before any row is written', async ({ db }) => {
    const unsupported = vi.fn(unsupportedOpenCode);
    const service = new SessionsService(db, STUB_APP, () => true, unsupported);
    const branchId = await createBranch(db);

    await expect(
      service.create({
        branch_id: branchId,
        agentic_tool: 'opencode',
        status: SessionStatus.IDLE,
        created_by: TEST_USER_ID,
      } as never)
    ).rejects.toMatchObject({ data: { code: UNSUPPORTED_CODE } });
    expect(unsupported).toHaveBeenCalledWith('opencode');
    expect(await new SessionRepository(db).findAll()).toEqual([]);
  });

  dbTest('refuses switching an existing session to an unsupported tool', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP, () => true, unsupportedOpenCode);
    const branchId = await createBranch(db);
    const sessionRepo = new SessionRepository(db);
    const session = await sessionRepo.create({
      session_id: generateId(),
      branch_id: branchId,
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      created_by: TEST_USER_ID,
      tasks: [],
      contextFiles: [],
      genealogy: { children: [] },
    });

    await expect(
      service.patch(session.session_id, { agentic_tool: 'opencode' })
    ).rejects.toMatchObject({ data: { code: UNSUPPORTED_CODE } });
    expect(((await sessionRepo.findById(session.session_id)) as Session).agentic_tool).toBe(
      'claude-code'
    );
  });
});
