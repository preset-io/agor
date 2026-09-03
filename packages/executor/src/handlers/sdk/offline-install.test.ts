import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstatSync, readdirSync, symlinkSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  WORKLOAD_OFFLINE_INSTALL_ARTIFACT_SHA256,
  WORKLOAD_OFFLINE_INSTALL_LOCKFILE_SHA256,
  WORKLOAD_OFFLINE_INSTALL_PACKAGE_MANAGER_VERSION,
} from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfflineInstallRunner, OFFLINE_INSTALL_TEMP_PREFIX } from './offline-install.js';
import { OFFLINE_INSTALL_COMMANDS, OFFLINE_INSTALL_FIXTURE } from './offline-install-fixture.js';

const roots: string[] = [];
const originalSecret = process.env.OFFLINE_INSTALL_TEST_SECRET;

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agor-offline-install-test-'));
  roots.push(root);
  return root;
}

function closedChild(code = 0, stdout = '', stderr = ''): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: 42_000 + Math.floor(Math.random() * 1_000),
    exitCode: null as number | null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  }) as unknown as ChildProcess;
  queueMicrotask(() => {
    child.stdout?.end(stdout);
    child.stderr?.end(stderr);
    Reflect.set(child, 'exitCode', code);
    child.emit('close', code, null);
  });
  return child;
}

