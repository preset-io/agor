import { EventEmitter } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildSandboxWrapMock,
  containMock,
  ensureAuthorityMock,
  openDirectoryBindMock,
  spawnMock,
  trackMock,
  untrackMock,
} = vi.hoisted(() => ({
  buildSandboxWrapMock: vi.fn(() => null),
  containMock: vi.fn(),
  ensureAuthorityMock: vi.fn(),
  openDirectoryBindMock: vi.fn(),
  spawnMock: vi.fn(),
  trackMock: vi.fn(),
  untrackMock: vi.fn(),
}));
// The concurrent main handoff regression still uses the pre-rename identifier.
const sandboxWrapMock = buildSandboxWrapMock;

const OAUTH_DATA_HOME = '/private/synthetic-home';
const LOCAL_RESPONSE_OPTIONS = { localResponseOriginUrl: 'http://localhost:3030' } as const;
const OAUTH_REQUEST = {
  operation: 'connect-oauth',
  providerId: 'openai',
  method: 0,
};

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../executor-tracking.js', () => ({
  containExecutorProcess: containMock,
  markExecutorProcessExited: vi.fn(),
  trackExecutorProcess: trackMock,
  untrackExecutorProcess: untrackMock,
}));

vi.mock('@agor/core/codex/credential-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/codex/credential-file')>();
  openDirectoryBindMock.mockImplementation(actual.openOrCreatePrivateDirectoryForBindSync);
  return {
    ...actual,
    ensureCredentialAuthorityLayoutSync: ensureAuthorityMock,
    openOrCreatePrivateDirectoryForBindSync: openDirectoryBindMock,
  };
});

vi.mock('./sandbox-wrap.js', () => ({
  buildSandboxWrap: buildSandboxWrapMock,
}));

