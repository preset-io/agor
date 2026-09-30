import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCredentialAuthorityLayout } from '@agor/core/codex/credential-file';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveSandboxProtectedDataRoots, resolveSandboxStoragePaths } from './sandbox-context';

vi.mock('@agor/core/unix', () => ({
  probeBwrapSecurityBaseline: () => true,
  probeBwrapPidNamespace: () => false,
}));

import { buildSandboxWrap } from './sandbox-wrap';

const bwrapRuntimeAvailable =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--unshare-user', '--ro-bind', '/', '/', '--', '/bin/true'], {
    stdio: 'ignore',
    timeout: 10_000,
  }).status === 0;

// Always assert the emitted policy; also exercise actual file reads where the
// host supports bubblewrap. All state is synthetic and below a disposable root.
describe.runIf(process.platform === 'linux')('relocated Agor state containment', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'agor-state-sandbox-')));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it.each([false, true])('hides state and sibling tenants (symlinked home: %s)', async (linked) => {
    const state = join(root, 'state');
    const agorHome = linked ? join(root, 'state-link') : state;
    const home = join(root, 'passwd-homes', 'daemon');
    const data = join(root, 'git-data');
    const tools = join(state, 'agentic-tools');
    await Promise.all([mkdir(home, { recursive: true }), mkdir(tools, { recursive: true })]);
    if (linked) await symlink(state, agorHome);
    vi.stubEnv('AGOR_HOME', agorHome);
    const secrets = ['admin-credentials', 'cli-token', 'agor.db-wal', 'agor.db-shm'];
    await Promise.all(secrets.map((file) => writeFile(join(state, file), 'synthetic-secret')));
    await writeFile(join(tools, 'tool-fixture'), 'tool-visible');
    const config = {
      paths: { data_home: data },
      multi_tenancy: { filesystem_isolation_enabled: true },
    };
    const branches: Record<string, string> = {};
    for (const tenant of ['tenant-a', 'tenant-b']) {
      const storage = resolveSandboxStoragePaths(config, tenant);
      branches[tenant] = join(storage.worktreesRoot, 'repo', 'branch');
      await mkdir(branches[tenant], { recursive: true });
      await writeFile(join(branches[tenant], 'private-file'), tenant);
    }
    for (const tenant of ['tenant-a', 'tenant-b']) {
      const storage = resolveSandboxStoragePaths(config, tenant);
      const ownerStore = join(storage.ownerHomesRoot, 'user');
      await ensureCredentialAuthorityLayout(join(ownerStore, '.claude', '.credentials.json'));
      const forbidden = [
        ...new Set([state, agorHome].flatMap((base) => secrets.map((file) => join(base, file)))),
        join(branches[tenant === 'tenant-a' ? 'tenant-b' : 'tenant-a'], 'private-file'),
      ];
      const wrapped = buildSandboxWrap({
        sandbox: { enabled: true, home_mode: 'per_user', include: { tmp: false } },
        branchPath: branches[tenant],
        ownerHomeStore: ownerStore,
        cmd: '/bin/sh',
        args: [
          '-c',
          `set -eu
for file do
  if cat "$file" >/dev/null 2>&1; then echo "unexpected read: $file" >&2; exit 1; fi
done
test "$(cat private-file)" = "$EXPECTED_TENANT"
printf writable > branch-write
test "$(cat "$TOOL_FIXTURE")" = tool-visible
if (printf changed > "$TOOL_FIXTURE") 2>/dev/null; then exit 1; fi
printf writable > "$HOME/home-write"
`,
          'sh',
          ...forbidden,
        ],
        runtimePaths: {
          homeDir: home,
          dataHome: data,
          protectedDataRoots: resolveSandboxProtectedDataRoots(config),
          worktreesRoot: storage.worktreesRoot,
          agenticToolsPath: join(agorHome, 'agentic-tools'),
          agorConfigPath: join(agorHome, 'config.yaml'),
        },
      });
      expect(wrapped).not.toBeNull();
      const args = wrapped!.args;
      expect(args.some((arg, i) => arg === '--tmpfs' && args[i + 1] === state)).toBe(true);
      // Nested tenant masks are subsumed by the whole state-root mask.
      expect(
        args.some((arg, i) => arg === '--tmpfs' && args[i + 1] === join(state, 'tenants'))
      ).toBe(false);
      expect(args.some((arg, i) => arg === '--bind' && args[i + 1] === branches[tenant])).toBe(
        true
      );
      expect(
        args.some(
          (arg, i) => arg === '--ro-bind-try' && args[i + 1] === join(agorHome, 'agentic-tools')
        )
      ).toBe(true);
      if (bwrapRuntimeAvailable) {
        const result = spawnSync(wrapped!.cmd, args, {
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            EXPECTED_TENANT: tenant,
            TOOL_FIXTURE: join(tools, 'tool-fixture'),
          },
        });
        expect(result.status, result.stderr).toBe(0);
      }
    }
  });
});
