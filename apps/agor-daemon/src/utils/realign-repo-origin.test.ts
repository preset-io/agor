/**
 * Tests for `ensureRepoOriginAligned` — the daemon-side wrapper that takes a
 * `repoId`, looks up the canonical URL from the DB via Feathers, and delegates
 * to `ensureGitRemoteUrl`.
 *
 * The integration with real git is already covered by
 * `packages/core/src/git/credential-env.test.ts` (the `ensureGitRemoteUrl`
 * suite that spawns real git against temp repos). These tests cover the
 * *wrapper's* responsibilities: skip when the repo isn't realignable, log on
 * drift, swallow errors.
 */

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

/**
 * Build a minimal Application stub whose `service('repos').get(id)` returns
 * the provided repo (or throws if `getThrows: true`). Sufficient for the
 * wrapper, which never touches anything else on `app`.
 */
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
    // Capture [SECURITY] log lines without polluting test output.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns silently when the repos service throws (fire-and-forget contract)', async () => {
    // If the repo is missing or the service is unavailable, the wrapper must
    // not propagate — callers depend on this being best-effort.
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
        // local repos legitimately have no remote_url
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
        // remote_url undefined — shouldn't happen for healthy rows but the
        // type marks it optional, so the wrapper has to handle it.
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
      // No drift → no [SECURITY] log emitted.
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  it('realigns on drift and emits a [SECURITY] log line that omits the previous URL', async () => {
    await withInitedRepo(async (repoPath) => {
      // Simulate the leak: agent baked a token into origin.
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

      // On-disk URL was scrubbed back to the canonical value.
      const current = spawnSync('git', ['-C', repoPath, 'config', '--get', 'remote.origin.url'], {
        stdio: 'pipe',
      });
      expect(current.stdout.toString().trim()).toBe(canonicalUrl);

      // Security log fired exactly once. Critically: the *previous* URL is
      // NOT in the log payload (it could carry a token).
      expect(warnSpy).toHaveBeenCalledOnce();
      const logged = String(warnSpy.mock.calls[0]?.[0] ?? '');
      expect(logged).toMatch(/\[SECURITY\]/);
      expect(logged).toContain('r4');
      expect(logged).toContain('owner/repo');
      expect(logged).toContain(canonicalUrl);
      // Tainted token / userinfo MUST NOT appear.
      expect(logged).not.toContain('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(logged).not.toContain('x-access-token');
    });
  });

  describe('shouldRealignAfterRepoPatch filter', () => {
    // The Feathers after-hook fires on every patch — this filter is what
    // keeps us from doing spurious git work on metadata-only updates.

    it('fires when remote_url is in the patch data (even when value is undefined)', () => {
      // Object.hasOwn semantics — explicit "clear remote_url" still counts
      // as a change to the canonical URL. The on-disk side should be
      // re-checked.
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
    // The byRepo variant is the optimization for after-hooks where
    // context.result already IS the Repo. It must not touch any service.
    await withInitedRepo(async (repoPath) => {
      const url = 'https://github.com/owner/repo.git';
      spawnSync('git', ['-C', repoPath, 'remote', 'add', 'origin', url], { stdio: 'pipe' });

      // No `app` parameter at all — pure repo row in.
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
