import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('@agor/core/unix', () => ({
  attachEnvFileCleanup: vi.fn(),
  buildSpawnArgs: vi.fn(),
  escapeShellArg: (value: string) => `'${value.replace(/'/g, "'\\''")}'`,
  isSecretEnvKey: vi.fn(),
  // Real implementation (mirrors user-manager.ts) — the {unix_user} format
  // guard under test depends on its actual charset semantics.
  isValidUnixUsername: (username: string) => /^[a-z_][a-z0-9_-]{0,31}$/.test(username),
  prepareImpersonationEnv: vi.fn(),
}));

vi.mock('./build-resolved-config-slice.js', () => ({
  withResolvedConfig: (payload: Record<string, unknown>) => ({
    ...payload,
    resolvedConfig: {},
  }),
}));

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: EventEmitter;
    stderr: EventEmitter;
    written: string;
  };
  proc.written = '';
  proc.stdin = new Writable({
    write(chunk, _encoding, callback) {
      proc.written += chunk.toString();
      callback();
    },
  });
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe('configured executor spawning', () => {
  beforeEach(async () => {
    vi.resetModules();
    spawnMock.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const unix = await import('@agor/core/unix');
    vi.mocked(unix.buildSpawnArgs).mockReturnValue({ cmd: 'node', args: ['executor', '--stdin'] });
    vi.mocked(unix.isSecretEnvKey).mockReturnValue(false);
    vi.mocked(unix.attachEnvFileCleanup).mockImplementation(() => {});

    const { configureExecutor } = await import('./spawn-executor');
    configureExecutor(null);
  });

  it('uses execution.executor_command_template configured at startup', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { configureExecutor, spawnExecutor } = await import('./spawn-executor');

    configureExecutor({
      executor_command_template: 'kubectl run executor-{task_id} --user {unix_user} -- {command}',
      executor_unix_user: 'agor-exec',
    });

    spawnExecutor({ command: 'prompt' }, { logPrefix: '[test]' });

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledWith(
      'sh',
      [
        '-c',
        expect.stringMatching(/^kubectl run executor-[0-9a-f]{8} --user agor-exec -- prompt$/),
      ],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );
    expect(JSON.parse(proc.written)).toMatchObject({
      command: 'prompt',
      resolvedConfig: expect.any(Object),
    });
  });

  it('lets explicit spawn options override configured defaults', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { configureExecutor, spawnExecutor } = await import('./spawn-executor');

    configureExecutor({
      executor_command_template: 'configured {unix_user} {command}',
      executor_unix_user: 'configured-user',
    });

    spawnExecutor(
      { command: 'git.clone' },
      {
        executorCommandTemplate: 'explicit {unix_user} {command}',
        asUser: 'explicit-user',
      }
    );

    expect(spawnMock).toHaveBeenCalledWith(
      'sh',
      ['-c', 'explicit explicit-user git.clone'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );
  });

  it('forwards a delegated read identity through a configured command template', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { runExecutorCommand } = await import('./spawn-executor');
    const promise = runExecutorCommand(
      { command: 'branch.files.browse' },
      {
        executorCommandTemplate: 'launch --user {unix_user} -- {command}',
        asUser: 'alice',
      }
    );

    proc.stdout.emit(
      'data',
      Buffer.from('AGOR_EXECUTOR_RESULT {"success":true,"data":{"files":[]}}\n')
    );
    proc.emit('exit', 0);

    await expect(promise).resolves.toEqual({
      success: true,
      data: { files: [] },
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'sh',
      ['-c', 'launch --user alice -- branch.files.browse'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );
  });

  it('calls onExit for templated spawns', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const onExit = vi.fn();
    const { configureExecutor, spawnExecutor } = await import('./spawn-executor');

    configureExecutor({ executor_command_template: 'echo {command}' });
    spawnExecutor({ command: 'git.clone' }, { onExit });

    proc.emit('exit', 17);

    expect(onExit).toHaveBeenCalledWith(17, { mode: 'templated' });
  });

  it('keeps createConfiguredSpawner isolated from module-level defaults', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { configureExecutor, createConfiguredSpawner } = await import('./spawn-executor');

    configureExecutor({
      executor_command_template: 'global {command}',
      executor_unix_user: 'global-user',
    });
    const injectedSpawner = createConfiguredSpawner({
      executor_command_template: 'injected {unix_user} {command}',
      executor_unix_user: 'injected-user',
    });

    injectedSpawner({ command: 'prompt' });

    expect(spawnMock).toHaveBeenCalledWith(
      'sh',
      ['-c', 'injected injected-user prompt'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );
  });

  it('passes LOG_LEVEL to templated executor processes and exposes a template variable', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { spawnExecutor } = await import('./spawn-executor');

    spawnExecutor(
      { command: 'prompt' },
      {
        executorCommandTemplate: 'run --log-level={log_level} -- {command}',
        env: { LOG_LEVEL: 'warn' },
      }
    );

    expect(spawnMock).toHaveBeenCalledWith(
      'sh',
      ['-c', 'run --log-level=warn -- prompt'],
      expect.objectContaining({
        env: expect.objectContaining({ LOG_LEVEL: 'warn' }),
      })
    );
  });

  it('substitutes a shell-safe {tenant_id} from the ambient tenant context', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { runWithTenantContext } = await import('@agor/core/db');
    const { spawnExecutor } = await import('./spawn-executor');

    runWithTenantContext("tenant-'abc", () =>
      spawnExecutor(
        { command: 'git.clone' },
        {
          executorCommandTemplate: 'launch --tenant-id {tenant_id} -- {command}',
        }
      )
    );

    expect(spawnMock).toHaveBeenCalledWith(
      'sh',
      ['-c', "launch --tenant-id 'tenant-'\\''abc' -- git.clone"],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );
  });

  it('refuses a tenant-dependent template without ambient tenant context', async () => {
    const { spawnExecutor } = await import('./spawn-executor');

    expect(() =>
      spawnExecutor(
        { command: 'git.clone' },
        { executorCommandTemplate: 'launch --tenant-id {tenant_id} -- {command}' }
      )
    ).toThrow(
      'executor_command_template requires {tenant_id}, but no active tenant context is available'
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not let caller template overrides replace the ambient tenant', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { runWithTenantContext } = await import('@agor/core/db');
    const { spawnExecutor } = await import('./spawn-executor');

    runWithTenantContext('trusted-tenant', () =>
      spawnExecutor(
        { command: 'git.clone' },
        {
          executorCommandTemplate: 'launch --tenant-id {tenant_id} -- {command}',
          templateVariables: { tenant_id: 'spoofed-tenant' } as never,
        }
      )
    );

    expect(spawnMock).toHaveBeenCalledWith(
      'sh',
      ['-c', "launch --tenant-id 'trusted-tenant' -- git.clone"],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );
  });

  it('uses ambient tenant context for short-lived templated commands', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { runWithTenantContext } = await import('@agor/core/db');
    const { runExecutorCommand } = await import('./spawn-executor');

    const resultPromise = runWithTenantContext('tenant-run', () =>
      runExecutorCommand(
        { command: 'branch.inspect' },
        {
          executorCommandTemplate: 'launch --tenant-id {tenant_id} -- {command}',
        }
      )
    );
    proc.stdout.emit('data', Buffer.from('{"success":true,"data":{"ok":true}}\n'));
    proc.emit('exit', 0);

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      data: { ok: true },
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'sh',
      ['-c', "launch --tenant-id 'tenant-run' -- branch.inspect"],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );
  });

  it('dispatches Unix permission sync through the configured operator and tenant mount', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { runWithTenantContext } = await import('@agor/core/db');
    const { configureExecutor, runOperatorUnixPermissionCommand } = await import(
      './spawn-executor'
    );
    configureExecutor({
      executor_command_template:
        'operator-launch --tenant {tenant_id} --identity {unix_user} -- {command}',
      executor_unix_user: 'agor_operator',
    });
    const promise = runWithTenantContext('tenant-a', () =>
      runOperatorUnixPermissionCommand({
        command: 'unix.sync-branch',
        sessionToken: 'scoped',
        daemonUrl: 'http://daemon',
        params: { branchId: '00000000-0000-4000-8000-000000000001' },
      })
    );
    proc.stdout.emit('data', Buffer.from('{"success":true,"data":{"groupName":"g"}}\n'));
    proc.emit('exit', 0);
    await expect(promise).resolves.toMatchObject({ success: true });
    expect(spawnMock).toHaveBeenCalledWith(
      'sh',
      ['-c', "operator-launch --tenant 'tenant-a' --identity agor_operator -- unix.sync-branch"],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );
  });

  it('rejects paths, cwd, and unrelated commands at the operator capability boundary', async () => {
    const { runOperatorUnixPermissionCommand } = await import('./spawn-executor');
    expect(() =>
      runOperatorUnixPermissionCommand({
        command: 'unix.sync-branch',
        sessionToken: 'scoped',
        daemonUrl: 'http://daemon',
        params: {
          branchId: '00000000-0000-4000-8000-000000000001',
          cwd: '/tenant-a/worktrees/repo/feature',
        },
      } as never)
    ).toThrow(/Invalid unix\.sync-branch operator capability payload/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    ['local', undefined],
    ['configured-template', 'launch {command}'],
  ])('suppresses sensitive stdout and stderr for %s commands', async (_name, template) => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { runExecutorCommand } = await import('./spawn-executor');
    const promise = runExecutorCommand(
      { command: 'codex.auth-file' },
      {
        ...(template ? { executorCommandTemplate: template } : {}),
        sensitiveOutput: true,
      }
    );
    const secret = 'credential-material-must-not-be-logged';
    proc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ success: true, data: { content: secret } }))
    );
    proc.stderr.emit('data', Buffer.from(secret));
    proc.emit('exit', 0);
    await expect(promise).resolves.toMatchObject({ success: true });
    expect(vi.mocked(console.log).mock.calls.flat().join(' ')).not.toContain(secret);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain(secret);
  });

  it('launches a local executor from its operator-owned package directory, not payload cwd', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { spawnExecutor } = await import('./spawn-executor');
    const tenantBranchPath = '/tenant-a/worktrees/repo/feature';

    spawnExecutor({ command: 'prompt', params: { cwd: tenantBranchPath } });

    expect(spawnMock).toHaveBeenCalledOnce();
    const spawnOptions = spawnMock.mock.calls[0]?.[2] as { cwd?: string };
    expect(spawnOptions.cwd).toBeTruthy();
    expect(spawnOptions.cwd).not.toBe(tenantBranchPath);
    expect(spawnOptions.cwd).toMatch(/\/packages\/executor$/);
    expect(JSON.parse(proc.written)).toMatchObject({ params: { cwd: tenantBranchPath } });
  });

  it('preserves the exit-0/no-result protocol failure diagnostic', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { runExecutorCommand } = await import('./spawn-executor');
    const promise = runExecutorCommand(
      { command: 'branch.files.browse' },
      { executorCommandTemplate: 'launch --user {unix_user} -- {command}' }
    );

    proc.emit('exit', 0);

    await expect(promise).resolves.toEqual({
      success: false,
      error: {
        code: 'EXECUTOR_RESULT_MISSING',
        message: 'Executor exited with code 0 but did not emit a JSON result',
        details: {
          command: 'branch.files.browse',
          exitCode: 0,
          stderr: '',
        },
      },
    });
  });

  it('refuses every unscoped executor launch when tenant context is required', async () => {
    const { configureExecutor, spawnExecutor } = await import('./spawn-executor');
    configureExecutor(null, { requireTenantContext: true });

    expect(() => spawnExecutor({ command: 'prompt' })).toThrow(
      'Missing active tenant context for executor launch'
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('propagates an explicit LOG_LEVEL to local executor processes at startup', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { spawnExecutor } = await import('./spawn-executor');

    spawnExecutor(
      { command: 'prompt' },
      {
        env: { PATH: '/usr/bin', LOG_LEVEL: 'warn' },
      }
    );

    expect(spawnMock).toHaveBeenCalledWith(
      'node',
      ['executor', '--stdin'],
      expect.objectContaining({
        env: expect.objectContaining({
          DAEMON_URL: expect.any(String),
          LOG_LEVEL: 'warn',
        }),
      })
    );
  });

  it('derives LOG_LEVEL for executor processes when only NODE_ENV is set', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const previousNodeEnv = process.env.NODE_ENV;
    const previousLogLevel = process.env.LOG_LEVEL;
    process.env.NODE_ENV = 'production';
    delete process.env.LOG_LEVEL;

    try {
      const { spawnExecutor } = await import('./spawn-executor');
      spawnExecutor({ command: 'prompt' }, { env: { PATH: '/usr/bin' } });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousLogLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previousLogLevel;
    }

    expect(spawnMock).toHaveBeenCalledWith(
      'node',
      ['executor', '--stdin'],
      expect.objectContaining({
        env: expect.objectContaining({
          LOG_LEVEL: 'info',
        }),
      })
    );
  });
  it('honors AGOR_EXECUTOR_PATH for local executor discovery', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agor-executor-path-'));
    const executorPath = path.join(dir, 'agor-executor');
    const previous = process.env.AGOR_EXECUTOR_PATH;

    try {
      writeFileSync(executorPath, '#!/usr/bin/env node\n');
      process.env.AGOR_EXECUTOR_PATH = executorPath;

      const { findExecutorPath } = await import('./spawn-executor');

      expect(findExecutorPath()).toBe(executorPath);
    } finally {
      if (previous === undefined) {
        delete process.env.AGOR_EXECUTOR_PATH;
      } else {
        process.env.AGOR_EXECUTOR_PATH = previous;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails fast when AGOR_EXECUTOR_PATH points at a missing file', async () => {
    const previous = process.env.AGOR_EXECUTOR_PATH;
    process.env.AGOR_EXECUTOR_PATH = '/tmp/agor-missing-executor-for-test';

    try {
      const { findExecutorPath } = await import('./spawn-executor');

      expect(() => findExecutorPath()).toThrow(
        'Configured AGOR_EXECUTOR_PATH does not exist: /tmp/agor-missing-executor-for-test'
      );
    } finally {
      if (previous === undefined) {
        delete process.env.AGOR_EXECUTOR_PATH;
      } else {
        process.env.AGOR_EXECUTOR_PATH = previous;
      }
    }
  });
});