vi.mock('@agor/core/unix', () => ({
  isValidExecutionHomeKey: (username: string) => /^[a-z_][a-z0-9_-]{0,31}$/.test(username),
  probeBwrapPidNamespace: () => true,
  probeBwrapSecurityBaseline: () => true,
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
    kill: ReturnType<typeof vi.fn>;
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
  proc.kill = vi.fn();
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

async function deliverExecutorResponse(
  proc: ReturnType<typeof createMockProcess>,
  result: { success: boolean; data?: unknown; error?: { code: string; message: string } },
  events: unknown[] = []
) {
  const firstLine = proc.written.trim().split('\n')[0];
  const payload = JSON.parse(firstLine) as {
    executorResponse: { requestId: string; token: string };
  };
  const { submitExecutorResponseForTesting } = await import('../executor-response-channel');
  const frames = [
    ...events.map((event, seq) => {
      const { type, ...data } = event as Record<string, unknown>;
      return {
        v: 1,
        requestId: payload.executorResponse.requestId,
        type: 'event',
        seq,
        name: type,
        data,
      };
    }),
    {
      v: 1,
      requestId: payload.executorResponse.requestId,
      type: 'final',
      seq: events.length,
      result,
    },
  ];
  expect(
    submitExecutorResponseForTesting({
      requestId: payload.executorResponse.requestId,
      token: payload.executorResponse.token,
      frames,
    })
  ).toBe(true);
}

async function deliverExecutorEvents(
  proc: ReturnType<typeof createMockProcess>,
  events: unknown[]
) {
  const payload = JSON.parse(proc.written.trim().split('\n')[0]) as {
    executorResponse: { requestId: string; token: string };
  };
  const { submitExecutorResponseForTesting } = await import('../executor-response-channel');
  expect(
    submitExecutorResponseForTesting({
      requestId: payload.executorResponse.requestId,
      token: payload.executorResponse.token,
      frames: events.map((event, seq) => {
        const { type, ...data } = event as Record<string, unknown>;
        return {
          v: 1,
          requestId: payload.executorResponse.requestId,
          type: 'event',
          seq,
          name: type,
          data,
        };
      }),
    })
  ).toBe(true);
}

describe('configured executor spawning', () => {
  beforeEach(async () => {
    vi.resetModules();
    spawnMock.mockReset();
    sandboxWrapMock.mockReset();
    sandboxWrapMock.mockReturnValue(null);
    containMock.mockReset();
    containMock.mockResolvedValue({ status: 'verified_absent' });
    ensureAuthorityMock.mockClear();
    openDirectoryBindMock.mockClear();
    trackMock.mockReset();
    untrackMock.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { configureExecutor } = await import('./spawn-executor');
    configureExecutor(
      {
        executor_response: {
          origin_url: 'http://localhost:3030',
          external_protocol: 'executor-response-v1',
        },
      },
      LOCAL_RESPONSE_OPTIONS
    );
  });

  it.runIf(process.platform === 'linux')(
    'prepares credential authority and a real fresh tmp source before a per-user sandbox spawn',
    async () => {
      const installed = installMockExecutor('agor-executor-authority-layout-');
      const root = mkdtempSync(path.join(tmpdir(), 'agor-sandbox-runtime-'));
      const ownerStore = path.join(root, 'owner');
      const branch = path.join(root, 'branch');
      const { configureExecutor, spawnExecutor } = await import('./spawn-executor');
      configureExecutor(
        { sandbox: { enabled: true, home_mode: 'per_user' } },
        {
          ...LOCAL_RESPONSE_OPTIONS,
          sandboxRuntimePaths: {
            homeDir: path.join(root, 'home'),
            dataHome: path.join(root, 'data'),
            protectedDataRoots: [path.join(root, 'data')],
            worktreesRoot: path.join(root, 'worktrees'),
            agenticToolsPath: path.join(root, 'agentic-tools'),
            agorConfigPath: path.join(root, 'config.yaml'),
          },
        }
      );

      spawnExecutor({
        command: 'prompt',
        params: { cwd: branch, sandboxHomeStore: ownerStore },
      });

      expect(spawnMock).toHaveBeenCalledOnce();
      expect(ensureAuthorityMock).toHaveBeenCalledWith(
        path.join(ownerStore, '.claude', '.credentials.json')
      );
      expect(ensureAuthorityMock.mock.invocationCallOrder[0]).toBeLessThan(
        openDirectoryBindMock.mock.invocationCallOrder[0] as number
      );
      expect(openDirectoryBindMock).toHaveBeenCalledWith(path.join(ownerStore, 'tmp'));
      expect(lstatSync(path.join(ownerStore, 'tmp')).isDirectory()).toBe(true);
      expect(openDirectoryBindMock.mock.invocationCallOrder[0]).toBeLessThan(
        buildSandboxWrapMock.mock.invocationCallOrder[0] as number
      );
      expect(buildSandboxWrapMock).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerHomeStore: ownerStore,
          ownerTmpBindFd: 3,
          branchPath: branch,
        })
      );

      installed.restore();
      rmSync(root, { recursive: true, force: true });
    }
  );

  it('uses execution.executor_command_template configured at startup', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { configureExecutor, spawnExecutor } = await import('./spawn-executor');

    configureExecutor(
      {
        executor_command_template: 'kubectl run executor-{task_id} --user {unix_user} -- {command}',
      },
      LOCAL_RESPONSE_OPTIONS
    );

    spawnExecutor({ command: 'prompt' }, { logPrefix: '[test]', delegatedHomeKey: 'agor-exec' });

    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock).toHaveBeenCalledWith(
      'sh',
      [
        '-c',
        expect.stringMatching(/^kubectl run executor-[0-9a-f]{8} --user agor-exec -- prompt$/),
      ],
      expect.objectContaining({ stdio: ['pipe', 'ignore', 'ignore'] })
    );
    expect(JSON.parse(proc.written)).toMatchObject({
      command: 'prompt',
      executorMode: 'autonomous',
      resolvedConfig: expect.any(Object),
    });
  });

  it('keeps reserved launcher credentials in the trusted template process only', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const launcherCredentials = {
      AGOR_CLOUD_API_BASE_URL: 'https://synthetic-launcher.invalid/api',
      AGOR_CLOUD_RUNTIME_CREDENTIAL_ID: 'synthetic-launcher-credential-id',
      AGOR_CLOUD_RUNTIME_SIGNING_KEY: 'synthetic-launcher-signing-key',
      // A future launcher field is covered by the reserved prefix contract,
      // not an allowlist that can silently fall behind the launcher.
      AGOR_CLOUD_FUTURE_LAUNCHER_CREDENTIAL: 'synthetic-future-launcher-credential',
    } as const;
    const withheldDaemonEnvironment = {
      DATABASE_URL: 'postgres://synthetic-daemon.invalid/agor',
      AGOR_MASTER_SECRET: 'synthetic-deployment-master-secret',
      AGOR_JWT_SECRET: 'synthetic-daemon-jwt-secret',
      AGOR_ADMIN_PASSWORD: 'synthetic-bootstrap-password',
      REDIS_URL: 'redis://synthetic-daemon.invalid',
      OPENAI_API_KEY: 'synthetic-openai-provider-credential',
      ANTHROPIC_API_KEY: 'synthetic-anthropic-provider-credential',
      GEMINI_API_KEY: 'synthetic-gemini-provider-credential',
      GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/daemon/google-credentials.json',
      AWS_SECRET_ACCESS_KEY: 'synthetic-object-store-credential',
      SYNTHETIC_DAEMON_INTERNAL_SECRET: 'synthetic-unknown-future-daemon-secret',
    } as const;
    const ambient = { ...launcherCredentials, ...withheldDaemonEnvironment };
    const previous = Object.fromEntries(Object.keys(ambient).map((key) => [key, process.env[key]]));
    Object.assign(process.env, ambient);
    try {
      const { createUserProcessEnvironment } = await import('@agor/core/config');
      const { configureExecutor, spawnExecutor } = await import('./spawn-executor');
      configureExecutor(
        { executor_command_template: 'launch -- {command}' },
        LOCAL_RESPONSE_OPTIONS
      );

      // Exercise the real session-env assembly boundary rather than handing a
      // made-up env object directly to spawnExecutor.
      const sessionEnv = await createUserProcessEnvironment(undefined, undefined, {
        SYNTHETIC_SESSION_SETTING: 'ordinary-session-value',
      });
      spawnExecutor({ command: 'prompt', env: sessionEnv }, { preparedEnv: sessionEnv });

      const streamCanary = launcherCredentials.AGOR_CLOUD_RUNTIME_SIGNING_KEY;
      proc.stdout.emit('data', Buffer.from(`launcher stdout ${streamCanary}`));
      proc.stderr.emit('data', Buffer.from(`launcher stderr ${streamCanary}`));

      const launcherOptions = spawnMock.mock.calls[0][2] as {
        env: Record<string, string>;
        stdio: string[];
      };
      const executorPayload = JSON.parse(proc.written) as {
        env: Record<string, string>;
      };

      expect(launcherOptions.env.PATH).toBe(process.env.PATH);
      expect(launcherOptions.env).toMatchObject(launcherCredentials);
      expect(launcherOptions.stdio).toEqual(['pipe', 'ignore', 'ignore']);
      expect(launcherOptions.env.SYNTHETIC_SESSION_SETTING).toBeUndefined();
      expect(executorPayload.env.SYNTHETIC_SESSION_SETTING).toBe('ordinary-session-value');
      expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(streamCanary);
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(streamCanary);

      for (const [name, value] of Object.entries(withheldDaemonEnvironment)) {
        expect(launcherOptions.env, `${name} reached the templated launcher`).not.toHaveProperty(
          name
        );
        expect(executorPayload.env, `${name} reached the executor payload`).not.toHaveProperty(
          name
        );
        expect(proc.written).not.toContain(value);
      }
      for (const [name, value] of Object.entries(launcherCredentials)) {
        expect(sessionEnv, `${name} reached the resolved session env`).not.toHaveProperty(name);
        expect(executorPayload.env, `${name} reached the executor payload`).not.toHaveProperty(
          name
        );
        expect(proc.written).not.toContain(value);
      }
    } finally {
      for (const key of Object.keys(ambient)) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('lets explicit spawn options override configured defaults', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { configureExecutor, spawnExecutor } = await import('./spawn-executor');

    configureExecutor(
      {
        executor_command_template: 'configured {unix_user} {command}',
      },
      LOCAL_RESPONSE_OPTIONS
    );

    spawnExecutor(
      { command: 'git.clone' },
      {
        executorCommandTemplate: 'explicit {unix_user} {command}',
        delegatedHomeKey: 'explicit-user',
      }
    );

    expect(spawnMock).toHaveBeenCalledWith(
      'sh',
      ['-c', 'explicit explicit-user git.clone'],
      expect.objectContaining({ stdio: ['pipe', 'ignore', 'ignore'] })
    );
  });

  it('forwards a delegated read identity through a configured command template', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { requestExecutor } = await import('./spawn-executor');
    const promise = requestExecutor(
      { command: 'branch.files.browse' },
      {
        executorCommandTemplate: 'launch --user {unix_user} -- {command}',
        delegatedHomeKey: 'alice',
      }
    );

    await deliverExecutorResponse(proc, { success: true, data: { files: [] } });
    proc.emit('exit', 0);

    await expect(promise).resolves.toEqual({
      success: true,
      data: { files: [] },
    });
    expect(JSON.parse(proc.written)).toMatchObject({
      executorMode: 'request',
      executorResponse: {
        protocol: 'executor-response-v1',
        profile: 'terminal',
        requestId: expect.any(String),
        token: expect.any(String),
        maxResponseBytes: 8 * 1024 * 1024,
      },
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'sh',
      ['-c', 'launch --user alice -- branch.files.browse'],
      expect.objectContaining({ stdio: ['pipe', 'ignore', 'ignore'] })
    );
  });

  it('keeps trusted credentials out of request payloads and launcher output logs', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const ambient = {
      AGOR_CLOUD_RUNTIME_SIGNING_KEY: 'synthetic-request-launcher-signing-key',
      AGOR_CLOUD_FUTURE_REQUEST_CREDENTIAL: 'synthetic-request-launcher-future-key',
      DATABASE_URL: 'postgres://synthetic-request-daemon.invalid/agor',
      AGOR_MASTER_SECRET: 'synthetic-request-master-secret',
      OPENAI_API_KEY: 'synthetic-request-provider-secret',
    } as const;
    const previous = Object.fromEntries(Object.keys(ambient).map((key) => [key, process.env[key]]));
    Object.assign(process.env, ambient);

    try {
      const { requestExecutor } = await import('./spawn-executor');
      const promise = requestExecutor(
        {
          command: 'branch.files.browse',
          env: { SYNTHETIC_REQUEST_SETTING: 'ordinary-request-value' },
        },
        { executorCommandTemplate: 'launch {command}' }
      );
      proc.stdout.emit('data', Buffer.from(ambient.AGOR_CLOUD_RUNTIME_SIGNING_KEY));
      proc.stderr.emit('data', Buffer.from(ambient.AGOR_CLOUD_FUTURE_REQUEST_CREDENTIAL));

      const options = spawnMock.mock.calls[0][2] as {
        env: Record<string, string>;
        stdio: string[];
      };
      const executorPayload = JSON.parse(proc.written) as { env: Record<string, string> };
      expect(options.env).toMatchObject({
        AGOR_CLOUD_RUNTIME_SIGNING_KEY: ambient.AGOR_CLOUD_RUNTIME_SIGNING_KEY,
        AGOR_CLOUD_FUTURE_REQUEST_CREDENTIAL: ambient.AGOR_CLOUD_FUTURE_REQUEST_CREDENTIAL,
      });
      expect(options.stdio).toEqual(['pipe', 'ignore', 'ignore']);
      expect(executorPayload.env).toEqual({
        SYNTHETIC_REQUEST_SETTING: 'ordinary-request-value',
      });
      for (const [name, value] of Object.entries(ambient)) {
        if (!name.startsWith('AGOR_CLOUD_')) expect(options.env).not.toHaveProperty(name);
        expect(executorPayload.env).not.toHaveProperty(name);
        expect(proc.written).not.toContain(value);
        expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(value);
        expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(value);
      }

      await deliverExecutorResponse(proc, { success: true, data: { files: [] } });
      proc.emit('exit', 0);
      await expect(promise).resolves.toEqual({ success: true, data: { files: [] } });
    } finally {
      for (const key of Object.keys(ambient)) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('calls onExit for templated spawns', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const onExit = vi.fn();
    const { configureExecutor, spawnExecutor } = await import('./spawn-executor');

    configureExecutor({ executor_command_template: 'echo {command}' }, LOCAL_RESPONSE_OPTIONS);
    spawnExecutor({ command: 'git.clone' }, { onExit });

    proc.emit('exit', 17);

    expect(onExit).toHaveBeenCalledWith(17, { mode: 'templated' });
  });

  it('observes async onExit rejection without logging sensitive error details', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const onExit = vi.fn(async () => {
      throw new Error('bound token fingerprint must not be logged');
    });
    const { configureExecutor, spawnExecutor } = await import('./spawn-executor');

    configureExecutor({ executor_command_template: 'echo {command}' }, LOCAL_RESPONSE_OPTIONS);
    spawnExecutor({ command: 'git.clone' }, { onExit, logPrefix: '[test]' });

    proc.emit('exit', 17);
    await vi.waitFor(() => {
      expect(console.error).toHaveBeenCalledWith('[test] Executor exit callback failed');
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      'bound token fingerprint'
    );
  });

  it('keeps createConfiguredSpawner isolated from module-level defaults', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { configureExecutor, createConfiguredSpawner } = await import('./spawn-executor');

    configureExecutor(
      {
        executor_command_template: 'global {command}',
      },
      LOCAL_RESPONSE_OPTIONS
    );
    const injectedSpawner = createConfiguredSpawner({
      executor_command_template: 'injected {unix_user} {command}',
    });

    injectedSpawner({ command: 'prompt' }, { delegatedHomeKey: 'injected-user' });

    expect(spawnMock).toHaveBeenCalledWith(
      'sh',
      ['-c', 'injected injected-user prompt'],
      expect.objectContaining({ stdio: ['pipe', 'ignore', 'ignore'] })
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
      expect.objectContaining({ stdio: ['pipe', 'ignore', 'ignore'] })
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
      expect.objectContaining({ stdio: ['pipe', 'ignore', 'ignore'] })
    );
  });

  it('uses ambient tenant context for short-lived templated commands', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { runWithTenantContext } = await import('@agor/core/db');
    const { requestExecutor } = await import('./spawn-executor');

    const resultPromise = runWithTenantContext('tenant-run', () =>
      requestExecutor(
        { command: 'git.repo.inspect' },
        {
          executorCommandTemplate: 'launch --tenant-id {tenant_id} -- {command}',
        }
      )
    );
    await deliverExecutorResponse(proc, { success: true, data: { ok: true } });
    proc.emit('exit', 0);

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      data: { ok: true },
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'sh',
      ['-c', "launch --tenant-id 'tenant-run' -- git.repo.inspect"],
      expect.objectContaining({ stdio: ['pipe', 'ignore', 'ignore'] })
    );
  });

  it.each([
    ['local', undefined],
    ['configured-template', 'launch {command}'],
  ])('suppresses sensitive stdout and stderr for %s commands', async (_name, template) => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { requestExecutor } = await import('./spawn-executor');
    const promise = requestExecutor(
      { command: 'codex.auth-file' },
      {
        ...(template ? { executorCommandTemplate: template } : {}),
        sensitiveOutput: true,
      }
    );
    const secret = 'credential-material-must-not-be-logged';
    await deliverExecutorResponse(proc, { success: true, data: { content: secret } });
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

  it('sandboxes short-lived branch commands with normalized filesystem access', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    buildSandboxWrapMock.mockReturnValue({
      cmd: 'bwrap',
      args: ['--synthetic-wrap', '--', '/operator/agor-executor', '--stdin'],
      extraEnv: { AGOR_SANDBOXED: '1' },
    });
    const { configureExecutor, requestExecutor } = await import('./spawn-executor');
    configureExecutor(
      { sandbox: { enabled: true, fail_if_unavailable: true } },
      {
        ...LOCAL_RESPONSE_OPTIONS,
        sandboxRuntimePaths: {
          homeDir: '/home/agor',
          dataHome: '/home/agor/.agor',
          protectedDataRoots: ['/home/agor/.agor'],
          worktreesRoot: '/home/agor/.agor/worktrees/tenant-a',
          agenticToolsPath: '/opt/agor/agentic-tools',
          agorConfigPath: '/home/agor/.agor/config.yaml',
          agorDbPath: '/home/agor/.agor/agor.db',
        },
      }
    );
    const promise = requestExecutor({
      command: 'branch.files.browse',
      params: {
        cwd: '/home/agor/.agor/worktrees/tenant-a/repo/feature',
        principalBranchAccess: 'read',
      },
    });

    await deliverExecutorResponse(proc, { success: true, data: { files: [] } });
    proc.emit('exit', 0);

    await expect(promise).resolves.toEqual({ success: true, data: { files: [] } });
    expect(buildSandboxWrapMock).toHaveBeenCalledWith(
      expect.objectContaining({
        branchPath: '/home/agor/.agor/worktrees/tenant-a/repo/feature',
        branchAccess: 'read',
        runtimePaths: expect.objectContaining({
          worktreesRoot: '/home/agor/.agor/worktrees/tenant-a',
        }),
      })
    );
    expect(spawnMock).toHaveBeenCalledWith(
      'bwrap',
      ['--synthetic-wrap', '--', '/operator/agor-executor', '--stdin'],
      expect.objectContaining({
        env: expect.objectContaining({ AGOR_SANDBOXED: '1' }),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    );
    expect(openDirectoryBindMock).not.toHaveBeenCalled();
  });

  it('carries the per-user home store through local request handoff into bubblewrap', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agor-owner-home-handoff-'));
    const homeDir = path.join(root, 'home');
    const dataHome = path.join(homeDir, '.agor');
    const branchPath = path.join(dataHome, 'worktrees', 'tenant-a', 'repo', 'feature');
    const ownerHomeStore = path.join(dataHome, 'tenants', 'tenant-a', 'homes', 'owner-a');
    mkdirSync(branchPath, { recursive: true });

    try {
      const actualSandboxWrap =
        await vi.importActual<typeof import('./sandbox-wrap.js')>('./sandbox-wrap.js');
      sandboxWrapMock.mockImplementation(actualSandboxWrap.buildSandboxWrap);
      const { configureExecutor, requestExecutor } = await import('./spawn-executor');
      configureExecutor(
        {
          sandbox: {
            enabled: true,
            fail_if_unavailable: true,
            home_mode: 'per_user',
          },
        },
        {
          ...LOCAL_RESPONSE_OPTIONS,
          sandboxRuntimePaths: {
            homeDir,
            dataHome,
            protectedDataRoots: [dataHome],
            worktreesRoot: path.join(dataHome, 'worktrees', 'tenant-a'),
            agenticToolsPath: path.join(dataHome, 'agentic-tools'),
            agorConfigPath: path.join(dataHome, 'config.yaml'),
            agorDbPath: path.join(dataHome, 'agor.db'),
          },
        }
      );

      await expect(
        requestExecutor({
          command: 'upload.materialize:session-a:upload-a',
          params: { cwd: branchPath, principalBranchAccess: 'write' },
        })
      ).resolves.toMatchObject({
        success: false,
        error: {
          code: 'EXECUTOR_SPAWN_ERROR',
          message: expect.stringContaining(
            'sandbox home_mode=per_user requires an owner home store'
          ),
        },
      });
      expect(spawnMock).not.toHaveBeenCalled();

      const proc = createMockProcess();
      spawnMock.mockReturnValue(proc);
      const resultPromise = requestExecutor({
        command: 'upload.materialize:session-a:upload-a',
        params: {
          cwd: branchPath,
          principalBranchAccess: 'write',
          sandboxHomeStore: ownerHomeStore,
        },
      });

      await deliverExecutorResponse(proc, {
        success: true,
        data: { path: '.agor/session-staging/brief.txt' },
      });
      proc.emit('exit', 0);

      await expect(resultPromise).resolves.toEqual({
        success: true,
        data: { path: '.agor/session-staging/brief.txt' },
      });
      expect(spawnMock).toHaveBeenCalledOnce();
      const bwrapArgs = spawnMock.mock.calls[0]?.[1] as string[];
      const homeBindIndex = bwrapArgs.findIndex(
        (arg, index) =>
          arg === '--bind' &&
          bwrapArgs[index + 1] === ownerHomeStore &&
          bwrapArgs[index + 2] === homeDir
      );
      const tmpBindIndex = bwrapArgs.findIndex(
        (arg, index) =>
          arg === '--bind-fd' && bwrapArgs[index + 1] === '3' && bwrapArgs[index + 2] === '/tmp'
      );
      expect(homeBindIndex).toBeGreaterThanOrEqual(0);
      expect(tmpBindIndex).toBeGreaterThan(homeBindIndex);
      expect(bwrapArgs).not.toContain(path.join(ownerHomeStore, 'tmp'));
      expect(lstatSync(path.join(ownerHomeStore, 'tmp')).isDirectory()).toBe(true);
      expect(spawnMock).toHaveBeenCalledWith(
        'bwrap',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({ AGOR_OUTER_SANDBOX: '1' }),
          stdio: ['pipe', 'pipe', 'pipe', expect.any(Number)],
        })
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'linux')(
    'rejects a symlinked per-user tmp before an autonomous sandbox spawn',
    async () => {
      const installed = installMockExecutor('agor-executor-tmp-symlink-');
      const root = mkdtempSync(path.join(tmpdir(), 'agor-owner-tmp-symlink-'));
      const ownerHomeStore = path.join(root, 'owner');
      const outside = path.join(root, 'outside');
      mkdirSync(ownerHomeStore, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, path.join(ownerHomeStore, 'tmp'));

      try {
        const actualSandboxWrap =
          await vi.importActual<typeof import('./sandbox-wrap.js')>('./sandbox-wrap.js');
        sandboxWrapMock.mockImplementation(actualSandboxWrap.buildSandboxWrap);
        const onExit = vi.fn();
        const { configureExecutor, spawnExecutor } = await import('./spawn-executor');
        configureExecutor(
          { sandbox: { enabled: true, fail_if_unavailable: true, home_mode: 'per_user' } },
          {
            ...LOCAL_RESPONSE_OPTIONS,
            sandboxRuntimePaths: {
              homeDir: path.join(root, 'home'),
              dataHome: path.join(root, 'data'),
              protectedDataRoots: [path.join(root, 'data')],
              worktreesRoot: path.join(root, 'worktrees'),
              agenticToolsPath: path.join(root, 'agentic-tools'),
              agorConfigPath: path.join(root, 'config.yaml'),
            },
          }
        );

        spawnExecutor(
          {
            command: 'prompt',
            params: { cwd: path.join(root, 'branch'), sandboxHomeStore: ownerHomeStore },
          },
          { onExit }
        );

        expect(openDirectoryBindMock).toHaveBeenCalledWith(path.join(ownerHomeStore, 'tmp'));
        expect(sandboxWrapMock).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();
        expect(onExit).toHaveBeenCalledWith(126, { mode: 'local' });
      } finally {
        installed.restore();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === 'linux')(
    'rejects a file at per-user tmp before a request-mode sandbox spawn',
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'agor-owner-tmp-file-'));
      const ownerHomeStore = path.join(root, 'owner');
      mkdirSync(ownerHomeStore, { recursive: true });
      writeFileSync(path.join(ownerHomeStore, 'tmp'), 'not-a-directory');

      try {
        const actualSandboxWrap =
          await vi.importActual<typeof import('./sandbox-wrap.js')>('./sandbox-wrap.js');
        sandboxWrapMock.mockImplementation(actualSandboxWrap.buildSandboxWrap);
        const { configureExecutor, requestExecutor } = await import('./spawn-executor');
        configureExecutor(
          { sandbox: { enabled: true, fail_if_unavailable: true, home_mode: 'per_user' } },
          {
            ...LOCAL_RESPONSE_OPTIONS,
            sandboxRuntimePaths: {
              homeDir: path.join(root, 'home'),
              dataHome: path.join(root, 'data'),
              protectedDataRoots: [path.join(root, 'data')],
              worktreesRoot: path.join(root, 'worktrees'),
              agenticToolsPath: path.join(root, 'agentic-tools'),
              agorConfigPath: path.join(root, 'config.yaml'),
            },
          }
        );

        await expect(
          requestExecutor({
            command: 'branch.files.browse',
            params: { cwd: path.join(root, 'branch'), sandboxHomeStore: ownerHomeStore },
          })
        ).resolves.toMatchObject({
          success: false,
          error: {
            code: 'EXECUTOR_SPAWN_ERROR',
            message: expect.stringContaining('Executor sandbox setup failed'),
          },
        });
        expect(openDirectoryBindMock).toHaveBeenCalledWith(path.join(ownerHomeStore, 'tmp'));
        expect(sandboxWrapMock).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('maps a pinned credential source onto child fd 3 without serializing it', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    buildSandboxWrapMock.mockReturnValue({
      cmd: 'bwrap',
      args: ['--bind-fd', '3', '/branch-home/codex/auth.json', '--', 'executor'],
      extraEnv: {},
    });
    const { configureExecutor, spawnExecutor } = await import('./spawn-executor');
    configureExecutor(
      { sandbox: { enabled: true, fail_if_unavailable: true } },
      {
        ...LOCAL_RESPONSE_OPTIONS,
        sandboxRuntimePaths: {
          homeDir: '/home/agor',
          dataHome: '/home/agor/.agor',
          protectedDataRoots: ['/home/agor/.agor'],
          worktreesRoot: '/home/agor/.agor/worktrees',
          agenticToolsPath: '/opt/agor/agentic-tools',
          agorConfigPath: '/home/agor/.agor/config.yaml',
        },
      }
    );

    spawnExecutor(
      {
        command: 'prompt',
        params: {
          cwd: '/home/agor/.agor/worktrees/repo/feature',
          sandboxBranchSdkHome: '/branch-home',
        },
      },
      {
        localSandboxFileBinds: [{ sourceFd: 47, destination: '/branch-home/codex/auth.json' }],
      }
    );

    expect(buildSandboxWrapMock).toHaveBeenCalledWith(
      expect.objectContaining({
        branchSdkCredentialBinds: [{ fd: 3, destination: '/branch-home/codex/auth.json' }],
      })
    );
    expect(spawnMock).toHaveBeenCalledWith(
      'bwrap',
      expect.any(Array),
      expect.objectContaining({ stdio: ['pipe', 'inherit', 'inherit', 47] })
    );
    expect(proc.written).not.toContain('47');
    expect(proc.written).not.toContain('localSandboxFileBinds');
  });

  it('waits for asynchronous spawn readiness before sending the executor payload', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const { spawnExecutor } = await import('./spawn-executor');

    spawnExecutor({ command: 'prompt' }, { onSpawn: () => ready });

    expect(proc.written).toBe('');
    markReady();
    await vi.waitFor(() => expect(proc.written).not.toBe(''));
    expect(JSON.parse(proc.written)).toMatchObject({ command: 'prompt' });
  });

  it('contains the executor when asynchronous spawn readiness fails', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const onExit = vi.fn();
    const { spawnExecutor } = await import('./spawn-executor');

    spawnExecutor(
      { command: 'prompt' },
      { onSpawn: () => Promise.reject(new Error('identity not durable')), onExit }
    );

    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(127, { mode: 'local' }));
    expect(proc.written).toBe('');
    expect(proc.kill).toHaveBeenCalledOnce();
  });

  it('fails a local request when the executor exits before a final response', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { requestExecutor } = await import('./spawn-executor');
    const promise = requestExecutor({ command: 'branch.files.browse' });

    proc.emit('exit', 0);

    await expect(promise).resolves.toMatchObject({
      success: false,
      error: {
        code: 'EXECUTOR_RESULT_MISSING',
        message: 'Executor exited with code 0 before delivering a final response',
      },
    });
  });

  it('does not treat a templated launcher exit as the remote executor result', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { requestExecutor } = await import('./spawn-executor');
    const promise = requestExecutor(
      { command: 'branch.files.browse' },
      { executorCommandTemplate: 'launch {command}' }
    );
    proc.emit('exit', 0);

    let settled = false;
    void promise.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await deliverExecutorResponse(proc, { success: true, data: { files: [] } });
    await expect(promise).resolves.toEqual({ success: true, data: { files: [] } });
  });

  it('fails closed before launch when a templated request lacks a protocol declaration', async () => {
    const { configureExecutor, requestExecutor } = await import('./spawn-executor');
    configureExecutor(
      {
        executor_response: { origin_url: 'http://daemon-0.internal:3030' },
      },
      LOCAL_RESPONSE_OPTIONS
    );

    await expect(
      requestExecutor(
        { command: 'branch.files.browse' },
        { executorCommandTemplate: 'launch {command}' }
      )
    ).resolves.toMatchObject({
      success: false,
      error: { code: 'EXECUTOR_RESPONSE_UNSUPPORTED' },
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns immediately on final response without waiting for launcher exit', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { requestExecutor } = await import('./spawn-executor');

    const promise = requestExecutor({ command: 'branch.files.browse' }, {});
    await deliverExecutorResponse(proc, { success: true, data: { files: [] } });

    await expect(promise).resolves.toEqual({ success: true, data: { files: [] } });
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('treats sentinel-looking stdout as process logging only', async () => {
    const proc = createMockProcess();
    spawnMock.mockReturnValue(proc);
    const { requestExecutor } = await import('./spawn-executor');
    const promise = requestExecutor({ command: 'branch.files.browse' });

    // A skewed legacy executor may still print the retired result sentinel to
    // stdout. It is only process logging now — never parsed as a result — so a
    // run that delivers nothing over the response channel is a missing result.
    proc.stdout.emit('data', Buffer.from('AGOR_EXECUTOR_RESULT {"success":true}\n'));
    proc.emit('exit', 0);

    await expect(promise).resolves.toMatchObject({
      success: false,
      error: { code: 'EXECUTOR_RESULT_MISSING' },
    });
  });

  it('routes local callbacks to loopback and off-host callbacks to the configured origin', async () => {
    const { configureExecutor, requestExecutor } = await import('./spawn-executor');
    // Distinct loopback vs external origin so the two paths are distinguishable.
    configureExecutor(
      {
        executor_response: {
          origin_url: 'http://daemon-0.internal:3030',
          external_protocol: 'executor-response-v1',
        },
      },
      { localResponseOriginUrl: 'http://127.0.0.1:3030' }
    );

    const readCallbackUrl = (proc: ReturnType<typeof createMockProcess>): string => {
      const payload = JSON.parse(proc.written.trim().split('\n')[0]) as {
        executorResponse: { url: string };
      };
      return payload.executorResponse.url;
    };

    // Local subprocess → co-located, so it must call back over loopback.
    const localProc = createMockProcess();
    spawnMock.mockReturnValueOnce(localProc);
    const localPromise = requestExecutor({ command: 'branch.files.browse' });
    expect(readCallbackUrl(localProc)).toMatch(
      /^http:\/\/127\.0\.0\.1:3030\/internal\/executor-responses\//
    );
    await deliverExecutorResponse(localProc, { success: true, data: { files: [] } });
    await expect(localPromise).resolves.toEqual({ success: true, data: { files: [] } });

    // Off-host templated launcher → must call back over the configured origin.
    const remoteProc = createMockProcess();
    spawnMock.mockReturnValueOnce(remoteProc);
    const remotePromise = requestExecutor(
      { command: 'branch.files.browse' },
      { executorCommandTemplate: 'launch {command}' }
    );
    expect(readCallbackUrl(remoteProc)).toMatch(
      /^http:\/\/daemon-0\.internal:3030\/internal\/executor-responses\//
    );
    await deliverExecutorResponse(remoteProc, { success: true, data: { files: ['ok'] } });
    await expect(remotePromise).resolves.toEqual({ success: true, data: { files: ['ok'] } });
  });

  it.each([
    ['local', undefined],
    ['configured-template', 'launch {command}'],
  ])('keeps the timeout active while awaiting a %s response', async (_name, template) => {
    vi.useFakeTimers();
    try {
      const proc = createMockProcess();
      spawnMock.mockReturnValue(proc);
      const { requestExecutor } = await import('./spawn-executor');
      const promise = requestExecutor(
        { command: 'branch.files.browse' },
        {
          ...(template ? { executorCommandTemplate: template } : {}),
          timeoutMs: 25,
        }
      );

      if (!template) proc.stdout.emit('data', Buffer.from('ordinary process log'));
      await vi.advanceTimersByTimeAsync(25);

      await expect(promise).resolves.toMatchObject({
        success: false,
        error: { code: 'EXECUTOR_TIMEOUT' },
      });
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the configured default request timeout', async () => {
    vi.useFakeTimers();
    try {
      const proc = createMockProcess();
      spawnMock.mockReturnValue(proc);
      const { configureExecutor, requestExecutor } = await import('./spawn-executor');
      configureExecutor(
        { executor_response: { timeout_ms: { default: 1_000 } } },
        LOCAL_RESPONSE_OPTIONS
      );

      const promise = requestExecutor({ command: 'branch.files.list' });
      await vi.advanceTimersByTimeAsync(999);
      expect(proc.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(promise).resolves.toMatchObject({
        success: false,
        error: {
          code: 'EXECUTOR_TIMEOUT',
          message: 'Executor command timed out after 1000ms',
        },
      });
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a configured command timeout override a call-specific default', async () => {
    vi.useFakeTimers();
    try {
      const proc = createMockProcess();
      spawnMock.mockReturnValue(proc);
      const { configureExecutor, requestExecutor } = await import('./spawn-executor');
      configureExecutor(
        {
          executor_response: {
            timeout_ms: {
              default: 5_000,
              by_command: { 'branch.files.read': 1_000 },
            },
          },
        },
        LOCAL_RESPONSE_OPTIONS
      );

      const promise = requestExecutor({ command: 'branch.files.read' }, { timeoutMs: 10_000 });
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(promise).resolves.toMatchObject({
        success: false,
        error: {
          code: 'EXECUTOR_TIMEOUT',
          message: 'Executor command timed out after 1000ms',
        },
      });
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses every unscoped executor launch when tenant context is required', async () => {
    const { configureExecutor, spawnExecutor } = await import('./spawn-executor');
    configureExecutor(null, { ...LOCAL_RESPONSE_OPTIONS, requireTenantContext: true });

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
      [expect.any(String), '--stdin'],
      expect.objectContaining({
        env: expect.objectContaining({
          DAEMON_URL: expect.any(String),
          LOG_LEVEL: 'warn',
        }),
      })
    );
  });

  it('uses a secret-free default environment for local fixed-command executors', async () => {
    const installed = installMockExecutor('agor-executor-env-');
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousMasterSecret = process.env.AGOR_MASTER_SECRET;
    process.env.DATABASE_URL = 'postgres://daemon-secret';
    process.env.AGOR_MASTER_SECRET = 'deployment-secret';
    try {
      const { spawnExecutor } = await import('./spawn-executor');
      spawnExecutor({ command: 'branch.files.browse' });

      const localOptions = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
      expect(localOptions.env.PATH).toBe(process.env.PATH);
      expect(localOptions.env.DATABASE_URL).toBeUndefined();
      expect(localOptions.env.AGOR_MASTER_SECRET).toBeUndefined();
    } finally {
      installed.restore();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousMasterSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
      else process.env.AGOR_MASTER_SECRET = previousMasterSecret;
    }
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
      [expect.any(String), '--stdin'],
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

  it('rejects a missing generic cwd before spawning', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agor-executor-cwd-'));
    const executorPath = path.join(dir, 'agor-executor');
    const missingCwd = path.join(dir, 'missing');
    const previous = process.env.AGOR_EXECUTOR_PATH;
    writeFileSync(executorPath, '#!/usr/bin/env node\n');
    process.env.AGOR_EXECUTOR_PATH = executorPath;

    try {
      const { requestExecutor } = await import('./spawn-executor');
      const result = await requestExecutor(
        { command: 'test.inspect', params: {} },
        {
          cwd: missingCwd,
          delegatedHomeKey: 'alice',
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
      const { startOpenCodeOAuthExecutor } = await import(
        '../integrations/opencode/oauth-executor'
      );
      const handle = startOpenCodeOAuthExecutor(
        OAUTH_DATA_HOME,
        {
          ...OAUTH_REQUEST,
          method: 1,
          inputs: { account: 'synthetic-secret-input' },
        },
        { env: { PATH: '/usr/bin' } },
        onEvent
      );

      expect(spawnMock).toHaveBeenCalledWith(
        'node',
        [expect.any(String), '--interactive-command'],
        expect.objectContaining({ detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
      );
      await deliverExecutorEvents(proc, [
        {
          type: 'authorized',
          authorization: {
            url: 'http://127.0.0.1/authorize',
            method: 'auto',
            instructions: 'Synthetic code 1234',
          },
        },
      ]);
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
      expect(trackMock).toHaveBeenCalledWith(expect.objectContaining({ pid: 4242 }));
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
    const { configureExecutor } = await import('./spawn-executor');
    const { startOpenCodeOAuthExecutor } = await import('../integrations/opencode/oauth-executor');
    configureExecutor({ executor_command_template: 'remote {command}' }, LOCAL_RESPONSE_OPTIONS);

    const handle = startOpenCodeOAuthExecutor(OAUTH_DATA_HOME, OAUTH_REQUEST, {}, vi.fn());

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
      const { startOpenCodeOAuthExecutor } = await import(
        '../integrations/opencode/oauth-executor'
      );
      const handle = startOpenCodeOAuthExecutor(
        OAUTH_DATA_HOME,
        OAUTH_REQUEST,
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

  it('receives the final OAuth result privately and releases it after containment', async () => {
    const fixture = installMockExecutor('agor-oauth-final-frame-');
    const { proc } = fixture;

    try {
      const { startOpenCodeOAuthExecutor } = await import(
        '../integrations/opencode/oauth-executor'
      );
      const handle = startOpenCodeOAuthExecutor(
        OAUTH_DATA_HOME,
        OAUTH_REQUEST,
        { env: { PATH: '/usr/bin' } },
        vi.fn()
      );

      await deliverExecutorResponse(proc, {
        success: true,
        data: { runtime: 'available' },
      });
      let settled = false;
      void handle.result.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      proc.emit('exit', 0);
      proc.emit('close', 0);
      await expect(handle.result).resolves.toEqual({
        success: true,
        data: { runtime: 'available' },
      });
    } finally {
      fixture.restore();
    }
  });

  it('fails safely when OAuth exits without a response', async () => {
    const fixture = installMockExecutor('agor-oauth-missing-frame-');
    const { proc } = fixture;

    try {
      const { startOpenCodeOAuthExecutor } = await import(
        '../integrations/opencode/oauth-executor'
      );
      const handle = startOpenCodeOAuthExecutor(
        OAUTH_DATA_HOME,
        OAUTH_REQUEST,
        { env: { PATH: '/usr/bin' } },
        vi.fn()
      );
      proc.stderr.emit('data', Buffer.from('secret password /private/path'));
      proc.emit('exit', 1);
      proc.emit('close', 1);

      await expect(handle.result).resolves.toEqual({
        success: false,
        error: {
          code: 'EXECUTOR_RESULT_MISSING',
          message: 'OpenCode OAuth executor did not deliver a final response.',
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
      const { startOpenCodeOAuthExecutor } = await import(
        '../integrations/opencode/oauth-executor'
      );
      const handle = startOpenCodeOAuthExecutor(
        OAUTH_DATA_HOME,
        OAUTH_REQUEST,
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
      const { startOpenCodeOAuthExecutor } = await import(
        '../integrations/opencode/oauth-executor'
      );
      const handle = startOpenCodeOAuthExecutor(
        OAUTH_DATA_HOME,
        OAUTH_REQUEST,
        { env: { PATH: '/usr/bin' } },
        vi.fn()
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const submission = handle.submitCode('synthetic-secret-code');
      let deliverySettled = false;
      void submission.then(() => {
        deliverySettled = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
        setTimeout(() => callback(new Error('EPIPE synthetic-secret-code /private/final-path')), 0);
      },
    });
    const fixture = installMockExecutor('agor-oauth-code-final-', proc);

    try {
      const { startOpenCodeOAuthExecutor } = await import(
        '../integrations/opencode/oauth-executor'
      );
      const handle = startOpenCodeOAuthExecutor(
        OAUTH_DATA_HOME,
        OAUTH_REQUEST,
        { env: { PATH: '/usr/bin' } },
        vi.fn()
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
      const { startOpenCodeOAuthExecutor } = await import(
        '../integrations/opencode/oauth-executor'
      );
      const handle = startOpenCodeOAuthExecutor(
        '/private/path',
        OAUTH_REQUEST,
        { env: { PATH: '/usr/bin' } },
        vi.fn()
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
      const { startOpenCodeOAuthExecutor } = await import(
        '../integrations/opencode/oauth-executor'
      );
      const handle = startOpenCodeOAuthExecutor(
        OAUTH_DATA_HOME,
        OAUTH_REQUEST,
        { env: { PATH: '/usr/bin' } },
        vi.fn()
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const submission = handle.submitCode('synthetic-secret-code');
      expect(writes).toBe(2);
      const cancellation = handle.cancel();
      failCodeWrite();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
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

  it('releases a contained short command only after process-group absence', async () => {
    const fixture = installMockExecutor('agor-contained-executor-');
    const { proc } = fixture;
    try {
      const { startContainedExecutorCommand } = await import('./spawn-executor');
      const handle = startContainedExecutorCommand({ command: 'test.inspect', params: {} });

      expect(spawnMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ detached: true })
      );
      expect(trackMock).toHaveBeenCalledWith(expect.objectContaining({ pid: proc.pid }));

      await deliverExecutorResponse(proc, { success: true, data: { ok: true } });
      proc.emit('exit', 0);
      proc.emit('close', 0);

      await expect(handle.result).resolves.toEqual({ success: true, data: { ok: true } });
      expect(containMock).toHaveBeenCalledOnce();
      expect(untrackMock).toHaveBeenCalledOnce();
    } finally {
      fixture.restore();
    }
  });

  it('retains a verifier when short-command cleanup is not yet proven', async () => {
    containMock
      .mockResolvedValueOnce({ status: 'unverified', reason: 'still present' })
      .mockResolvedValueOnce({ status: 'verified_absent' });
    const fixture = installMockExecutor('agor-contained-unverified-');
    const { proc } = fixture;
    try {
      const { startContainedExecutorCommand } = await import('./spawn-executor');
      const handle = startContainedExecutorCommand({ command: 'test.inspect', params: {} });
      proc.emit('exit', 0);
      proc.emit('close', 0);

      await expect(handle.result).resolves.toMatchObject({
        success: false,
        error: { code: 'EXECUTOR_CLEANUP_UNVERIFIED' },
      });
      expect(untrackMock).not.toHaveBeenCalled();
      await expect(handle.verifyAbsence()).resolves.toBe(true);
      expect(containMock).toHaveBeenCalledTimes(2);
      expect(untrackMock).toHaveBeenCalledOnce();
    } finally {
      fixture.restore();
    }
  });

  it('rejects templated short commands that lack a remote cleanup contract', async () => {
    const { configureExecutor, startContainedExecutorCommand } = await import('./spawn-executor');
    configureExecutor({ executor_command_template: 'remote {command}' }, LOCAL_RESPONSE_OPTIONS);

    await expect(
      startContainedExecutorCommand({ command: 'test.inspect', params: {} }).result
    ).resolves.toMatchObject({
      success: false,
      error: { code: 'EXECUTOR_LOCAL_PROCESS_REQUIRED' },
    });
    expect(spawnMock).not.toHaveBeenCalled();
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

  it('substitutes a trusted {user_id} used for identity-scoped storage', async () => {
    const { substituteTemplateVariables } = await import('./spawn-executor');
    const userId = '019fda98-8206-7eb5-8e77-f95d6c8cd6c1';

    expect(substituteTemplateVariables('launch --user-id {user_id}', { user_id: userId })).toBe(
      `launch --user-id ${userId}`
    );
  });

  it('substitutes the actor branch filesystem projection for external launchers', async () => {
    const { substituteTemplateVariables } = await import('./spawn-executor');

    expect(
      substituteTemplateVariables('launch --branch-access {branch_fs_access}', {
        branch_fs_access: 'read',
      })
    ).toBe('launch --branch-access read');
  });

  it('refuses a path-shaped {user_id}', async () => {
    const { substituteTemplateVariables } = await import('./spawn-executor');
    expect(() =>
      substituteTemplateVariables('launch --user-id {user_id}', { user_id: '../other-user' })
    ).toThrow('{user_id} value is not a valid Agor user UUID');
  });

  it.each([
    { name: 'shell metacharacters', value: 'alice; rm -rf /' },
    { name: 'path traversal', value: '../other-tenant' },
    { name: 'command substitution', value: '$(whoami)' },
    { name: 'uppercase (outside the execution home-key charset)', value: 'Alice' },
  ])('refuses a malformed {unix_user} value: $name', async ({ value }) => {
    const { substituteTemplateVariables } = await import('./spawn-executor');

    // The template runs via `sh -c` and launchers use {unix_user} as a path
    // segment for per-user home mounts, so format validation (not escaping)
    // is the control — it must reject both shell and path-traversal shapes.
    expect(() =>
      substituteTemplateVariables('launch --user {unix_user}', { unix_user: value })
    ).toThrow('{unix_user} value is not a valid execution home key');
  });
});
