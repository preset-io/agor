import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFixtureCommandRunner,
  FIXED_COMMAND_ENV,
  FIXED_COMMAND_FIXTURE,
  FIXED_COMMAND_TEMP_PREFIX,
} from './fixture-command.js';

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agor-fixture-command-test-'));
  roots.push(root);
  return root;
}

function closedChild(code = 0, stdout = '', stderr = ''): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: 41_000 + Math.floor(Math.random() * 1_000),
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

describe('fixed fixture command runner', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('copies the immutable bundled fixture only into private temp and runs exact commands', async () => {
    const root = await temporaryRoot();
    const workspace = await temporaryRoot();
    await writeFile(join(workspace, 'sentinel'), 'unchanged');
    const before = await readdir(workspace);
    const calls: Array<{ executable: string; argv: readonly string[]; options: SpawnOptions }> = [];
    let activeChildren = 0;
    let maximumActiveChildren = 0;
    const spawnChild = vi.fn(
      (executable: string, argv: readonly string[], options: SpawnOptions) => {
        calls.push({ executable, argv, options });
        expect(options.cwd).toEqual(expect.stringContaining(FIXED_COMMAND_TEMP_PREFIX));
        expect(readFileSync(join(String(options.cwd), 'subject.mjs'), 'utf8')).toBe(
          FIXED_COMMAND_FIXTURE.files[0].content
        );
        expect(readFileSync(join(String(options.cwd), 'subject.test.mjs'), 'utf8')).toBe(
          FIXED_COMMAND_FIXTURE.files[1].content
        );
        activeChildren += 1;
        maximumActiveChildren = Math.max(maximumActiveChildren, activeChildren);
        const child = closedChild(0, `${argv[0]}\n`);
        child.once('close', () => {
          activeChildren -= 1;
        });
        return child;
      }
    );
    const runner = createFixtureCommandRunner({ temporaryRoot: root, spawnChild });

    const result = await runner({
      taskId: 'task-1' as never,
      repetitions: 2,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      outcome: 'completed',
      completed_command_count: 4,
      cleanup_confirmed: true,
      commands: [
        { command: 'node-check', attempted: 2, completed: 2, outcome: 'passed', exit_code: 0 },
        { command: 'node-test', attempted: 2, completed: 2, outcome: 'passed', exit_code: 0 },
      ],
    });
    expect(calls.map(({ executable, argv }) => [executable, argv])).toEqual([
      [process.execPath, ['--check', 'subject.mjs']],
      [process.execPath, ['--test', 'subject.test.mjs']],
      [process.execPath, ['--check', 'subject.mjs']],
      [process.execPath, ['--test', 'subject.test.mjs']],
    ]);
    for (const { options } of calls) {
      expect(options).toMatchObject({
        env: FIXED_COMMAND_ENV,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(options.detached).toBe(process.platform !== 'win32');
    }
    expect(Object.isFrozen(FIXED_COMMAND_FIXTURE)).toBe(true);
    expect(Object.isFrozen(FIXED_COMMAND_FIXTURE.files)).toBe(true);
    expect(FIXED_COMMAND_FIXTURE.files.every(Object.isFrozen)).toBe(true);
    expect(maximumActiveChildren).toBe(1);
    expect(await readdir(root)).toEqual([]);
    expect(await readdir(workspace)).toEqual(before);
    expect(await readFile(join(workspace, 'sentinel'), 'utf8')).toBe('unchanged');
  });

  it('ships a provider-free fixture with no network or package execution surface', () => {
    const source = FIXED_COMMAND_FIXTURE.files.map(({ content }) => content).join('\n');

    expect(source).not.toMatch(
      /node:(?:child_process|cluster|dgram|dns|http|https|net|tls)|\bfetch\b|@anthropic|@openai|\b(?:npm|npx|pnpm|yarn|bunx?)\b/
    );
  });

  it('returns a bounded controlled failure and cleans after a command exits nonzero', async () => {
    const root = await temporaryRoot();
    const spawnChild = vi
      .fn()
      .mockImplementationOnce(() => closedChild(0, 'checked'))
      .mockImplementationOnce(() => closedChild(7, '', 'test failed without disclosure'));
    const runner = createFixtureCommandRunner({ temporaryRoot: root, spawnChild });

    const result = await runner({
      taskId: 'task-1' as never,
      repetitions: 3,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      outcome: 'failed',
      completed_command_count: 1,
      cleanup_confirmed: true,
      commands: [
        { command: 'node-check', attempted: 1, completed: 1, outcome: 'passed' },
        { command: 'node-test', attempted: 1, completed: 0, outcome: 'failed', exit_code: 7 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('test failed without disclosure');
    expect(await readdir(root)).toEqual([]);
  });

  it('does not follow a raced fixture symlink and still removes the temp directory', async () => {
    const root = await temporaryRoot();
    const outside = join(root, 'outside');
    await writeFile(outside, 'outside-safe');
    const runner = createFixtureCommandRunner({ temporaryRoot: root });

    await expect(
      runner({
        taskId: 'task-1' as never,
        repetitions: 1,
        signal: new AbortController().signal,
        onPulse: (_kind, detail) => {
          if (detail !== 'workload.fixture-command.directory-created') return;
          const directory = readdirSync(root).find((entry) =>
            entry.startsWith(FIXED_COMMAND_TEMP_PREFIX)
          );
          expect(directory).toBeDefined();
          symlinkSync(outside, join(root, directory!, 'subject.mjs'));
        },
      })
    ).rejects.toThrow();

    expect(await readFile(outside, 'utf8')).toBe('outside-safe');
    expect((await readdir(root)).filter((entry) => entry !== 'outside')).toEqual([]);
  });

  it('kills the full child process group when output exceeds its cap', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot();
    const marker = join(root, 'grandchild-pid');
    // Use the real spawn behind a wrapper so the production executable/argv
    // remain observable in the separate fixed-command test above.
    const { spawn } = await import('node:child_process');
    const runner = createFixtureCommandRunner({
      temporaryRoot: root,
      commandTimeoutMs: 100,
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
      completed_command_count: 0,
      cleanup_confirmed: true,
      commands: [
        {
          command: 'node-check',
          attempted: 1,
          completed: 0,
          outcome: 'output-limit-exceeded',
          exit_code: null,
          stdout_bytes: 256,
        },
        { command: 'node-test', attempted: 0, completed: 0, outcome: 'not-run' },
      ],
    });
    const grandchildPid = Number(await readFile(marker, 'utf8'));
    await expectProcessGone(grandchildPid);
    expect(await readdir(root)).toEqual(['grandchild-pid']);
  });

  it('times out a silent command, terminates it, and removes its fixture', async () => {
    if (process.platform === 'win32') return;
    const root = await temporaryRoot();
    const { spawn } = await import('node:child_process');
    let childPid: number | undefined;
    const runner = createFixtureCommandRunner({
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
      completed_command_count: 0,
      cleanup_confirmed: true,
      commands: [
        { command: 'node-check', attempted: 1, completed: 0, outcome: 'timed-out' },
        { command: 'node-test', attempted: 0, completed: 0, outcome: 'not-run' },
      ],
    });
    expect(childPid).toBeDefined();
    await expectProcessGone(childPid!);
    expect(await readdir(root)).toEqual([]);
  });

  it('aborts after temp creation without starting a child and cleans in finally', async () => {
    const root = await temporaryRoot();
    const abortController = new AbortController();
    const spawnChild = vi.fn();
    const runner = createFixtureCommandRunner({ temporaryRoot: root, spawnChild });

    const result = await runner({
      taskId: '../not-a-path' as never,
      repetitions: 1,
      signal: abortController.signal,
      onPulse: (_kind, detail) => {
        if (detail === 'workload.fixture-command.directory-created') abortController.abort();
      },
    });

    expect(result).toBeUndefined();
    expect(spawnChild).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
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
