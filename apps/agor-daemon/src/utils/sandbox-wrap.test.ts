import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CREDENTIAL_AUTHORITY_GENERATION_FILENAME,
  CREDENTIAL_AUTHORITY_LOCK_FILENAME,
  CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES,
  ensureCredentialAuthorityLayout,
  mutateCredentialFile,
} from '@agor/core/codex/credential-file';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core/unix', () => ({
  bwrapOnPath: () => true,
  probeBwrapSecurityBaseline: () => true,
  probeBwrapUserns: () => true,
  probeBwrapPidNamespace: () => false,
}));

import {
  buildSandboxWrap,
  type SandboxRuntimePaths,
  sandboxManagedCredentialIsolationAvailable,
} from './sandbox-wrap.js';

const bwrapRuntimeAvailable =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--unshare-user', '--ro-bind', '/', '/', '--', '/bin/true'], {
    stdio: 'ignore',
  }).status === 0;

const AUTHORITY_FILENAMES = [
  '.credentials.json',
  ...CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES,
] as const;

it('does not authorize managed runtime credentials when the live PID probe fails', () => {
  expect(sandboxManagedCredentialIsolationAvailable()).toBe(false);
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

describe.runIf(bwrapRuntimeAvailable)('Claude credential sandbox containment', () => {
  let root: string;
  let home: string;
  let canonicalHome: string;
  let ownerStore: string;
  let branch: string;
  let runtimePaths: SandboxRuntimePaths;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agor-claude-sandbox-'));
    canonicalHome = join(root, 'passwd-homes', 'canonical-agor');
    home = join(root, 'passwd-homes', 'agor');
    ownerStore = join(root, 'external-owner-home');
    const data = join(root, 'data');
    branch = join(data, 'worktrees', 'repo', 'branch');
    await Promise.all([
      mkdir(canonicalHome, { recursive: true }),
      mkdir(join(ownerStore, '.claude', 'projects'), { recursive: true }),
      mkdir(join(ownerStore, '.claude', 'plugins'), { recursive: true }),
      mkdir(join(ownerStore, '.codex'), { recursive: true }),
      mkdir(branch, { recursive: true }),
      mkdir(join(data, 'agentic-tools'), { recursive: true }),
    ]);
    await symlink(canonicalHome, home);
    await ensureCredentialAuthorityLayout(join(ownerStore, '.claude', '.credentials.json'));
    await Promise.all([
      writeFile(join(ownerStore, '.claude', '.credentials.json'), 'refresh-secret'),
      writeFile(join(ownerStore, '.claude', CREDENTIAL_AUTHORITY_GENERATION_FILENAME), '41\n'),
      writeFile(join(ownerStore, '.claude', CREDENTIAL_AUTHORITY_LOCK_FILENAME), 'lock-authority'),
      writeFile(join(ownerStore, '.claude', 'CLAUDE.md'), 'instructions-visible'),
      writeFile(join(ownerStore, '.claude', 'settings.json'), 'settings-visible'),
      writeFile(join(ownerStore, '.claude', 'projects', 'resume.jsonl'), 'resume-visible'),
      writeFile(join(ownerStore, '.claude', 'plugins', 'plugin.json'), 'plugin-visible'),
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

  it('blocks parent/sidecar attacks through every live alias while ordinary Claude state stays writable', async () => {
    const authorityPaths = AUTHORITY_FILENAMES.map((filename) =>
      join(ownerStore, '.claude', filename)
    );
    const before = await Promise.all(
      authorityPaths.map(async (path) => {
        const metadata = await stat(path, { bigint: true });
        return {
          bytes: await readFile(path),
          inode: metadata.ino,
          mtimeNs: metadata.mtimeNs,
        };
      })
    );

    const aliases = [
      ...new Set([
        join(home, '.claude'),
        join(canonicalHome, '.claude'),
        join(ownerStore, '.claude'),
      ]),
    ];
    const script = String.raw`
set -eu
must_fail() {
  if "$@" >/dev/null 2>&1; then
    echo "unexpected success: $*" >&2
    exit 70
  fi
}
for claude_dir in "$@"; do
  replacement="$HOME/replacement-$(basename "$(dirname "$claude_dir")")"
  rm -rf "$replacement"
  mkdir -p "$replacement"

  # The writable parent is a mountpoint: rename, rmdir, and rename-T cannot
  # detach it and expose a task-created replacement directory.
  must_fail mv "$claude_dir" "$claude_dir.renamed"
  must_fail rmdir "$claude_dir"
  must_fail mv -T "$replacement" "$claude_dir"

  # Leaf authority is masked, including both sidecars. nodev turns the rebound
  # /dev/null device into an unreadable path on this host; unreadable is the
  # intended stronger form of an empty mask.
  for leaf in .credentials.json .agor-auth-generation .agor-auth-mutation.lock; do
    must_fail cat "$claude_dir/$leaf"
    must_fail sh -c 'printf attacker > "$1"' sh "$claude_dir/$leaf"
    must_fail unlink "$claude_dir/$leaf"
    must_fail ln -sfn "$replacement/attacker" "$claude_dir/$leaf"
  done

  # An already-open directory descriptor does not route around the leaf mounts.
  eval "exec 9<\"$claude_dir\""
  must_fail sh -c 'printf attacker > /proc/self/fd/9/.credentials.json'
  must_fail sh -c 'printf 0 > /proc/self/fd/9/.agor-auth-generation'
  eval 'exec 9<&-'

  # A nested user/mount namespace cannot remove or move the parent-owned locked
  # mount. A bind-over attempt may create only a child-private shadow; it must
  # never expose or mutate host authority.
  if command -v unshare >/dev/null 2>&1; then
    must_fail unshare --user --map-root-user --mount sh -c 'umount "$1"' sh "$claude_dir"
    must_fail unshare --user --map-root-user --mount sh -c \
      'mkdir -p "$2/moved"; mount --move "$1" "$2/moved"' sh "$claude_dir" "$replacement"
    unshare --user --map-root-user --mount sh -c \
      'mount --bind "$2" "$1" 2>/dev/null || true; printf child-only > "$1/.credentials.json" 2>/dev/null || true' \
      sh "$claude_dir" "$replacement" || true
  fi
done

# Positive controls: the parent and ordinary Claude state remain writable and
# path-compatible for settings, fork/resume projects, plugins, and new files.
test "$(cat "$HOME/.claude/CLAUDE.md")" = instructions-visible
test "$(cat "$HOME/.claude/settings.json")" = settings-visible
test "$(cat "$HOME/.claude/projects/resume.jsonl")" = resume-visible
test "$(cat "$HOME/.claude/plugins/plugin.json")" = plugin-visible
printf updated-settings > "$HOME/.claude/settings.json"
printf new-project > "$HOME/.claude/projects/new.jsonl"
printf new-plugin > "$HOME/.claude/plugins/new.json"
printf new-state > "$HOME/.claude/new-state.json"
test "$(cat "$HOME/.codex/auth.json")" = codex-visible
`;

    const wrapped = buildSandboxWrap({
      sandbox: {
        enabled: true,
        home_mode: 'per_user',
        preserve_canonical_home_alias: true,
        fail_if_unavailable: true,
        include: { tmp: false },
      },
      branchPath: branch,
      cmd: '/bin/bash',
      args: ['-c', script, 'bash', ...aliases],
      ownerHomeStore: ownerStore,
      runtimePaths,
    });
    expect(wrapped).not.toBeNull();
    const args = wrapped?.args ?? [];
    for (const alias of aliases) {
      expect(
        args.some(
          (arg, index) =>
            arg === '--bind' &&
            args[index + 1] === join(ownerStore, '.claude') &&
            args[index + 2] === alias
        )
      ).toBe(true);
      for (const filename of AUTHORITY_FILENAMES) {
        expect(
          args.some(
            (arg, index) =>
              arg === '--ro-bind' &&
              args[index + 1] === '/dev/null' &&
              args[index + 2] === join(alias, filename)
          )
        ).toBe(true);
      }
    }

    const result = spawnSync(wrapped?.cmd ?? 'false', args, {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(result.status, `${JSON.stringify(args)}\n${result.stdout}\n${result.stderr}`).toBe(0);

    const after = await Promise.all(
      authorityPaths.map(async (path) => {
        const metadata = await stat(path, { bigint: true });
        return {
          bytes: await readFile(path),
          inode: metadata.ino,
          mtimeNs: metadata.mtimeNs,
        };
      })
    );
    expect(after).toEqual(before);
    await expect(readFile(join(ownerStore, '.claude', 'settings.json'), 'utf8')).resolves.toBe(
      'updated-settings'
    );
    await expect(
      readFile(join(ownerStore, '.claude', 'projects', 'new.jsonl'), 'utf8')
    ).resolves.toBe('new-project');
    await expect(
      readFile(join(ownerStore, '.claude', 'plugins', 'new.json'), 'utf8')
    ).resolves.toBe('new-plugin');
    await expect(readFile(join(ownerStore, '.claude', 'new-state.json'), 'utf8')).resolves.toBe(
      'new-state'
    );
  });

  it('masks a hidden physical owner store re-exposed by extra_allow_write', async () => {
    const hiddenOwnerStore = join(runtimePaths.dataHome, 'tenants', 'default', 'homes', 'owner');
    const hiddenClaudeDirectory = join(hiddenOwnerStore, '.claude');
    const credentialPath = join(hiddenClaudeDirectory, '.credentials.json');
    await mkdir(hiddenOwnerStore, { recursive: true });
    await ensureCredentialAuthorityLayout(credentialPath);
    await Promise.all([
      writeFile(credentialPath, 'hidden-refresh-secret'),
      writeFile(join(hiddenClaudeDirectory, CREDENTIAL_AUTHORITY_GENERATION_FILENAME), '73\n'),
      writeFile(
        join(hiddenClaudeDirectory, CREDENTIAL_AUTHORITY_LOCK_FILENAME),
        'hidden-lock-authority'
      ),
    ]);
    const authorityPaths = AUTHORITY_FILENAMES.map((filename) =>
      join(hiddenClaudeDirectory, filename)
    );
    const before = await Promise.all(
      authorityPaths.map(async (path) => {
        const metadata = await stat(path, { bigint: true });
        return { bytes: await readFile(path), inode: metadata.ino, mtimeNs: metadata.mtimeNs };
      })
    );

    const script = `
set -eu
must_fail() {
  if "$@" >/dev/null 2>&1; then
    echo "unexpected success: $*" >&2
    exit 70
  fi
}
claude_dir="$1"
replacement="$HOME/physical-store-replacement"
mkdir -p "$replacement"
must_fail mv "$claude_dir" "$claude_dir.renamed"
must_fail rmdir "$claude_dir"
must_fail mv -T "$replacement" "$claude_dir"
for leaf in .credentials.json .agor-auth-generation .agor-auth-mutation.lock; do
  must_fail cat "$claude_dir/$leaf"
  must_fail sh -c 'printf attacker > "$1"' sh "$claude_dir/$leaf"
  must_fail unlink "$claude_dir/$leaf"
done
printf physical-state > "$claude_dir/ordinary-state.json"
`;
    const wrapped = buildSandboxWrap({
      sandbox: {
        enabled: true,
        home_mode: 'per_user',
        fail_if_unavailable: true,
        include: { tmp: false },
        extra_allow_write: [hiddenOwnerStore],
      },
      branchPath: branch,
      cmd: '/bin/bash',
      args: ['-c', script, 'bash', hiddenClaudeDirectory],
      ownerHomeStore: hiddenOwnerStore,
      runtimePaths,
    });
    expect(wrapped).not.toBeNull();
    const args = wrapped?.args ?? [];
    const extraWriteIndex = args.findIndex(
      (arg, index) =>
        arg === '--bind' &&
        args[index + 1] === hiddenOwnerStore &&
        args[index + 2] === hiddenOwnerStore
    );
    const lockedParentIndex = args.findIndex(
      (arg, index) =>
        arg === '--bind' &&
        args[index + 1] === hiddenClaudeDirectory &&
        args[index + 2] === hiddenClaudeDirectory
    );
    expect(extraWriteIndex).toBeGreaterThanOrEqual(0);
    expect(lockedParentIndex).toBeGreaterThan(extraWriteIndex);
    for (const path of authorityPaths) {
      expect(
        args.some(
          (arg, index) =>
            arg === '--ro-bind' && args[index + 1] === '/dev/null' && args[index + 2] === path
        )
      ).toBe(true);
    }

    const result = spawnSync(wrapped?.cmd ?? 'false', args, {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(result.status, `${JSON.stringify(args)}\n${result.stdout}\n${result.stderr}`).toBe(0);
    const after = await Promise.all(
      authorityPaths.map(async (path) => {
        const metadata = await stat(path, { bigint: true });
        return { bytes: await readFile(path), inode: metadata.ino, mtimeNs: metadata.mtimeNs };
      })
    );
    expect(after).toEqual(before);
    await expect(
      readFile(join(hiddenClaudeDirectory, 'ordinary-state.json'), 'utf8')
    ).resolves.toBe('physical-state');
  });

  it('uses pre-created empty authority leaves without breaking env-token auth on nodev', async () => {
    const target = join(ownerStore, '.claude', '.credentials.json');
    await unlink(target);
    await ensureCredentialAuthorityLayout(target);

    const wrapped = buildSandboxWrap({
      sandbox: {
        enabled: true,
        home_mode: 'per_user',
        preserve_canonical_home_alias: true,
        fail_if_unavailable: true,
        include: { tmp: false },
      },
      branchPath: branch,
      cmd: '/bin/sh',
      args: [
        '-c',
        'test "$CLAUDE_CODE_OAUTH_TOKEN" = sk-ant-oat01-pasted && ! cat "$HOME/.claude/.credentials.json" >/dev/null 2>&1',
      ],
      ownerHomeStore: ownerStore,
      runtimePaths,
    });
    const result = spawnSync(wrapped?.cmd ?? 'false', wrapped?.args ?? [], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-pasted' },
    });
    expect(result.status, `${JSON.stringify(wrapped?.args)}\n${result.stderr}`).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('');
    for (const sidecar of CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES) {
      expect((await stat(join(ownerStore, '.claude', sidecar))).isFile()).toBe(true);
    }
  });

  it('keeps live masks attached across daemon rotation and tombstone writes', async () => {
    const aliases = [
      ...new Set([
        join(home, '.claude'),
        join(canonicalHome, '.claude'),
        join(ownerStore, '.claude'),
      ]),
    ];
    const credentialPath = join(ownerStore, '.claude', '.credentials.json');
    const generationPath = join(ownerStore, '.claude', CREDENTIAL_AUTHORITY_GENERATION_FILENAME);
    const authorityPaths = AUTHORITY_FILENAMES.map((name) => join(ownerStore, '.claude', name));
    const originalInodes = await Promise.all(
      authorityPaths.map(async (path) => (await stat(path)).ino)
    );
    const ready = join(ownerStore, '.claude', 'race-ready');
    const rotated = join(ownerStore, '.claude', 'race-rotated');
    const checked = join(ownerStore, '.claude', 'race-checked');
    const tombstoned = join(ownerStore, '.claude', 'race-tombstoned');

    const script = `
set -eu
must_fail() {
  if "$@" >/dev/null 2>&1; then
    echo "unexpected success: $*" >&2
    exit 70
  fi
}
check_authority() {
  for claude_dir in "$@"; do
    for leaf in .credentials.json .agor-auth-generation .agor-auth-mutation.lock; do
      must_fail cat "$claude_dir/$leaf"
      must_fail sh -c 'printf attacker > "$1"' sh "$claude_dir/$leaf"
    done
  done
}
printf ready > "$HOME/.claude/race-ready"
while test ! -e "$HOME/.claude/race-rotated"; do sleep 0.01; done
check_authority "$@"
printf checked > "$HOME/.claude/race-checked"
while test ! -e "$HOME/.claude/race-tombstoned"; do sleep 0.01; done
check_authority "$@"
`;
    const wrapped = buildSandboxWrap({
      sandbox: {
        enabled: true,
        home_mode: 'per_user',
        preserve_canonical_home_alias: true,
        fail_if_unavailable: true,
        include: { tmp: false },
      },
      branchPath: branch,
      cmd: '/bin/bash',
      args: ['-c', script, 'bash', ...aliases],
      ownerHomeStore: ownerStore,
      runtimePaths,
    });
    const child = spawn(wrapped?.cmd ?? 'false', wrapped?.args ?? [], {
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        child.once('error', rejectExit);
        child.once('close', (code, signal) => resolveExit({ code, signal }));
      }
    );

    await waitForFile(ready);
    await mutateCredentialFile({
      target: credentialPath,
      content: 'rotated-refresh-secret',
      generation: 52,
      preserveAuthorityInodes: true,
    });
    await writeFile(rotated, 'go');
    await waitForFile(checked);
    await mutateCredentialFile({
      target: credentialPath,
      generation: 53,
      preserveAuthorityInodes: true,
    });
    await writeFile(tombstoned, 'go');
    const exit = await childExit;

    expect(exit, stderr).toEqual({ code: 0, signal: null });
    expect(await Promise.all(authorityPaths.map(async (path) => (await stat(path)).ino))).toEqual(
      originalInodes
    );
    expect(await readFile(credentialPath, 'utf8')).toBe('');
    expect(await readFile(generationPath, 'utf8')).toBe('53\n');
    expect(
      await readFile(join(ownerStore, '.claude', CREDENTIAL_AUTHORITY_LOCK_FILENAME), 'utf8')
    ).toBe('lock-authority');
  });

  it('fails closed when the required real Claude parent was not prepared', async () => {
    await rm(join(ownerStore, '.claude'), { recursive: true, force: true });
    const wrapped = buildSandboxWrap({
      sandbox: {
        enabled: true,
        home_mode: 'per_user',
        fail_if_unavailable: true,
        include: { tmp: false },
      },
      branchPath: branch,
      cmd: '/bin/true',
      args: [],
      ownerHomeStore: ownerStore,
      runtimePaths,
    });
    const result = spawnSync(wrapped?.cmd ?? 'false', wrapped?.args ?? [], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(result.status).not.toBe(0);
    await expect(stat(join(ownerStore, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
