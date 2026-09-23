import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBranch, resolveGitRef, restoreBranchFilesystem } from './index.js';

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

  it('pins a remote-only template without borrowing conflicting local cache refs', async () => {
    const git = simpleGit(repoPath);
    const remoteUrl = join(root, 'personal.git');
    await git.push('personal', 'different:refs/heads/local-only');
    await git.raw(['update-ref', 'refs/remotes/origin/local-only', firstSha]);

    await expect(
      resolveGitRef(repoPath, 'local-only', { remote: { url: remoteUrl }, remoteOnly: true })
    ).resolves.toMatchObject({
      ref: 'local-only',
      name: 'local-only',
      sha: secondSha,
      kind: 'remote_branch',
      remoteUrl,
    });
    expect((await git.revparse(['local-only'])).trim()).toBe(firstSha);
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
  it('does not send managed credentials to an unrelated configured remote', async () => {
    const authorization: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      authorization.push(req.headers.authorization);
      res.setHeader('Content-Type', 'text/plain');
      res.end(
        req.url?.includes('info/refs')
          ? `${secondSha}\trefs/heads/topic\n`
          : 'ref: refs/heads/topic\n'
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      const attackerUrl = `http://127.0.0.1:${address.port}/repo.git`;
      await simpleGit(repoPath).remote(['set-url', 'personal', attackerUrl]);
      await expect(
        resolveGitRef(repoPath, 'personal/topic', {
          remote: { name: 'origin', url: 'https://authorized.example/repo.git' },
          env: {
            GITHUB_TOKEN: 'synthetic-tenant-a-token',
            HTTPS_PROXY: 'http://user:password@unrelated.invalid',
          },
        })
      ).resolves.toMatchObject({ sha: secondSha, remoteUrl: attackerUrl });
      expect(authorization.length).toBeGreaterThan(0);
      expect(authorization.every((header) => header === undefined)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('keeps slash-containing tags in the tag namespace', async () => {
    const git = simpleGit(repoPath);
    await git.addTag('origin/release');
    await git.push('origin', 'refs/tags/origin/release');
    for (const remoteOnly of [false, true]) {
      await expect(
        resolveGitRef(repoPath, 'origin/release', {
          refType: 'tag',
          remoteOnly,
          remote: { name: 'origin', url: join(root, 'origin.git') },
        })
      ).resolves.toMatchObject({ kind: 'tag', name: 'origin/release', sha: firstSha });
    }
  });

  it('resolves remotely without constructing a client at an unavailable cache', async () => {
    await simpleGit(repoPath).push('origin', 'main');
    await expect(
      resolveGitRef(join(root, 'unmounted'), 'main', {
        remoteOnly: true,
        remote: { name: 'origin', url: join(root, 'origin.git') },
      })
    ).resolves.toMatchObject({ sha: firstSha, name: 'main' });
  });

  it('acquires a non-origin source object absent from the cache and destination', async () => {
    const git = simpleGit(repoPath);
    await git.push('origin', 'main');
    const producer = join(root, 'producer');
    await simpleGit().clone(repoPath, producer);
    const writer = simpleGit(producer);
    await writer.addConfig('user.name', 'Test');
    await writer.addConfig('user.email', 'test@example.test');
    await writer.checkoutLocalBranch('topic');
    await writeFile(join(producer, 'only-personal.txt'), 'remote-only content');
    await writer.add('only-personal.txt').commit('personal-only object');
    await writer.push(join(root, 'personal.git'), 'topic');
    const selected = await resolveGitRef(repoPath, 'personal/topic', {
      remote: { name: 'origin', url: join(root, 'origin.git') },
    });
    await expect(git.revparse(['--verify', `${selected.sha}^{commit}`])).rejects.toThrow();
    const target = join(root, 'worktree');
    await createBranch(
      repoPath,
      target,
      'feature',
      true,
      true,
      selected.name,
      {},
      'branch',
      selected.remoteUrl,
      join(root, 'origin.git'),
      selected.sha,
      {}
    );
    expect((await simpleGit(target).revparse(['HEAD'])).trim()).toBe(selected.sha);
    expect((await git.raw(['for-each-ref', 'refs/agor/base'])).trim()).toBe('');
  });

  it.each([
    ['origin', 'topic'],
    ['origin', 'deadbee'],
    ['personal', 'topic'],
    ['company/fork', 'topic'],
  ])('attaches uncached %s/%s with its selected upstream and pinned SHA', async (remote, name) => {
    const git = simpleGit(repoPath);
    const remoteUrl = join(root, `${remote.replace('/', '-')}.git`);
    // Push creates a tracking ref locally; remove it to exercise network-only resolution.
    await git.push(remote, `different:refs/heads/${name}`);
    await git.raw(['update-ref', '-d', `refs/remotes/${remote}/${name}`]);
    // A same-named destination branch must not hijack the selected upstream.
    if (remote !== 'origin') await git.push('origin', `main:refs/heads/${name}`);
    const selected = await resolveGitRef(
      repoPath,
      remote === 'origin' ? name : `${remote}/${name}`,
      {
        remote: { name: 'origin', url: join(root, 'origin.git') },
      }
    );
    expect(selected.kind).toBe('remote_branch');
    expect(selected.remoteUrl).toBe(remoteUrl);
    await expect(git.revparse(['--verify', `refs/remotes/${remote}/${name}`])).rejects.toThrow();
    const target = join(root, 'existing');
    await createBranch(
      repoPath,
      target,
      selected.name,
      false,
      true,
      selected.name,
      {},
      'branch',
      selected.remoteUrl,
      join(root, 'origin.git'),
      selected.sha,
      {},
      selected
    );
    const checkout = simpleGit(target);
    expect((await checkout.revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(name);
    expect((await checkout.revparse(['HEAD'])).trim()).toBe(secondSha);
    expect((await checkout.revparse(['--abbrev-ref', '@{upstream}'])).trim()).toBe(
      `${remote}/${name}`
    );
    expect((await checkout.getConfig(`branch.${name}.remote`)).value).toBe(remote);
    expect((await checkout.getConfig(`branch.${name}.merge`)).value).toBe(`refs/heads/${name}`);
    expect((await git.raw(['for-each-ref', 'refs/agor/base'])).trim()).toBe('');
  });

  it('keeps a resolved commit detached rather than creating a local branch', async () => {
    const selected = await resolveGitRef(repoPath, secondSha);
    const target = join(root, 'commit');
    await createBranch(
      repoPath,
      target,
      selected.ref,
      false,
      false,
      undefined,
      {},
      'branch',
      undefined,
      undefined,
      selected.sha,
      {},
      selected
    );
    expect((await simpleGit(target).revparse(['HEAD'])).trim()).toBe(secondSha);
    expect((await simpleGit(target).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('HEAD');
  });

  it('refuses upstream wiring if the selected remote URL changes', async () => {
    const git = simpleGit(repoPath);
    await git.push('personal', 'different:refs/heads/topic');
    const selected = await resolveGitRef(repoPath, 'personal/topic');
    await git.remote(['set-url', 'personal', join(root, 'origin.git')]);
    await expect(
      createBranch(
        repoPath,
        join(root, 'changed'),
        selected.name,
        false,
        true,
        selected.name,
        {},
        'branch',
        selected.remoteUrl,
        join(root, 'origin.git'),
        selected.sha,
        {},
        selected
      )
    ).rejects.toThrow(/Selected remote 'personal' changed/);
    expect((await git.raw(['for-each-ref', 'refs/agor/base'])).trim()).toBe('');
    expect((await git.getConfig('branch.topic.remote')).value).toBeNull();
    await expect(git.revparse(['--verify', 'refs/heads/topic'])).rejects.toThrow();
  });

  it('fast-forwards a stale cached branch when restoring from the destination', async () => {
    const git = simpleGit(repoPath);
    await git.branch(['topic', firstSha]);
    await git.push('origin', 'different:refs/heads/topic');
    const target = join(root, 'restored');
    await expect(
      restoreBranchFilesystem(
        repoPath,
        target,
        'topic',
        'main',
        {},
        undefined,
        'branch',
        join(root, 'origin.git')
      )
    ).resolves.toEqual({ success: true, strategy: 'checkout' });
    expect((await simpleGit(target).revparse(['HEAD'])).trim()).toBe(secondSha);
    expect((await simpleGit(target).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('topic');
  });

  it('refuses destination restore that would discard local-only commits', async () => {
    const git = simpleGit(repoPath);
    await git.branch(['topic', secondSha]);
    await git.push('origin', 'main:refs/heads/topic');
    await expect(
      restoreBranchFilesystem(
        repoPath,
        join(root, 'refused'),
        'topic',
        'main',
        {},
        undefined,
        'branch',
        join(root, 'origin.git')
      )
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('refusing to discard local work'),
    });
    expect((await git.revparse(['topic'])).trim()).toBe(secondSha);
  });
});
