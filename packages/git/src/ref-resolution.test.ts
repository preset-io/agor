import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGitRef } from './index.js';

describe('resolveGitRef', () => {
  let root: string;
  let repoPath: string;
  let firstSha: string;
  let secondSha: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agor-ref-resolution-'));
    repoPath = join(root, 'repo');
    await mkdir(repoPath);
    const repo = simpleGit(repoPath);
    await repo.init(['--initial-branch=main']);
    await repo.addConfig('user.name', 'Agor Test');
    await repo.addConfig('user.email', 'agor@example.test');
    await writeFile(join(repoPath, 'file.txt'), 'first\n');
    await repo.add('.').commit('first');
    firstSha = (await repo.revparse(['HEAD'])).trim();
    await repo.addTag('v1.0.0');
    await repo.branch(['local-only', firstSha]);

    await repo.checkoutLocalBranch('different');
    await writeFile(join(repoPath, 'file.txt'), 'second\n');
    await repo.add('.').commit('second');
    secondSha = (await repo.revparse(['HEAD'])).trim();
    await repo.checkout('main');

    // A slash is valid in a remote name, but Git 2.55 rejects configured
    // remote names when one is a prefix of another (for example, `origin`
    // plus `origin/fork`). Keep the slash coverage without constructing that
    // now-invalid overlapping configuration.
    for (const remote of ['origin', 'personal', 'company/fork']) {
      const remotePath = join(root, `${remote.replace('/', '-')}.git`);
      await mkdir(remotePath);
      await simpleGit(remotePath).init(['--bare', '--initial-branch=main']);
      await repo.addRemote(remote, remotePath);
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('resolves local-only and remote-only bare branches', async () => {
    const git = simpleGit(repoPath);
    await git.raw(['update-ref', 'refs/remotes/origin/remote-only', secondSha]);

    await expect(resolveGitRef(repoPath, 'local-only')).resolves.toMatchObject({
      ref: 'local-only',
      sha: firstSha,
      kind: 'local_branch',
    });
    await expect(resolveGitRef(repoPath, 'remote-only')).resolves.toMatchObject({
      ref: 'origin/remote-only',
      sha: secondSha,
      kind: 'remote_branch',
      remoteName: 'origin',
    });
  });

  it('discovers a remote-only branch that has no cached tracking ref', async () => {
    const git = simpleGit(repoPath);
    const originUrl = join(root, 'origin.git');
    await git.push('origin', 'different:refs/heads/network-only');

    await expect(
      resolveGitRef(repoPath, 'network-only', {
        remote: { name: 'origin', url: originUrl },
      })
    ).resolves.toMatchObject({
      ref: 'origin/network-only',
      sha: secondSha,
      kind: 'remote_branch',
      name: 'network-only',
      remoteName: 'origin',
    });
  });

  it('refuses a bare name when local and remote candidates disagree', async () => {
    const git = simpleGit(repoPath);
    await git.branch(['shared', firstSha]);
    await git.raw(['update-ref', 'refs/remotes/origin/shared', secondSha]);

    await expect(resolveGitRef(repoPath, 'shared')).rejects.toThrow(
      new RegExp(`local:shared @ ${firstSha}.*remote:origin/shared @ ${secondSha}`)
    );
  });

  it('uses local precedence only when all bare matches identify the same commit', async () => {
    const git = simpleGit(repoPath);
    await git.branch(['shared', firstSha]);
    await git.raw(['update-ref', 'refs/remotes/origin/shared', firstSha]);

    await expect(resolveGitRef(repoPath, 'shared')).resolves.toMatchObject({
      ref: 'shared',
      sha: firstSha,
      kind: 'local_branch',
    });
  });

  it('refuses a bare branch that disagrees across two remotes', async () => {
    const git = simpleGit(repoPath);
    await git.raw(['update-ref', 'refs/remotes/origin/shared', firstSha]);
    await git.raw(['update-ref', 'refs/remotes/personal/shared', secondSha]);

    await expect(resolveGitRef(repoPath, 'shared')).rejects.toThrow(
      /remote:origin\/shared.*remote:personal\/shared/
    );
  });

  it('uses qualified refs as-is without re-prefixing', async () => {
    const git = simpleGit(repoPath);
    await git.raw(['update-ref', 'refs/remotes/origin/main', firstSha]);

    const resolved = await resolveGitRef(repoPath, 'origin/main');
    expect(resolved).toMatchObject({
      input: 'origin/main',
      ref: 'origin/main',
      name: 'main',
      sha: firstSha,
      remoteName: 'origin',
    });
    expect(resolved.ref).not.toBe('origin/origin/main');
  });

  it('queries an explicitly named non-origin remote instead of treating its name as an origin branch', async () => {
    const git = simpleGit(repoPath);
    const personalUrl = join(root, 'personal.git');
    await git.push('personal', 'different:refs/heads/qualified');

    await expect(
      resolveGitRef(repoPath, 'personal/qualified', {
        remote: { name: 'origin', url: join(root, 'origin.git') },
      })
    ).resolves.toMatchObject({
      ref: 'personal/qualified',
      name: 'qualified',
      sha: secondSha,
      remoteName: 'personal',
      remoteUrl: personalUrl,
    });
  });

  it('recognizes a configured remote name containing a slash', async () => {
    const git = simpleGit(repoPath);
    await git.raw(['update-ref', 'refs/remotes/company/fork/main', secondSha]);

    await expect(resolveGitRef(repoPath, 'company/fork/main')).resolves.toMatchObject({
      ref: 'company/fork/main',
      name: 'main',
      sha: secondSha,
      remoteName: 'company/fork',
    });
  });

  it('resolves a raw commit SHA and a tag without rewriting either', async () => {
    await expect(resolveGitRef(repoPath, firstSha)).resolves.toMatchObject({
      ref: firstSha,
      sha: firstSha,
      kind: 'commit',
    });
    await expect(resolveGitRef(repoPath, 'v1.0.0', { refType: 'tag' })).resolves.toMatchObject({
      ref: 'v1.0.0',
      sha: firstSha,
      kind: 'tag',
    });
  });

  it('rejects a nonexistent ref with an actionable error', async () => {
    await expect(resolveGitRef(repoPath, 'does-not-exist')).rejects.toThrow(
      /does not exist.*explicit remote-qualified ref/i
    );
  });
});
