import type { Application } from '@agor/core/feathers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureRepoOriginAlignedById,
  ensureRepoOriginAlignedForRepo,
  shouldRealignAfterRepoPatch,
} from './realign-repo-origin';
import { spawnExecutorFireAndForget } from './spawn-executor.js';

vi.mock('./spawn-executor.js', () => ({
  generateSessionToken: vi.fn(() => 'service-token'),
  generateScopedServiceToken: vi.fn(() => 'service-token'),
  getDaemonUrl: vi.fn(() => 'http://localhost:3030'),
  serviceTokenScopeForParams: vi.fn(() => ({})),
  spawnExecutorFireAndForget: vi.fn(),
}));

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
    settings: { authentication: { secret: 'test-secret' } },
    service: vi.fn(() => ({ get })),
  } as unknown as Application;
}

const spawnMock = vi.mocked(spawnExecutorFireAndForget);

describe('ensureRepoOriginAligned', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    spawnMock.mockClear();
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns silently when the repos service throws (fire-and-forget contract)', async () => {
    const app = makeApp(undefined, { getThrows: true });
    await expect(ensureRepoOriginAlignedById(app, 'missing-id' as never)).resolves.toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('no-ops on local repos (no canonical URL to align against)', async () => {
    const app = makeApp({
      repo_id: 'r1',
      slug: 'owner/local',
      repo_type: 'local',
      local_path: '/tmp/local',
    });
    await ensureRepoOriginAlignedById(app, 'r1' as never);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('no-ops on remote repos missing remote_url (defensive)', async () => {
    const app = makeApp({
      repo_id: 'r2',
      slug: 'owner/no-url',
      repo_type: 'remote',
      local_path: '/tmp/no-url',
    });
    await ensureRepoOriginAlignedById(app, 'r2' as never);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns git.repo.realign-origin for remote repos with a canonical URL', async () => {
    const app = makeApp({
      repo_id: '550e8400-e29b-41d4-a716-446655440000',
      slug: 'owner/repo',
      repo_type: 'remote',
      remote_url: 'https://github.com/owner/repo.git',
      local_path: '/tmp/repo',
    });

    await ensureRepoOriginAlignedById(app, '550e8400-e29b-41d4-a716-446655440000' as never);

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0]?.[0]).toMatchObject({
      command: 'git.repo.realign-origin',
      sessionToken: 'service-token',
      daemonUrl: 'http://localhost:3030',
      params: { repoId: '550e8400-e29b-41d4-a716-446655440000' },
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
    const app = makeApp(undefined);
    await ensureRepoOriginAlignedForRepo(app, {
      repo_id: '550e8400-e29b-41d4-a716-446655440001',
      slug: 'owner/repo',
      repo_type: 'remote',
      remote_url: 'https://github.com/owner/repo.git',
      local_path: '/tmp/repo',
    } as never);

    expect(app.service).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledOnce();
  });
});
