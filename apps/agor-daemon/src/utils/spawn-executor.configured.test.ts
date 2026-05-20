import { EventEmitter } from 'node:events';
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
      { stdio: ['pipe', 'pipe', 'pipe'] }
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

    expect(spawnMock).toHaveBeenCalledWith('sh', ['-c', 'explicit explicit-user git.clone'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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

    expect(spawnMock).toHaveBeenCalledWith('sh', ['-c', 'injected injected-user prompt'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });
});
