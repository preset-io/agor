import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core/unix', () => ({
  bwrapOnPath: () => true,
  probeBwrapUserns: () => true,
  probeBwrapPidNamespace: () => false,
}));

import { buildSandboxWrap, type SandboxRuntimePaths } from './sandbox-wrap.js';

const bwrapRuntimeAvailable =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--unshare-user', '--ro-bind', '/', '/', '--', '/bin/true'], {
    stdio: 'ignore',
  }).status === 0;

describe.runIf(bwrapRuntimeAvailable)('Claude credential sandbox containment', () => {
  let root: string;
  let home: string;
  let ownerStore: string;
  let branch: string;
  let runtimePaths: SandboxRuntimePaths;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agor-claude-sandbox-'));
    home = join(root, 'passwd-homes', 'agor');
    ownerStore = join(root, 'external-owner-home');
    const data = join(root, 'data');
    branch = join(data, 'worktrees', 'repo', 'branch');
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(join(ownerStore, '.claude', 'projects'), { recursive: true }),
      mkdir(join(ownerStore, '.codex'), { recursive: true }),
      mkdir(branch, { recursive: true }),
      mkdir(join(data, 'agentic-tools'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(ownerStore, '.claude', '.credentials.json'), 'refresh-secret'),
      writeFile(join(ownerStore, '.claude', 'settings.json'), 'settings-visible'),
      writeFile(join(ownerStore, '.claude', 'projects', 'resume.jsonl'), 'resume-visible'),
      writeFile(join(ownerStore, '.codex', 'auth.json'), 'codex-visible'),
    ]);
    runtimePaths = {
      homeDir: home,
      dataHome: data,
      protectedDataRoots: [data],
      worktreesRoot: join(data, 'worktrees'),
      agenticToolsPath: join(data, 'agentic-tools'),
      agorConfigPath: join(data, 'config.yaml'),
    };
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('retains the mask after owner overlay and hides the physical store alias', async () => {
    const wrapped = buildSandboxWrap({
      sandbox: {
        enabled: true,
        home_mode: 'per_user',
        fail_if_unavailable: true,
        include: { tmp: false },
      },
      branchPath: branch,
      cmd: '/bin/sh',
      args: [
        '-c',
        [
          'test -z "$(cat "$HOME/.claude/.credentials.json" 2>/dev/null || true)"',
          'test -z "$(cat "$1/.claude/.credentials.json" 2>/dev/null || true)"',
          '! sh -c \'printf x > "$HOME/.claude/.credentials.json"\' 2>/dev/null',
          'test "$(cat "$HOME/.claude/settings.json")" = settings-visible',
          'test "$(cat "$HOME/.claude/projects/resume.jsonl")" = resume-visible',
          'test "$(cat "$HOME/.codex/auth.json")" = codex-visible',
        ].join(' && '),
        'sh',
        ownerStore,
      ],
      ownerHomeStore: ownerStore,
      runtimePaths,
    });
    expect(wrapped).not.toBeNull();
    const args = wrapped?.args ?? [];
    const overlay = args.findIndex(
      (arg, index) => arg === '--bind' && args[index + 1] === ownerStore && args[index + 2] === home
    );
    const credentialMask = args.findIndex(
      (arg, index) =>
        arg === '--ro-bind-try' &&
        args[index + 1] === '/dev/null' &&
        args[index + 2] === join(home, '.claude', '.credentials.json')
    );
    const physicalCredentialMask = args.findIndex(
      (arg, index) =>
        arg === '--ro-bind-try' &&
        args[index + 1] === '/dev/null' &&
        args[index + 2] === join(ownerStore, '.claude', '.credentials.json')
    );
    expect(overlay).toBeGreaterThanOrEqual(0);
    expect(credentialMask).toBeGreaterThan(overlay);
    expect(physicalCredentialMask).toBeGreaterThan(overlay);

    const result = spawnSync(wrapped?.cmd ?? 'false', args, {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(join(ownerStore, '.claude', '.credentials.json'), 'utf8')).toBe(
      'refresh-secret'
    );
  });

  it('materializes a secret-free mask for an absent file without breaking env auth', async () => {
    const target = join(ownerStore, '.claude', '.credentials.json');
    await unlink(target);
    const wrapped = buildSandboxWrap({
      sandbox: {
        enabled: true,
        home_mode: 'per_user',
        fail_if_unavailable: true,
        include: { tmp: false },
      },
      branchPath: branch,
      cmd: '/bin/sh',
      args: [
        '-c',
        'test "$CLAUDE_CODE_OAUTH_TOKEN" = sk-ant-oat01-pasted && test -z "$(cat "$HOME/.claude/.credentials.json" 2>/dev/null || true)"',
      ],
      ownerHomeStore: ownerStore,
      runtimePaths,
    });
    const result = spawnSync(wrapped?.cmd ?? 'false', wrapped?.args ?? [], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-pasted' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('');
  });
});
