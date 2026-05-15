import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Repo, Worktree } from '../types';
import {
  assertWorktreeFsAvailable,
  detectWorktreeFsDrift,
  isMissingPathError,
  MissingPathError,
} from './index';

const fakeWorktree = (overrides: Partial<Worktree> & { path: string }): Worktree =>
  ({
    worktree_id: 'wt_00000000-0000-0000-0000-000000000001' as Worktree['worktree_id'],
    repo_id: 'rp_00000000-0000-0000-0000-000000000002' as Worktree['repo_id'],
    name: 'feat-fix',
    ...overrides,
  }) as Worktree;

const fakeRepo = (overrides: Partial<Repo> & { local_path: string }): Repo =>
  ({
    repo_id: 'rp_00000000-0000-0000-0000-000000000002' as Repo['repo_id'],
    slug: 'preset-io/agor',
    name: 'agor',
    ...overrides,
  }) as Repo;

describe('assertWorktreeFsAvailable', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-fs-check-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('passes when both repo and worktree paths exist', () => {
    const worktree = fakeWorktree({ path: tmpDir });
    const repo = fakeRepo({ local_path: tmpDir });
    expect(() => assertWorktreeFsAvailable({ worktree, repo })).not.toThrow();
  });

  it('throws REPO_PATH_MISSING with priority when repo path is gone', () => {
    const worktree = fakeWorktree({ path: tmpDir }); // worktree path exists
    const repo = fakeRepo({ local_path: path.join(tmpDir, 'gone-repo') });
    // even though the worktree path is present, the repo miss must surface
    // first since recovery requires recloning the repo before recreating
    // worktrees
    let thrown: unknown;
    try {
      assertWorktreeFsAvailable({ worktree, repo });
    } catch (err) {
      thrown = err;
    }
    expect(isMissingPathError(thrown)).toBe(true);
    const e = thrown as MissingPathError;
    expect(e.data.code).toBe('REPO_PATH_MISSING');
    expect(e.data.subject).toBe('repo');
    expect(e.data.path).toBe(repo.local_path);
    expect(e.data.action).toBe('reclone_or_delete');
    expect(e.data.repo_id).toBe(repo.repo_id);
    expect(e.data.worktree_id).toBe(worktree.worktree_id);
    // surfaceable through Feathers as 422
    expect(e.code).toBe(422);
  });

  it('throws WORKTREE_PATH_MISSING when only the worktree path is gone', () => {
    const worktree = fakeWorktree({ path: path.join(tmpDir, 'gone-wt') });
    const repo = fakeRepo({ local_path: tmpDir });
    let thrown: unknown;
    try {
      assertWorktreeFsAvailable({ worktree, repo });
    } catch (err) {
      thrown = err;
    }
    expect(isMissingPathError(thrown)).toBe(true);
    const e = thrown as MissingPathError;
    expect(e.data.code).toBe('WORKTREE_PATH_MISSING');
    expect(e.data.subject).toBe('worktree');
    expect(e.data.path).toBe(worktree.path);
    expect(e.data.worktree_id).toBe(worktree.worktree_id);
    expect(e.data.repo_id).toBe(worktree.repo_id);
  });

  it('throws WORKTREE_PATH_MISSING when repo is unknown but worktree is gone', () => {
    const worktree = fakeWorktree({ path: path.join(tmpDir, 'gone-wt') });
    expect(() => assertWorktreeFsAvailable({ worktree })).toThrow(MissingPathError);
  });

  it('error message references the missing path and the standard K8s drift hint', () => {
    const worktree = fakeWorktree({ path: path.join(tmpDir, 'gone-wt') });
    let thrown: unknown;
    try {
      assertWorktreeFsAvailable({ worktree });
    } catch (err) {
      thrown = err;
    }
    const e = thrown as MissingPathError;
    expect(e.message).toContain(worktree.path);
    expect(e.message).toContain('Kubernetes');
  });
});

describe('detectWorktreeFsDrift', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-fs-check-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when everything is present', () => {
    const worktree = fakeWorktree({ path: tmpDir });
    const repo = fakeRepo({ local_path: tmpDir });
    expect(detectWorktreeFsDrift({ worktree, repo })).toBeNull();
  });

  it('reports repo drift before worktree drift', () => {
    const worktree = fakeWorktree({ path: path.join(tmpDir, 'gone-wt') });
    const repo = fakeRepo({ local_path: path.join(tmpDir, 'gone-repo') });
    expect(detectWorktreeFsDrift({ worktree, repo })).toEqual({
      subject: 'repo',
      path: repo.local_path,
    });
  });

  it('reports worktree drift when repo is present', () => {
    const worktree = fakeWorktree({ path: path.join(tmpDir, 'gone-wt') });
    const repo = fakeRepo({ local_path: tmpDir });
    expect(detectWorktreeFsDrift({ worktree, repo })).toEqual({
      subject: 'worktree',
      path: worktree.path,
    });
  });
});
