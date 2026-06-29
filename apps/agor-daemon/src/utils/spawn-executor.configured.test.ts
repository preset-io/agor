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

  it('calls onExit for templated spawns', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const onExit = vi.fn();
    const { configureExecutor, spawnExecutor } = await import('./spawn-executor');

    configureExecutor({ executor_command_template: 'echo {command}' });
    spawnExecutor({ command: 'git.clone' }, { onExit });

    proc.emit('exit', 17);

    expect(onExit).toHaveBeenCalledWith(17);
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