describe('substituteTemplateVariables', () => {
  it('substitutes a {tenant_id} placeholder with the provided tenant', async () => {
    const { substituteTemplateVariables } = await import('./spawn-executor');

    const result = substituteTemplateVariables('launch --tenant-id {tenant_id} -- {command}', {
      tenant_id: 'tenant-xyz',
      command: 'git.clone',
    });

    expect(result).toBe("launch --tenant-id 'tenant-xyz' -- git.clone");
  });

  it('throws when {tenant_id} is required but no tenant is provided', async () => {
    const { substituteTemplateVariables } = await import('./spawn-executor');

    expect(() =>
      substituteTemplateVariables('launch --tenant-id {tenant_id} -- {command}', {
        command: 'git.clone',
      })
    ).toThrow(
      'executor_command_template requires {tenant_id}, but no active tenant context is available'
    );
  });

  it('substitutes a valid {unix_user} value', async () => {
    const { substituteTemplateVariables } = await import('./spawn-executor');

    const result = substituteTemplateVariables('launch --user {unix_user}', {
      unix_user: 'agor_alice',
    });

    expect(result).toBe('launch --user agor_alice');
  });

  it.each([
    { name: 'shell metacharacters', value: 'alice; rm -rf /' },
    { name: 'path traversal', value: '../other-tenant' },
    { name: 'command substitution', value: '$(whoami)' },
    { name: 'uppercase (outside the Unix username charset)', value: 'Alice' },
  ])('refuses a malformed {unix_user} value: $name', async ({ value }) => {
    const { substituteTemplateVariables } = await import('./spawn-executor');

    // The template runs via `sh -c` and launchers use {unix_user} as a path
    // segment for per-user home mounts, so format validation (not escaping)
    // is the control — it must reject both shell and path-traversal shapes.
    expect(() =>
      substituteTemplateVariables('launch --user {unix_user}', { unix_user: value })
    ).toThrow('{unix_user} value is not a valid Unix username');
  });
});
