import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { containMock, spawnMock, trackMock, untrackMock } = vi.hoisted(() => ({
  containMock: vi.fn(),
  spawnMock: vi.fn(),
  trackMock: vi.fn(),
  untrackMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../executor-tracking.js', () => ({
  containExecutorProcess: containMock,
  markExecutorProcessExited: vi.fn(),
  trackExecutorProcess: trackMock,
  untrackExecutorProcess: untrackMock,
}));

vi.mock('@agor/core/unix', () => ({
  attachEnvFileCleanup: vi.fn(),
  buildSpawnArgs: vi.fn(),
  escapeShellArg: (value: string) => `'${value.replace(/'/g, "'\\''")}'`,
  isSecretEnvKey: vi.fn(),
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
    pid: number;
  };
  proc.pid = 4242;
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

function installMockExecutor(prefix: string, proc = createMockProcess()) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const executorPath = path.join(dir, 'agor-executor');
  const previousPath = process.env.AGOR_EXECUTOR_PATH;
  writeFileSync(executorPath, '#!/usr/bin/env node\n');
  process.env.AGOR_EXECUTOR_PATH = executorPath;
  spawnMock.mockReturnValue(proc);
  return {
    proc,
    restore() {
      if (previousPath === undefined) delete process.env.AGOR_EXECUTOR_PATH;
      else process.env.AGOR_EXECUTOR_PATH = previousPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('configured executor spawning', () => {
  beforeEach(async () => {
    vi.resetModules();
    spawnMock.mockReset();
    containMock.mockReset();
    containMock.mockResolvedValue({ status: 'verified_absent' });
    trackMock.mockReset();
    untrackMock.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const unix = await import('@agor/core/unix');
    vi.mocked(unix.buildSpawnArgs).mockReturnValue({ cmd: 'node', args: ['executor', '--stdin'] });
    vi.mocked(unix.isSecretEnvKey).mockReturnValue(false);
    vi.mocked(unix.prepareImpersonationEnv).mockReset();
    vi.mocked(unix.attachEnvFileCleanup).mockReset();
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

  it('rejects a missing generic cwd before creating an impersonation env file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agor-executor-cwd-'));
    const executorPath = path.join(dir, 'agor-executor');
    const missingCwd = path.join(dir, 'missing');
    const previous = process.env.AGOR_EXECUTOR_PATH;
    writeFileSync(executorPath, '#!/usr/bin/env node\n');
    process.env.AGOR_EXECUTOR_PATH = executorPath;

    try {
      const unix = await import('@agor/core/unix');
      vi.mocked(unix.prepareImpersonationEnv).mockReturnValue({
        inlineEnv: { PATH: '/usr/bin' },
        envFilePath: path.join(dir, 'should-not-exist.env'),
      });
      const { runExecutorCommand } = await import('./spawn-executor');
      const result = await runExecutorCommand(
        { command: 'opencode.auth', params: { operation: 'discover' } },
        {
          cwd: missingCwd,
          asUser: 'alice',
          env: { PATH: '/usr/bin', OPENAI_API_KEY: 'must-not-write' },
        }
      );

      expect(result).toEqual({
        success: false,
        error: {
          code: 'EXECUTOR_CWD_MISSING',
          message: `Refusing to spawn: cwd does not exist on disk: ${missingCwd}`,
        },
      });
      expect(unix.prepareImpersonationEnv).not.toHaveBeenCalled();
      expect(unix.attachEnvFileCleanup).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.AGOR_EXECUTOR_PATH;
      else process.env.AGOR_EXECUTOR_PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps OAuth lifecycle frames private and contains the whole process group on cancel', async () => {
    const fixture = installMockExecutor('agor-oauth-executor-');
    const { proc } = fixture;
    const onEvent = vi.fn();

    try {
      const { startOpenCodeOAuthExecutor } = await import('./spawn-executor');
      const handle = startOpenCodeOAuthExecutor(
        {
          command: 'opencode.auth',
          dataHome: '/private/synthetic-home',
          params: {
            operation: 'connect-oauth',
            providerId: 'openai',
            method: 1,
            inputs: { account: 'synthetic-secret-input' },
          },
        },
        { env: { PATH: '/usr/bin' } },
        onEvent
      );

      expect(spawnMock).toHaveBeenCalledWith(
        'node',
        ['executor', '--stdin'],
        expect.objectContaining({ detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
      );
      proc.stdout.emit(
        'data',
        Buffer.from(
          'AGOR_OPENCODE_OAUTH_EVENT {"type":"authorized","authorization":{"url":"http://127.0.0.1/authorize","method":"auto","instructions":"Synthetic code 1234"}}\n'
        )
      );
      proc.stderr.emit(
        'data',
        Buffer.from('synthetic-secret-input /private/synthetic-home generated-password')
      );
      expect(onEvent).toHaveBeenCalledWith({
        type: 'authorized',
        authorization: {
          url: 'http://127.0.0.1/authorize',
          method: 'auto',
          instructions: 'Synthetic code 1234',
        },
      });

      const cancellation = handle.cancel();
      proc.emit('exit', null);
      proc.emit('close', null);
      await expect(cancellation).resolves.toMatchObject({
        success: false,
        error: { code: 'OPENCODE_OAUTH_CANCELLED' },
      });
      await expect(handle.result).resolves.toMatchObject({
        success: false,
        error: { code: 'OPENCODE_OAUTH_CANCELLED' },
      });
      expect(trackMock).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 4242, asUser: undefined })
      );
      expect(containMock).toHaveBeenCalledOnce();
      expect(untrackMock).toHaveBeenCalledOnce();
      expect(JSON.stringify(await handle.result)).not.toContain('synthetic-secret-input');
      expect(JSON.stringify(await handle.result)).not.toContain('/private/synthetic-home');
      expect(console.error).not.toHaveBeenCalledWith(
        expect.stringContaining('synthetic-secret-input')
      );
      expect(console.error).not.toHaveBeenCalledWith(
        expect.stringContaining('/private/synthetic-home')
      );
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Synthetic code 1234'));
    } finally {
      fixture.restore();
    }
  });

  it('rejects non-containable templated OAuth without spawning', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { configureExecutor, startOpenCodeOAuthExecutor } = await import('./spawn-executor');
    configureExecutor({ executor_command_template: 'remote {command}' });

    const handle = startOpenCodeOAuthExecutor({ command: 'opencode.auth' }, {}, vi.fn());

    await expect(handle.result).resolves.toEqual({
      success: false,
      error: {
        code: 'OPENCODE_OAUTH_LOCAL_EXECUTOR_REQUIRED',
        message: 'OpenCode OAuth requires a locally containable executor process.',
      },
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('contains the OAuth process group on its bounded timeout', async () => {
    vi.useFakeTimers();
    const fixture = installMockExecutor('agor-oauth-timeout-');
    const { proc } = fixture;

    try {
      const { startOpenCodeOAuthExecutor } = await import('./spawn-executor');
      const handle = startOpenCodeOAuthExecutor(
        { command: 'opencode.auth' },
        { env: { PATH: '/usr/bin' }, timeoutMs: 25 },
        vi.fn()
      );
      await vi.advanceTimersByTimeAsync(25);
      proc.emit('exit', null);
      proc.emit('close', null);

      await expect(handle.result).resolves.toMatchObject({
        success: false,
        error: { code: 'OPENCODE_OAUTH_TIMEOUT' },
      });
      expect(containMock).toHaveBeenCalledOnce();
      expect(untrackMock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      fixture.restore();
    }
  });

  it('waits for close and parses the final OAuth result frame after exit', async () => {
    const fixture = installMockExecutor('agor-oauth-final-frame-');
    const { proc } = fixture;

    try {
      const { startOpenCodeOAuthExecutor } = await import('./spawn-executor');
      const handle = startOpenCodeOAuthExecutor(
        { command: 'opencode.auth' },
        { env: { PATH: '/usr/bin' } },
        vi.fn()
      );

      proc.emit('exit', 0);
      proc.stdout.emit(
        'data',
        Buffer.from('AGOR_EXECUTOR_RESULT {"success":true,"data":{"runtime":"available"}}')
      );
      let settled = false;
      void handle.result.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      proc.emit('close', 0);
      await expect(handle.result).resolves.toEqual({
        success: true,
        data: { runtime: 'available' },
      });
    } finally {
      fixture.restore();
    }
  });

  it.each([
    ['missing', ''],
    ['truncated', 'AGOR_EXECUTOR_RESULT {"success":true'],
  ])('fails safely for a %s OAuth result frame after close', async (_label, frame) => {
    const fixture = installMockExecutor('agor-oauth-missing-frame-');
    const { proc } = fixture;

    try {
      const { startOpenCodeOAuthExecutor } = await import('./spawn-executor');
      const handle = startOpenCodeOAuthExecutor(
        { command: 'opencode.auth' },
        { env: { PATH: '/usr/bin' } },
        vi.fn()
      );
      if (frame) proc.stdout.emit('data', Buffer.from(frame));
      proc.stderr.emit('data', Buffer.from('secret password /private/path'));
      proc.emit('exit', 1);
      proc.emit('close', 1);

      await expect(handle.result).resolves.toEqual({
        success: false,
        error: {
          code: 'EXECUTOR_RESULT_MISSING',
          message: 'OpenCode OAuth executor did not emit a result.',
          details: { stderr: '[redacted]' },
        },
      });
      expect(JSON.stringify(await handle.result)).not.toContain('secret password');
      expect(JSON.stringify(await handle.result)).not.toContain('/private/path');
    } finally {
      fixture.restore();
    }
  });

  it('shares one finalization across cancel and exit and retains unverified tracking', async () => {
    const fixture = installMockExecutor('agor-oauth-unverified-');
    const { proc } = fixture;
    containMock.mockResolvedValue({
      status: 'unverified',
      reason: 'synthetic containment failure',
    });

    try {
      const { startOpenCodeOAuthExecutor } = await import('./spawn-executor');
      const handle = startOpenCodeOAuthExecutor(
        { command: 'opencode.auth' },
        { env: { PATH: '/usr/bin' } },
        vi.fn()
      );
      const first = handle.cancel();
      const second = handle.cancel();
      expect(second).toBe(first);
      proc.emit('exit', null);
      proc.emit('close', null);

      await expect(first).resolves.toMatchObject({
        success: false,
        error: { code: 'OPENCODE_OAUTH_CLEANUP_UNVERIFIED' },
      });
      await expect(second).resolves.toMatchObject({
        success: false,
        error: { code: 'OPENCODE_OAUTH_CLEANUP_UNVERIFIED' },
      });
      await expect(handle.result).resolves.toMatchObject({
        success: false,
        error: { code: 'OPENCODE_OAUTH_CLEANUP_UNVERIFIED' },
      });
      expect(containMock).toHaveBeenCalledOnce();
      expect(untrackMock).not.toHaveBeenCalled();

      containMock.mockResolvedValue({ status: 'verified_absent' });
      await expect(handle.verifyAbsence()).resolves.toBe(true);
      expect(containMock).toHaveBeenCalledTimes(2);
      expect(untrackMock).toHaveBeenCalledOnce();
    } finally {
      fixture.restore();
    }
  });

  it('submits exactly one secret code over the bounded OAuth stdin without echoing it', async () => {
    const proc = createMockProcess();
    let finishInput!: () => void;
    proc.stdin = new Writable({
      write(chunk, _encoding, callback) {
        proc.written += chunk.toString();
        callback();
      },
      final(callback) {
        finishInput = callback;
      },
    });
    const fixture = installMockExecutor('agor-oauth-code-', proc);

    try {
      const { startOpenCodeOAuthExecutor } = await import('./spawn-executor');
      const handle = startOpenCodeOAuthExecutor(
        { command: 'opencode.auth' },
        { env: { PATH: '/usr/bin' } },
        vi.fn()
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const submission = handle.submitCode('synthetic-secret-code');
      let deliverySettled = false;
      void submission.then(() => {
        deliverySettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(deliverySettled).toBe(false);
      finishInput();
      await expect(submission).resolves.toBe(true);
      await expect(handle.submitCode('second-code')).resolves.toBe(false);
      expect(proc.written).toContain('"code":"synthetic-secret-code"');
      expect(proc.written).not.toContain('second-code');
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining('synthetic-secret-code')
      );

      const cancellation = handle.cancel();
      proc.emit('exit', null);
      proc.emit('close', null);
      await cancellation;
    } finally {
      fixture.restore();
    }
  });

  it('rejects code delivery when stdin finalization fails asynchronously', async () => {
    const proc = createMockProcess();
    proc.stdin = new Writable({
      write(chunk, _encoding, callback) {
        proc.written += chunk.toString();
        callback();
      },
      final(callback) {
        setImmediate(() => callback(new Error('EPIPE synthetic-secret-code /private/final-path')));
      },
    });
    const fixture = installMockExecutor('agor-oauth-code-final-', proc);

    try {
      const { startOpenCodeOAuthExecutor } = await import('./spawn-executor');
      const handle = startOpenCodeOAuthExecutor(
        { command: 'opencode.auth' },
        { env: { PATH: '/usr/bin' } },
        vi.fn()
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const submission = handle.submitCode('synthetic-secret-code');

      await expect(submission).resolves.toBe(false);
      proc.emit('exit', 1);
      proc.emit('close', 1);

      await expect(handle.result).resolves.toEqual({
        success: false,
        error: {
          code: 'OPENCODE_OAUTH_STDIN_FAILED',
          message: 'OpenCode OAuth executor input could not be delivered.',
        },
      });
      expect(JSON.stringify(await handle.result)).not.toContain('synthetic-secret-code');
      expect(JSON.stringify(await handle.result)).not.toContain('/private/final-path');
      expect(console.error).not.toHaveBeenCalledWith(
        expect.stringContaining('synthetic-secret-code')
      );
    } finally {
      fixture.restore();
    }
  });

  it('owns an initial OAuth stdin delivery failure without exposing the payload', async () => {
    const proc = createMockProcess();
    proc.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('EPIPE synthetic-secret /private/path'));
      },
    });
    const fixture = installMockExecutor('agor-oauth-initial-write-', proc);

    try {
      const { startOpenCodeOAuthExecutor } = await import('./spawn-executor');
      const handle = startOpenCodeOAuthExecutor(
        {
          command: 'opencode.auth',
          dataHome: '/private/path',
          params: { operation: 'connect-oauth', providerId: 'openai', method: 0 },
        },
        { env: { PATH: '/usr/bin' } },
        vi.fn()
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      proc.emit('exit', 1);
      proc.emit('close', 1);

      await expect(handle.result).resolves.toEqual({
        success: false,
        error: {
          code: 'OPENCODE_OAUTH_STDIN_FAILED',
          message: 'OpenCode OAuth executor input could not be delivered.',
        },
      });
      expect(JSON.stringify(await handle.result)).not.toContain('synthetic-secret');
      expect(JSON.stringify(await handle.result)).not.toContain('/private/path');
      expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('synthetic-secret'));
    } finally {
      fixture.restore();
    }
  });

  it('settles a failed code write through concurrent cancellation and exit', async () => {
    const proc = createMockProcess();
    let writes = 0;
    let failCodeWrite!: () => void;
    proc.stdin = new Writable({
      write(chunk, _encoding, callback) {
        writes += 1;
        proc.written += chunk.toString();
        if (writes === 1) callback();
        else {
          failCodeWrite = () =>
            callback(new Error('EPIPE synthetic-secret-code /private/code-path'));
        }
      },
    });
    const fixture = installMockExecutor('agor-oauth-code-write-', proc);

    try {
      const { startOpenCodeOAuthExecutor } = await import('./spawn-executor');
      const handle = startOpenCodeOAuthExecutor(
        { command: 'opencode.auth' },
        { env: { PATH: '/usr/bin' } },
        vi.fn()
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const submission = handle.submitCode('synthetic-secret-code');
      expect(writes).toBe(2);
      const cancellation = handle.cancel();
      failCodeWrite();
      await new Promise<void>((resolve) => setImmediate(resolve));
      proc.emit('exit', null);
      proc.emit('close', null);

      await expect(submission).resolves.toBe(false);
      await expect(cancellation).resolves.toMatchObject({
        success: false,
        error: { code: 'OPENCODE_OAUTH_CANCELLED' },
      });
      await expect(handle.result).resolves.toMatchObject({
        success: false,
        error: { code: 'OPENCODE_OAUTH_CANCELLED' },
      });
      expect(console.error).not.toHaveBeenCalledWith(
        expect.stringContaining('synthetic-secret-code')
      );
      expect(JSON.stringify(await handle.result)).not.toContain('/private/code-path');
    } finally {
      fixture.restore();
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
});
