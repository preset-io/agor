import { EventEmitter } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES } from '@agor/core/codex/credential-file';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('@agor/core/unix', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/unix')>();
  return {
    ...actual,
    probeBwrapPidNamespace: () => true,
    probeBwrapSecurityBaseline: () => true,
  };
});
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
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.pid = 4242;
  proc.stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

function hasMount(args: string[], flag: '--bind' | '--ro-bind', source: string, target: string) {
  return args.some(
    (arg, index) => arg === flag && args[index + 1] === source && args[index + 2] === target
  );
}

describe.runIf(process.platform === 'linux')(
  'request executor per-user sandbox integration',
  () => {
    let root: string;
    let executorPath: string;
    let homeDir: string;
    let dataHome: string;
    let branchPath: string;
    let ownerHomeStore: string;
    let previousExecutorPath: string | undefined;

    beforeEach(async () => {
      vi.resetModules();
      spawnMock.mockReset();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      root = mkdtempSync(path.join(tmpdir(), 'agor-request-sandbox-integration-'));
      executorPath = path.join(root, 'agor-executor');
      homeDir = path.join(root, 'passwd-home');
      dataHome = path.join(root, 'data');
      branchPath = path.join(dataHome, 'worktrees', 'tenant-a', 'repo', 'feature');
      ownerHomeStore = path.join(root, 'owner-home');
      mkdirSync(branchPath, { recursive: true });
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(path.join(dataHome, 'agentic-tools'), { recursive: true });
      writeFileSync(executorPath, '#!/usr/bin/env node\n');
      previousExecutorPath = process.env.AGOR_EXECUTOR_PATH;
      process.env.AGOR_EXECUTOR_PATH = executorPath;

      const { configureExecutor } = await import('./spawn-executor.js');
      configureExecutor(
        {
          sandbox: {
            enabled: true,
            fail_if_unavailable: true,
            home_mode: 'per_user',
          },
        },
        {
          localResponseOriginUrl: 'http://localhost:3030',
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
    });

    afterEach(() => {
      if (previousExecutorPath === undefined) delete process.env.AGOR_EXECUTOR_PATH;
      else process.env.AGOR_EXECUTOR_PATH = previousExecutorPath;
      rmSync(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('materializes a fresh authority and supplies viable mount sources before request spawn', async () => {
      const proc = createMockProcess();
      spawnMock.mockReturnValue(proc);
      const { requestExecutor } = await import('./spawn-executor.js');

      const resultPromise = requestExecutor({
        command: 'branch.artifact.publish',
        params: {
          cwd: branchPath,
          principalBranchAccess: 'write',
          sandboxHomeStore: ownerHomeStore,
        },
      });

      expect(spawnMock).toHaveBeenCalledOnce();
      const args = spawnMock.mock.calls[0]?.[1] as string[];
      const claudeDir = path.join(ownerHomeStore, '.claude');
      const authorityFilenames = ['.credentials.json', ...CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES];

      expect(lstatSync(ownerHomeStore).isDirectory()).toBe(true);
      expect(lstatSync(path.join(ownerHomeStore, 'tmp')).isDirectory()).toBe(true);
      expect(lstatSync(claudeDir).isDirectory()).toBe(true);
      expect(hasMount(args, '--bind', ownerHomeStore, homeDir)).toBe(true);
      expect(hasMount(args, '--bind', claudeDir, path.join(homeDir, '.claude'))).toBe(true);
      for (const filename of authorityFilenames) {
        const source = path.join(claudeDir, filename);
        const metadata = lstatSync(source);
        expect(metadata.isFile()).toBe(true);
        expect(metadata.isSymbolicLink()).toBe(false);
        expect(
          hasMount(args, '--ro-bind', '/dev/null', path.join(homeDir, '.claude', filename))
        ).toBe(true);
      }

      proc.emit('exit', 1);
      await expect(resultPromise).resolves.toMatchObject({
        success: false,
        error: { code: 'EXECUTOR_RESULT_MISSING' },
      });
    });

    it('rejects a symlinked Claude authority before mount construction or request spawn', async () => {
      mkdirSync(ownerHomeStore, { recursive: true });
      const attacker = path.join(root, 'attacker');
      mkdirSync(attacker, { recursive: true });
      symlinkSync(attacker, path.join(ownerHomeStore, '.claude'));
      const { requestExecutor } = await import('./spawn-executor.js');

      await expect(
        requestExecutor({
          command: 'branch.artifact.publish',
          params: {
            cwd: branchPath,
            principalBranchAccess: 'write',
            sandboxHomeStore: ownerHomeStore,
          },
        })
      ).resolves.toMatchObject({
        success: false,
        error: {
          code: 'EXECUTOR_SPAWN_ERROR',
          message: expect.stringMatching(/sandbox setup failed/i),
        },
      });

      expect(spawnMock).not.toHaveBeenCalled();
      expect(() => lstatSync(path.join(ownerHomeStore, 'tmp'))).toThrow();
      expect(() => lstatSync(path.join(attacker, '.credentials.json'))).toThrow();
    });
  }
);
