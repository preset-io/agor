import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeGitRemoteUrl,
  buildAuthenticatedGitTransportEnvironment,
  buildGitProcessEnvironment,
  createBranch,
  createGit,
  filterUserGitEnvironment,
  scrubGitConfigRemoteCredentials,
  simpleGit,
} from './index';

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe('buildGitProcessEnvironment', () => {
  it('keeps required Git runtime metadata but drops deployment secrets and ambient capabilities', () => {
    const trustedGitPolicy = "'transfer.credentialsInUrl=die' 'protocol.ext.allow=never'";
    expect(
      buildGitProcessEnvironment({
        PATH: '/usr/bin',
        HOME: '/home/daemon',
        HTTPS_PROXY: 'https://proxy-user:proxy-password@proxy.example',
        XDG_CONFIG_HOME: '/home/daemon/.config',
        GIT_AUTHOR_NAME: 'Daemon Identity',
        LC_ALL: 'C.UTF-8',
        AGOR_MASTER_SECRET: 'master-canary',
        DATABASE_URL: 'database-canary',
        JWT_SECRET: 'jwt-canary',
        OPENAI_API_KEY: 'provider-canary',
        SSH_AUTH_SOCK: '/tmp/daemon-agent.sock',
        GIT_PROXY_COMMAND: 'attacker-command',
        GIT_CONFIG_PARAMETERS: trustedGitPolicy,
      })
    ).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/daemon',
      LC_ALL: 'C.UTF-8',
      GIT_CONFIG_PARAMETERS: trustedGitPolicy,
    });
  });
});

describe('filterUserGitEnvironment', () => {
  it('retains only the explicit credential, network, TLS, and identity DTO', () => {
    const result = filterUserGitEnvironment({
      GITHUB_TOKEN: 'token-canary',
      HTTPS_PROXY: 'https://proxy-user:proxy-password@proxy.example',
      SSL_CERT_FILE: '/certs/corporate.pem',
      GIT_AUTHOR_EMAIL: 'user@example.com',
      CUSTOM_FORGE_TOKEN: 'custom-canary',
    });

    expect(result.rejected).toEqual(['GIT_AUTHOR_EMAIL', 'CUSTOM_FORGE_TOKEN']);
    expect(result.env).toEqual({
      GITHUB_TOKEN: 'token-canary',
      HTTPS_PROXY: 'https://proxy-user:proxy-password@proxy.example',
      SSL_CERT_FILE: '/certs/corporate.pem',
    });
  });

  it('rejects config, executable, helper, pager, trace, and repository-path controls', () => {
    const dangerous = {
      LD_PRELOAD: '/tmp/attacker.so',
      NODE_OPTIONS: '--require=/tmp/attacker.js',
      BASH_ENV: '/tmp/attacker.sh',
      PATH: '/tmp/attacker-bin',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.sshCommand',
      GIT_CONFIG_VALUE_0: 'attacker-command',
      GIT_CONFIG_PARAMETERS: "'credential.helper=!attacker-command'",
      GIT_SSH_COMMAND: 'attacker-command',
      GIT_ASKPASS: '/tmp/attacker-command',
      SSH_ASKPASS: '/tmp/attacker-command',
      GIT_EDITOR: 'attacker-command',
      GIT_PAGER: 'attacker-command',
      PAGER: 'attacker-command',
      GIT_EXTERNAL_DIFF: 'attacker-command',
      GIT_PROXY_COMMAND: 'attacker-command',
      GIT_TEMPLATE_DIR: '/tmp/attacker-template',
      GIT_EXEC_PATH: '/tmp/attacker-bin',
      GIT_DIR: '/unrelated/repository',
      GIT_WORK_TREE: '/unrelated/worktree',
      GIT_OBJECT_DIRECTORY: '/unrelated/objects',
      GIT_TRACE2_EVENT: '/tmp/exfiltration-log',
      'bad-key': 'malformed',
      NUL_VALUE: 'bad\0value',
    };

    const result = filterUserGitEnvironment(dangerous);

    expect(result.env).toEqual({});
    expect(new Set(result.rejected)).toEqual(new Set(Object.keys(dangerous)));
  });
});