describe('offline install fixture runner', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalSecret === undefined) delete process.env.OFFLINE_INSTALL_TEST_SECRET;
    else process.env.OFFLINE_INSTALL_TEST_SECRET = originalSecret;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('performs repeated frozen offline installs and verifies the installed dependency', async () => {
    const root = await temporaryRoot();
    const workspace = join(root, 'workspace');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace));
    await writeFile(join(workspace, 'sentinel'), 'unchanged');
    const before = await readdir(workspace);
    const calls: Array<{ executable: string; argv: readonly string[]; options: SpawnOptions }> = [];
    const { spawn } = await import('node:child_process');
    let activeChildren = 0;
    let maximumActiveChildren = 0;
    process.env.OFFLINE_INSTALL_TEST_SECRET = 'must-not-cross-the-process-boundary';
    const runner = createOfflineInstallRunner({
      temporaryRoot: root,
      spawnChild: (executable, argv, options) => {
        calls.push({ executable, argv, options });
        activeChildren += 1;
        maximumActiveChildren = Math.max(maximumActiveChildren, activeChildren);
        const child = spawn(executable, [...argv], options);
        child.once('close', () => {
          activeChildren -= 1;
        });
        return child;
      },
    });

    const result = await runner({
      taskId: 'task-1' as never,
      repetitions: 2,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      outcome: 'completed',
      failure_stage: null,
      completed_step_count: 7,
      cleanup_confirmed: true,
      steps: [
        { step: 'package-manager-version', attempted: 1, completed: 1, outcome: 'passed' },
        { step: 'install', attempted: 2, completed: 2, outcome: 'passed' },
        { step: 'compile', attempted: 2, completed: 2, outcome: 'passed' },
        { step: 'test', attempted: 2, completed: 2, outcome: 'passed' },
      ],
    });
    expect(calls.map(({ executable, argv }) => [executable, argv])).toEqual([
      [OFFLINE_INSTALL_COMMANDS.packageManagerVersion.executable, ['--version']],
      [OFFLINE_INSTALL_COMMANDS.install.executable, OFFLINE_INSTALL_COMMANDS.install.argv],
      [process.execPath, OFFLINE_INSTALL_COMMANDS.compile.argv],
      [process.execPath, OFFLINE_INSTALL_COMMANDS.test.argv],
      [OFFLINE_INSTALL_COMMANDS.install.executable, OFFLINE_INSTALL_COMMANDS.install.argv],
      [process.execPath, OFFLINE_INSTALL_COMMANDS.compile.argv],
      [process.execPath, OFFLINE_INSTALL_COMMANDS.test.argv],
    ]);
    expect(OFFLINE_INSTALL_COMMANDS.install.argv).toEqual(
      expect.arrayContaining(['--offline', '--frozen-lockfile', '--ignore-scripts'])
    );
    for (const { options } of calls) {
      expect(options).toMatchObject({
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(String(options.cwd)).toContain(OFFLINE_INSTALL_TEMP_PREFIX);
      expect(options.env).not.toHaveProperty('OFFLINE_INSTALL_TEST_SECRET');
      expect(options.env).not.toHaveProperty('NPM_TOKEN');
      expect(options.env).not.toHaveProperty('NODE_AUTH_TOKEN');
      expect(options.env).toMatchObject({
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        COREPACK_ENABLE_NETWORK: '0',
        NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        NPM_CONFIG_OFFLINE: 'true',
      });
      expect(Object.keys(options.env ?? {}).sort()).toEqual(
        [
          ...(process.env.PATH || process.env.Path ? ['PATH'] : []),
          'CI',
          'COREPACK_ENABLE_DOWNLOAD_PROMPT',
          'COREPACK_ENABLE_NETWORK',
          'HOME',
          'LANG',
          'LC_ALL',
          'NO_UPDATE_NOTIFIER',
          'NPM_CONFIG_AUDIT',
          'NPM_CONFIG_CACHE',
          'NPM_CONFIG_FUND',
          'NPM_CONFIG_GLOBALCONFIG',
          'NPM_CONFIG_IGNORE_SCRIPTS',
          'NPM_CONFIG_OFFLINE',
          'NPM_CONFIG_UPDATE_NOTIFIER',
          'NPM_CONFIG_USERCONFIG',
          'TMPDIR',
          'TZ',
          'XDG_CACHE_HOME',
          'XDG_CONFIG_HOME',
        ].sort()
      );
    }
    expect(maximumActiveChildren).toBe(1);
    expect(await readdir(workspace)).toEqual(before);
    expect(await readFile(join(workspace, 'sentinel'), 'utf8')).toBe('unchanged');
    expect(await readdir(root)).toEqual(['workspace']);
  }, 15_000);

  it('pins one immutable local artifact and a registry-free local-only lockfile', () => {
    expect(Object.isFrozen(OFFLINE_INSTALL_FIXTURE)).toBe(true);
    expect(Object.isFrozen(OFFLINE_INSTALL_FIXTURE.files)).toBe(true);
    expect(OFFLINE_INSTALL_FIXTURE.files.every(Object.isFrozen)).toBe(true);
    const artifact = OFFLINE_INSTALL_FIXTURE.files.find(({ encoding }) => encoding === 'base64');
    const lockfile = OFFLINE_INSTALL_FIXTURE.files.find(({ name }) => name === 'pnpm-lock.yaml');
    expect(artifact).toBeDefined();
    expect(lockfile).toBeDefined();
    expect(
      createHash('sha256').update(Buffer.from(artifact!.content, 'base64')).digest('hex')
    ).toBe(WORKLOAD_OFFLINE_INSTALL_ARTIFACT_SHA256);
    expect(createHash('sha256').update(lockfile!.content).digest('hex')).toBe(
      WORKLOAD_OFFLINE_INSTALL_LOCKFILE_SHA256
    );
    expect(lockfile!.content).toContain('tarball: file:vendor/');
    expect(lockfile!.content).not.toMatch(/(?:https?:|registry|git\+|github:)/i);
    const auditedText = OFFLINE_INSTALL_FIXTURE.files
      .filter(({ encoding }) => encoding === 'utf8')
      .map(({ content }) => content)
      .join('\n');
    expect(auditedText).not.toMatch(
      /node:(?:child_process|cluster|dgram|dns|http|https|net|tls)|\bfetch\b|@anthropic|@openai|@google\/genai/
    );
  });

  it('returns a canonical install failure and cleans private storage', async () => {
    const root = await temporaryRoot();
    const environments: Array<Readonly<NodeJS.ProcessEnv> | undefined> = [];
    const spawnChild = vi
      .fn()
      .mockImplementationOnce((_executable, _argv, options) => {
        environments.push(options.env as Readonly<NodeJS.ProcessEnv> | undefined);
        return closedChild(0, `${WORKLOAD_OFFLINE_INSTALL_PACKAGE_MANAGER_VERSION}\n`);
      })
      .mockImplementationOnce((_executable, _argv, options) => {
        environments.push(options.env as Readonly<NodeJS.ProcessEnv> | undefined);
        return closedChild(7, '', 'registry-like raw failure');
      });
    const runner = createOfflineInstallRunner({ temporaryRoot: root, spawnChild });

    const result = await runner({
      taskId: 'task-1' as never,
      repetitions: 3,
      signal: new AbortController().signal,
    });

    expect(environments).toHaveLength(2);
    for (const environment of environments) {
      expect(environment).toMatchObject({
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        COREPACK_ENABLE_NETWORK: '0',
        NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        NPM_CONFIG_OFFLINE: 'true',
      });
      expect(Object.keys(environment ?? {}).sort()).toEqual(
        [
          ...(process.env.PATH || process.env.Path ? ['PATH'] : []),
          'CI',
          'COREPACK_ENABLE_DOWNLOAD_PROMPT',
          'COREPACK_ENABLE_NETWORK',
          'HOME',
          'LANG',
          'LC_ALL',
          'NO_UPDATE_NOTIFIER',
          'NPM_CONFIG_AUDIT',
          'NPM_CONFIG_CACHE',
          'NPM_CONFIG_FUND',
          'NPM_CONFIG_GLOBALCONFIG',
          'NPM_CONFIG_IGNORE_SCRIPTS',
          'NPM_CONFIG_OFFLINE',
          'NPM_CONFIG_UPDATE_NOTIFIER',
          'NPM_CONFIG_USERCONFIG',
          'TMPDIR',
          'TZ',
          'XDG_CACHE_HOME',
          'XDG_CONFIG_HOME',
        ].sort()
      );
    }

    expect(result).toMatchObject({
      outcome: 'failed',
      failure_stage: 'install',
      completed_step_count: 1,
      cleanup_confirmed: true,
      steps: [
        { step: 'package-manager-version', completed: 1, outcome: 'passed' },
        { step: 'install', attempted: 1, completed: 0, outcome: 'failed', exit_code: 7 },
        { step: 'compile', attempted: 0, outcome: 'not-run' },
        { step: 'test', attempted: 0, outcome: 'not-run' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('registry-like raw failure');
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ['compile', 2],
    ['test', 3],
  ] as const)(
    'cleans after a %s verification failure',
    async (failureStage, failureCall) => {
      const root = await temporaryRoot();
      const { spawn } = await import('node:child_process');
      let call = 0;
      const runner = createOfflineInstallRunner({
        temporaryRoot: root,
        spawnChild: (executable, argv, options) => {
          const current = call++;
          return current === failureCall
            ? closedChild(9, '', 'raw verification output')
            : spawn(executable, [...argv], options);
        },
      });

      const result = await runner({
        taskId: 'task-1' as never,
        repetitions: 1,
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        outcome: 'failed',
        failure_stage: failureStage,
        cleanup_confirmed: true,
      });
      expect(result?.steps.find(({ step }) => step === failureStage)).toMatchObject({
        attempted: 1,
        completed: 0,
        outcome: 'failed',
        exit_code: 9,
      });
      expect(JSON.stringify(result)).not.toContain('raw verification output');
      expect(await readdir(root)).toEqual([]);
    },
    15_000
  );

  it('fails closed on a package-manager version mismatch', async () => {
    const root = await temporaryRoot();
    const spawnChild = vi.fn(() => closedChild(0, '99.0.0\n'));
    const runner = createOfflineInstallRunner({ temporaryRoot: root, spawnChild });

    const result = await runner({
      taskId: 'task-1' as never,
      repetitions: 1,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      failure_stage: 'package-manager-version',
      completed_step_count: 0,
      cleanup_confirmed: true,
      steps: [
        { attempted: 1, completed: 0, outcome: 'version-mismatch', exit_code: 0 },
        { outcome: 'not-run' },
        { outcome: 'not-run' },
        { outcome: 'not-run' },
      ],
    });
    expect(spawnChild).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual([]);
  });

  it('does not follow a raced fixture symlink or escape through a task identifier', async () => {
    const root = await temporaryRoot();
    const outside = join(root, 'outside');
    await writeFile(outside, 'outside-safe');
    const runner = createOfflineInstallRunner({ temporaryRoot: root });

    const result = await runner({
      taskId: '../../../../outside' as never,
      repetitions: 1,
      signal: new AbortController().signal,
      onPulse: (_kind, detail) => {
        if (detail !== 'workload.offline-install.fixture-created') return;
        const directory = readdirSync(root).find((entry) =>
          entry.startsWith(OFFLINE_INSTALL_TEMP_PREFIX)
        );
        expect(directory).toBeDefined();
        symlinkSync(outside, join(root, directory!, 'run-1', 'package.json'));
      },
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      failure_stage: 'install',
      completed_step_count: 1,
      cleanup_confirmed: true,
    });
    expect(await readFile(outside, 'utf8')).toBe('outside-safe');
    expect((await readdir(root)).filter((entry) => entry !== 'outside')).toEqual([]);
  });

  it('kills the full child process group on output overflow and removes its temp tree', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot();
    const marker = join(root, 'grandchild-pid');
    const { spawn } = await import('node:child_process');
    const runner = createOfflineInstallRunner({
      temporaryRoot: root,
      commandTimeoutMs: 1_000,
      outputMaxBytes: 256,
      spawnChild: (_executable, _argv, options) =>
        spawn(
          process.execPath,
          [
            '-e',
            [
              "const { spawn } = require('node:child_process');",
              "const { writeFileSync } = require('node:fs');",
              "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
              `writeFileSync(${JSON.stringify(marker)}, String(child.pid));`,
              "process.stdout.write('x'.repeat(65536));",
              'setInterval(() => {}, 1000);',
            ].join('\n'),
          ],
          options
        ),
    });

    const result = await runner({
      taskId: 'task-1' as never,
      repetitions: 1,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      failure_stage: 'package-manager-version',
      cleanup_confirmed: true,
      steps: [
        { outcome: 'output-limit-exceeded', stdout_bytes: 256, exit_code: null },
        { outcome: 'not-run' },
        { outcome: 'not-run' },
        { outcome: 'not-run' },
      ],
    });
    const grandchildPid = Number(await readFile(marker, 'utf8'));
    await expectProcessGone(grandchildPid);
    expect(await readdir(root)).toEqual(['grandchild-pid']);
  });

  it('times out a silent process group and cleans its temp tree', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot();
    const { spawn } = await import('node:child_process');
    let childPid: number | undefined;
    const runner = createOfflineInstallRunner({
      temporaryRoot: root,
      commandTimeoutMs: 50,
      spawnChild: (_executable, _argv, options) => {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
        childPid = child.pid;
        return child;
      },
    });

    const result = await runner({
      taskId: 'task-1' as never,
      repetitions: 1,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      failure_stage: 'package-manager-version',
      cleanup_confirmed: true,
    });
    expect(result?.steps[0]).toMatchObject({ outcome: 'timed-out' });
    expect(childPid).toBeDefined();
    await expectProcessGone(childPid!);
    expect(await readdir(root)).toEqual([]);
  });

  it('aborts after private temp creation, starts no child, and cleans in finally', async () => {
    const root = await temporaryRoot();
    const abortController = new AbortController();
    const spawnChild = vi.fn();
    const runner = createOfflineInstallRunner({ temporaryRoot: root, spawnChild });

    const result = await runner({
      taskId: 'task-1' as never,
      repetitions: 1,
      signal: abortController.signal,
      onPulse: (_kind, detail) => {
        if (detail !== 'workload.offline-install.directory-created') return;
        const directory = readdirSync(root).find((entry) =>
          entry.startsWith(OFFLINE_INSTALL_TEMP_PREFIX)
        );
        expect(directory).toBeDefined();
        expect(lstatSync(join(root, directory!)).mode & 0o077).toBe(0);
        abortController.abort();
      },
    });

    expect(result).toBeUndefined();
    expect(spawnChild).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('reports cleanup failure without falsely confirming cleanup', async () => {
    const root = await temporaryRoot();
    const { spawn } = await import('node:child_process');
    const runner = createOfflineInstallRunner({
      temporaryRoot: root,
      spawnChild: (executable, argv, options) => spawn(executable, [...argv], options),
      removeDirectory: vi.fn().mockRejectedValue(new Error('cleanup denied')),
    });

    const result = await runner({
      taskId: 'task-1' as never,
      repetitions: 1,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      failure_stage: 'cleanup',
      completed_step_count: 4,
      cleanup_confirmed: false,
    });
  }, 15_000);
});

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`process ${pid} remained alive`);
}
