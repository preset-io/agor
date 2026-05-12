import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Application } from '@agor/core/feathers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureRepoOriginAlignedById,
  ensureRepoOriginAlignedForRepo,
  shouldRealignAfterRepoPatch,
} from './realign-repo-origin';

type RepoStub = {
  repo_id: string;
  slug: string;
  repo_type: 'remote' | 'local';
  remote_url?: string;
  local_path: string;
};

function makeApp(repo: RepoStub | undefined, opts: { getThrows?: boolean } = {}): Application {
  const get = vi.fn(async () => {
    if (opts.getThrows) throw new Error('repo lookup failed');
    return repo;
  });
  return {
    service: vi.fn(() => ({ get })),
  } as unknown as Application;
}

function withInitedRepo<T>(fn: (repoPath: string) => Promise<T>): Promise<T> {
  const repoPath = mkdtempSync(join(tmpdir(), 'agor-realign-it-'));
  const init = spawnSync('git', ['init', '-q', repoPath], { stdio: 'pipe' });
  if (init.status !== 0) {
    rmSync(repoPath, { recursive: true, force: true });
    throw new Error(`git init failed: ${init.stderr?.toString()}`);
  }
  return fn(repoPath).finally(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });
}

describe('ensureRepoOriginAligned', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns silently when the repos service throws (fire-and-forget contract)', async () => {
    const app = makeApp(undefined, { getThrows: true });
    await expect(ensureRepoOriginAlignedById(app, 'missing-id' as never)).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('no-ops on local repos (no canonical URL to align against)', async () => {
    await withInitedRepo(async (repoPath) => {
      const app = makeApp({
        repo_id: 'r1',
        slug: 'owner/local',
        repo_type: 'local',
        local_path: repoPath,
      });
      await ensureRepoOriginAlignedById(app, 'r1' as never);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  it('no-ops on remote repos missing remote_url (defensive)', async () => {
    await withInitedRepo(async (repoPath) => {
      const app = makeApp({
        repo_id: 'r2',
        slug: 'owner/no-url',
        repo_type: 'remote',
        local_path: repoPath,
      });
      await ensureRepoOriginAlignedById(app, 'r2' as never);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  it('no-ops when on-disk origin already matches the canonical URL (happy path)', async () => {
    await withInitedRepo(async (repoPath) => {
      const url = 'https://github.com/owner/repo.git';
      spawnSync('git', ['-C', repoPath, 'remote', 'add', 'origin', url], { stdio: 'pipe' });
      const app = makeApp({
        repo_id: 'r3',
        slug: 'owner/repo',
        repo_type: 'remote',
        remote_url: url,
        local_path: repoPath,
      });
      await ensureRepoOriginAlignedById(app, 'r3' as never);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  it('realigns on drift and emits a [SECURITY] log line that omits the previous URL', async () => {
    await withInitedRepo(async (repoPath) => {
      const taintedUrl =
        'https://x-access-token:ghp_AAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/owner/repo.git';
      const canonicalUrl = 'https://github.com/owner/repo.git';
      spawnSync('git', ['-C', repoPath, 'remote', 'add', 'origin', taintedUrl], { stdio: 'pipe' });

      const app = makeApp({
        repo_id: 'r4',
        slug: 'owner/repo',
        repo_type: 'remote',
        remote_url: canonicalUrl,
        local_path: repoPath,
      });
      await ensureRepoOriginAlignedById(app, 'r4' as never);

      const current = spawnSync('git', ['-C', repoPath, 'config', '--get', 'remote.origin.url'], {
        stdio: 'pipe',
      });
      expect(current.stdout.toString().trim()).toBe(canonicalUrl);

      expect(warnSpy).toHaveBeenCalledOnce();
      const logged = String(warnSpy.mock.calls[0]?.[0] ?? '');
      expect(logged).toMatch(/\[SECURITY\]/);
      expect(logged).toContain('r4');
      expect(logged).toContain('owner/repo');
      expect(logged).toContain(canonicalUrl);
      // The tainted previous value MUST NOT be in the log.
      expect(logged).not.toContain('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(logged).not.toContain('x-access-token');
    });
  });

  describe('shouldRealignAfterRepoPatch filter', () => {
    it('fires when remote_url is in the patch data (even when value is undefined)', () => {
      expect(shouldRealignAfterRepoPatch({ remote_url: 'https://github.com/foo/bar.git' })).toBe(
        true
      );
      expect(shouldRealignAfterRepoPatch({ remote_url: undefined })).toBe(true);
    });

    it("fires when clone_status transitions to 'ready' (executor signal)", () => {
      expect(shouldRealignAfterRepoPatch({ clone_status: 'ready' })).toBe(true);
    });

    it("does NOT fire on other clone_status transitions (e.g. 'failed' / 'cloning')", () => {
      expect(shouldRealignAfterRepoPatch({ clone_status: 'failed' })).toBe(false);
      expect(shouldRealignAfterRepoPatch({ clone_status: 'cloning' })).toBe(false);
    });

    it('does NOT fire on unrelated metadata patches', () => {
      expect(shouldRealignAfterRepoPatch({ name: 'renamed' })).toBe(false);
      expect(shouldRealignAfterRepoPatch({ slug: 'new/slug' as never })).toBe(false);
      expect(shouldRealignAfterRepoPatch({ default_branch: 'master' })).toBe(false);
    });

    it('does NOT fire on undefined / empty patch data (defensive)', () => {
      expect(shouldRealignAfterRepoPatch(undefined)).toBe(false);
      expect(shouldRealignAfterRepoPatch({})).toBe(false);
    });
  });

  it('ensureRepoOriginAlignedForRepo skips the DB fetch (caller already has the row)', async () => {
    await withInitedRepo(async (repoPath) => {
      const url = 'https://github.com/owner/repo.git';
      spawnSync('git', ['-C', repoPath, 'remote', 'add', 'origin', url], { stdio: 'pipe' });

      await ensureRepoOriginAlignedForRepo({
        repo_id: 'r5',
        slug: 'owner/repo',
        repo_type: 'remote',
        remote_url: url,
        local_path: repoPath,
      } as never);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