describe('buildAuthenticatedGitTransportEnvironment', () => {
  it('consumes the raw token into hardened config without exposing it as a child variable', () => {
    const token = 'ghp_123456789012345678901234567890';
    const env = buildAuthenticatedGitTransportEnvironment(
      'https://github.example/org/repo.git',
      {
        GITHUB_TOKEN: token,
        STRIPE_API_KEY: 'unrelated-canary',
        HTTPS_PROXY: 'https://user:password@proxy.example',
      },
      {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'https://daemon:secret@proxy.example',
        GIT_CONFIG_PARAMETERS: "'transfer.credentialsInUrl=die' 'core.protectNTFS=true'",
      }
    );

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HTTPS_PROXY).toBe('https://user:password@proxy.example');
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.STRIPE_API_KEY).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();

    const entries = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => [
      env[`GIT_CONFIG_KEY_${index}`],
      env[`GIT_CONFIG_VALUE_${index}`],
    ]);
    expect(entries).toContainEqual(['core.hooksPath', '/dev/null']);
    expect(entries).toContainEqual(['core.fsmonitor', 'false']);
    expect(entries).toContainEqual(['credential.helper', '']);
    expect(entries).toContainEqual(['protocol.ext.allow', 'never']);
    expect(entries).toContainEqual(['transfer.credentialsInUrl', 'die']);
    expect(entries).toContainEqual(['core.protectNTFS', 'true']);
    expect(entries).toContainEqual([
      'http.https://github.example/.extraheader',
      `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    ]);
  });

  it('keeps operation-specific hardening stronger than an operator extra for the same key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agor-git-policy-precedence-'));
    cleanup.push(root);
    const env = buildAuthenticatedGitTransportEnvironment(
      'https://github.example/org/repo.git',
      {},
      {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_PARAMETERS: "'core.hooksPath=/tmp/operator-hooks'",
      }
    );
    const git = simpleGit({
      baseDir: root,
      unsafe: {
        allowUnsafeConfigPaths: true,
        allowUnsafeConfigEnvCount: true,
        allowUnsafeHooksPath: true,
        allowUnsafeFsMonitor: true,
        allowUnsafeProtocolOverride: true,
        allowUnsafeCredentialHelper: true,
      },
    });
    git.env(env);
    await git.init();
    await expect(git.raw(['config', '--get', 'core.hooksPath'])).resolves.toBe('/dev/null\n');
  });

  it('preserves a nondefault HTTPS port in the authorization subsection', () => {
    const env = buildAuthenticatedGitTransportEnvironment(
      'https://forge.example:8443/org/repo.git',
      { GITHUB_TOKEN: 'ghp_123456789012345678901234567890' },
      { PATH: '/usr/bin' }
    );
    const keys = Array.from(
      { length: Number(env.GIT_CONFIG_COUNT) },
      (_, index) => env[`GIT_CONFIG_KEY_${index}`]
    );
    expect(keys).toContain('http.https://forge.example:8443/.extraheader');
    expect(keys).not.toContain('http.https://forge.example/.extraheader');
  });

  it('refuses to send a managed token over plain HTTP', () => {
    expect(() =>
      buildAuthenticatedGitTransportEnvironment('http://forge.example/org/repo.git', {
        GITHUB_TOKEN: 'ghp_123456789012345678901234567890',
      })
    ).toThrow(/plain HTTP/i);
  });

  it('does not expose transport credentials to repository filters or checkout hooks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agor-git-hook-boundary-'));
    cleanup.push(root);
    const branchPath = join(root, '..', `agor-git-filter-worktree-${Date.now()}`);
    cleanup.push(branchPath);
    const canary = join(root, 'hook-ran');
    const capturedEnvironment = join(root, 'filter-environment');
    const { git: seedGit } = createGit(root);
    await seedGit.init();
    await seedGit.addConfig('user.name', 'Agor Test', false, 'local');
    await seedGit.addConfig('user.email', 'agor-test@example.invalid', false, 'local');
    await simpleGit({ baseDir: root, unsafe: { allowUnsafeFilter: true } }).addConfig(
      'filter.capture.smudge',
      `sh -c 'env > "${capturedEnvironment}"; cat'`,
      false,
      'local'
    );
    await writeFile(join(root, '.gitattributes'), 'README.md filter=capture\n');
    await writeFile(join(root, 'README.md'), 'seed\n');
    await seedGit.add(['.gitattributes', 'README.md']);
    await seedGit.commit('seed');
    await seedGit.branch(['-M', 'main']);

    const hook = join(root, '.git', 'hooks', 'post-checkout');
    await writeFile(hook, `#!/bin/sh\ntouch '${canary}'\n`);
    await chmod(hook, 0o700);

    await createBranch(root, branchPath, 'hook-boundary', true, false, 'main', {
      GITHUB_TOKEN: 'ghp_123456789012345678901234567890',
      HTTPS_PROXY: 'https://proxy-user:proxy-password@proxy.example',
    });

    expect(existsSync(canary)).toBe(false);
    const captured = await readFile(capturedEnvironment, 'utf8');
    expect(captured).not.toContain('proxy-user');
    expect(captured).not.toContain('proxy-password');
    expect(captured).not.toContain('Authorization:');
    expect(captured).not.toContain('123456789012345678901234567890');
  });

  it('never forwards HTTP credentials to a non-HTTP transport child', () => {
    const env = buildAuthenticatedGitTransportEnvironment('/tmp/local-repository', {
      GITHUB_TOKEN: 'ghp_123456789012345678901234567890',
      HTTPS_PROXY: 'https://proxy-user:proxy-password@proxy.example',
    });

    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(Object.values(env).join('\n')).not.toContain('Authorization:');
    expect(Object.values(env).join('\n')).not.toContain('proxy-password');
  });

  it('classifies file URLs as file transport rather than SCP-like SSH syntax', () => {
    const env = buildAuthenticatedGitTransportEnvironment('file:///tmp/local-repository', {});
    const entries = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => [
      env[`GIT_CONFIG_KEY_${index}`],
      env[`GIT_CONFIG_VALUE_${index}`],
    ]);

    expect(entries).toContainEqual(['protocol.file.allow', 'always']);
    expect(entries).not.toContainEqual(['protocol.ssh.allow', 'always']);
  });

  it('uses the canonical remote instead of mutable origin/upload-pack configuration', async () => {
    const container = mkdtempSync(join(tmpdir(), 'agor-git-trusted-remote-'));
    cleanup.push(container);
    const canonical = join(container, 'canonical.git');
    const attacker = join(container, 'attacker.git');
    const seed = join(container, 'seed');
    const base = join(container, 'base');
    const branchPath = join(container, 'worktree');
    const uploadPackCanary = join(container, 'mutable-upload-pack-ran');

    for (const bare of [canonical, attacker]) {
      await mkdir(bare);
      await createGit(bare).git.init(true);
    }
    await mkdir(seed);
    const seedGit = createGit(seed).git;
    await seedGit.init();
    await seedGit.addConfig('user.name', 'Agor Test', false, 'local');
    await seedGit.addConfig('user.email', 'agor-test@example.invalid', false, 'local');
    await writeFile(join(seed, 'SOURCE'), 'canonical\n');
    await seedGit.add('SOURCE');
    await seedGit.commit('canonical');
    await seedGit.branch(['-M', 'main']);
    await seedGit.push([canonical, 'main:main']);
    await createGit(canonical).git.raw(['symbolic-ref', 'HEAD', 'refs/heads/main']);

    await createGit(container).git.clone(canonical, base);
    const baseGit = createGit(base).git;
    await baseGit.remote(['set-url', 'origin', attacker]);
    await simpleGit({ baseDir: base, unsafe: { allowUnsafePack: true } }).addConfig(
      'remote.origin.uploadpack',
      `sh -c 'touch "${uploadPackCanary}"; exit 1'`,
      false,
      'local'
    );

    await createBranch(
      base,
      branchPath,
      'trusted-remote',
      true,
      true,
      'main',
      { HTTPS_PROXY: 'https://proxy-user:proxy-password@proxy.example' },
      'branch',
      undefined,
      canonical
    );

    expect(await readFile(join(branchPath, 'SOURCE'), 'utf8')).toBe('canonical\n');
    expect(existsSync(uploadPackCanary)).toBe(false);
  });
});

