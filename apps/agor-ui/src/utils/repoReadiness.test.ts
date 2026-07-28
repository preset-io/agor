import type { Repo } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { getRepoBranchCreationBlockReason, isRepoReadyForBranchCreation } from './repoReadiness';

function repo(overrides: Partial<Repo>): Repo {
  return {
    repo_id: 'repo-1',
    slug: 'org/repo',
    name: 'Repo',
    repo_type: 'remote',
    ...overrides,
  } as Repo;
}

describe('repository branch readiness', () => {
  it('allows ready and legacy rows but blocks active/failed clones', () => {
    expect(isRepoReadyForBranchCreation(repo({ clone_status: 'ready' }))).toBe(true);
    expect(isRepoReadyForBranchCreation(repo({ clone_status: undefined }))).toBe(true);
    expect(isRepoReadyForBranchCreation(repo({ clone_status: 'cloning' }))).toBe(false);
    expect(isRepoReadyForBranchCreation(repo({ clone_status: 'failed' }))).toBe(false);
  });

  it('surfaces the durable timeout category and message', () => {
    expect(
      getRepoBranchCreationBlockReason(
        repo({
          clone_status: 'failed',
          clone_error: {
            exit_code: 124,
            category: 'timeout',
            message: 'Clone timed out after 30 minutes.',
          },
        })
      )
    ).toMatch(/failed \(timeout\).*Clone timed out after 30 minutes.*Retry/i);
  });
});
