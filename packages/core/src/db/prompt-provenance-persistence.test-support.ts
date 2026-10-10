/**
 * Engine-independent proof that a stamped prompt survives persistence.
 *
 * `prompt_provenance` lives inside the shared `tasks.data` JSON column and no
 * query filters or indexes it, so SQLite and PostgreSQL should behave
 * identically here. "Should" is the reason this exists: the rendered block is
 * the only prompt text Agor itself authors, it carries non-ASCII separators,
 * and a recipient reading a mangled block cannot tell a transport bug from a
 * forgery. Both engines run the same assertions.
 */

import { expect } from 'vitest';
import { generateId } from '../lib/ids';
import {
  applyPromptProvenanceBlock,
  renderPromptProvenanceBlock,
} from '../templates/prompt-provenance';
import type { SessionID, TaskID, UUID } from '../types/id';
import { TaskStatus } from '../types/task';
import type { Database } from './client';
import {
  BranchRepository,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  UsersRepository,
} from './repositories';
import { runWithTenantDatabaseScope } from './tenant-scope';

let branchUnique = Date.now() % 1_000_000;

const ORIGIN_SESSION_ID = '01a0d369-82f3-7458-8265-861a4752b7b2';

export function stampedPrompt(): { prompt: string; block: string } {
  const block = renderPromptProvenanceBlock({
    origin: {
      sessionId: ORIGIN_SESSION_ID,
      sessionShortId: '01a0d369',
      branchVisible: true,
      branchName: 'elena',
      teammateName: 'Elena',
      agenticTool: 'claude-code',
    },
    userLabel: 'relay@example.invalid',
    authenticatedBy: 'personal_api_key',
    tool: 'agor_sessions_prompt',
    mode: 'continue',
  });
  return { prompt: applyPromptProvenanceBlock('push the branch', block).prompt, block };
}

/**
 * Persist one stamped Task through the ordinary admission repository call and
 * read it back through the ordinary reader.
 */
export async function assertStampedPromptRoundTrips(
  db: Database,
  tenantId: string
): Promise<{ taskId: TaskID; originBranchId: string }> {
  const { prompt, block } = stampedPrompt();

  const seeded = await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
    const user = await new UsersRepository(scoped).create({
      email: `${generateId()}@example.invalid`,
      name: 'Provenance fixture',
    });
    const repo = await new RepoRepository(scoped).create({
      repo_id: generateId(),
      slug: `prompt-provenance-${generateId()}`,
      name: 'Prompt provenance fixture',
      repo_type: 'remote',
      remote_url: 'https://example.invalid/prompt-provenance.git',
      local_path: `/disposable/${generateId()}`,
      default_branch: 'main',
    });
    const branch = await new BranchRepository(scoped).create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `prompt-provenance-${generateId()}`,
      ref: 'main',
      branch_unique_id: branchUnique++,
      path: `/disposable/${generateId()}`,
      created_by: user.user_id,
    });
    const session = await new SessionRepository(scoped).create({
      session_id: generateId() as SessionID,
      branch_id: branch.branch_id as UUID,
      created_by: user.user_id as UUID,
      agentic_tool: 'claude-code',
    });
    return { user, branch, session };
  });

  const created = await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
    new TaskRepository(scoped).createPending({
      session_id: seeded.session.session_id,
      created_by: seeded.user.user_id,
      full_prompt: prompt,
      status: TaskStatus.QUEUED,
      metadata: {
        system_authored: true,
        prompt_provenance: {
          version: 1,
          authenticated_by: 'personal_api_key',
          origin_session_id: ORIGIN_SESSION_ID as SessionID,
          origin_branch_id: seeded.branch.branch_id as UUID,
          origin_user_id: seeded.user.user_id as UUID,
          origin_agentic_tool: 'claude-code',
          tool: 'agor_sessions_prompt',
          mode: 'continue',
          stamped_at: '2026-09-24T12:00:00.000Z',
          rendered_block: block,
          placement: 'prefix',
          escaped_sentinels: 2,
        },
      },
    })
  );

  const persisted = await runWithTenantDatabaseScope(db, tenantId, (scoped) =>
    new TaskRepository(scoped).findById(created.task_id as TaskID)
  );

  // Byte-identical, including the non-ASCII separators in the detail line.
  expect(persisted?.full_prompt).toBe(prompt);
  expect(persisted?.metadata?.prompt_provenance?.rendered_block).toBe(block);
  expect(persisted?.metadata?.prompt_provenance).toMatchObject({
    version: 1,
    authenticated_by: 'personal_api_key',
    origin_session_id: ORIGIN_SESSION_ID,
    origin_agentic_tool: 'claude-code',
    tool: 'agor_sessions_prompt',
    mode: 'continue',
    placement: 'prefix',
    escaped_sentinels: 2,
  });

  // The grading must survive as its own value; a reader that sees only
  // "authenticated" would treat a named session like a signed one.
  expect(persisted?.metadata?.prompt_provenance?.authenticated_by).not.toBe('session_token');
  // The stamp travels with the prompt, not beside it.
  expect(persisted?.full_prompt.startsWith('<agor_prompt_provenance>')).toBe(true);
  expect(persisted?.full_prompt.endsWith('push the branch')).toBe(true);

  return { taskId: created.task_id as TaskID, originBranchId: seeded.branch.branch_id };
}