describe('assertSafeGitRemoteUrl', () => {
  it('accepts explicit supported transports and rejects option/helper forms', () => {
    expect(assertSafeGitRemoteUrl('https://forge.example/org/repo.git')).toBe(
      'https://forge.example/org/repo.git'
    );
    expect(assertSafeGitRemoteUrl('git@forge.example:org/repo.git')).toBe(
      'git@forge.example:org/repo.git'
    );
    expect(assertSafeGitRemoteUrl('ssh://git@forge.example/org/repo.git')).toBe(
      'ssh://git@forge.example/org/repo.git'
    );
    expect(assertSafeGitRemoteUrl('git://forge.example/org/repo.git')).toBe(
      'git://forge.example/org/repo.git'
    );
    expect(assertSafeGitRemoteUrl('/tmp/local-repository')).toBe('/tmp/local-repository');

    for (const candidate of [
      '--upload-pack=/tmp/capture',
      'ext::sh -c capture',
      'helper://forge.example/repo',
      'ssh://git:password@forge.example/org/repo.git',
      'ssh://bad%2Fuser@forge.example/org/repo.git',
      './relative/repository',
      'https://forge.example/repo.git\n--upload-pack=capture',
    ]) {
      expect(() => assertSafeGitRemoteUrl(candidate)).toThrow(/Git remote/i);
    }
  });
});

describe('scrubGitConfigRemoteCredentials', () => {
  it('does not follow a checkout-controlled .git symlink when repairing config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agor-git-scrub-symlink-'));
    cleanup.push(root);
    const repo = join(root, 'repo');
    const outside = join(root, 'outside-git');
    await mkdir(repo);
    await mkdir(outside);
    const outsideConfig = join(outside, 'config');
    const canary = '[remote "origin"]\n\turl = https://user:secret@forge.example/repo.git\n';
    await writeFile(outsideConfig, canary);
    await symlink(outside, join(repo, '.git'));

    const result = await scrubGitConfigRemoteCredentials(repo);

    expect(result).toMatchObject({ changed: false, configPaths: [], findings: [] });
    expect(await readFile(outsideConfig, 'utf8')).toBe(canary);
  });

  it('does not use a mutable linked-worktree pointer as write authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agor-git-scrub-pointer-'));
    cleanup.push(root);
    const repo = join(root, 'worktree');
    const outside = join(root, 'outside-git');
    await mkdir(repo);
    await mkdir(outside);
    const outsideConfig = join(outside, 'config');
    const canary = '[remote "origin"]\n\turl = https://user:secret@forge.example/repo.git\n';
    await writeFile(outsideConfig, canary);
    await writeFile(join(repo, '.git'), `gitdir: ${outside}\n`);

    const result = await scrubGitConfigRemoteCredentials(repo);

    expect(result).toMatchObject({ changed: false, configPaths: [], findings: [] });
    expect(await readFile(outsideConfig, 'utf8')).toBe(canary);
  });
});
