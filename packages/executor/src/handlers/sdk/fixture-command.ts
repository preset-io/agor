import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type ExecutorPulseKind,
  type TaskID,
  WORKLOAD_FIXTURE_COMMAND_ID,
  WORKLOAD_FIXTURE_COMMAND_OUTPUT_MAX_BYTES,
  type WorkloadFixtureCommand,
  type WorkloadFixtureCommandObservation,
  type WorkloadFixtureCommandOutcome,
} from '@agor/core/types';

export const FIXED_COMMAND_TIMEOUT_MS = 10_000;
export const FIXED_COMMAND_TEMP_PREFIX = 'agor-workload-fixture-';
export const FIXED_COMMAND_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  LANG: 'C',
  LC_ALL: 'C',
  NODE_DISABLE_COLORS: '1',
  TZ: 'UTC',
});

export const FIXED_COMMAND_FIXTURE = Object.freeze({
  id: WORKLOAD_FIXTURE_COMMAND_ID,
  files: Object.freeze([
    Object.freeze({
      name: 'subject.mjs',
      content: [
        'export function sum(values) {',
        '  return values.reduce((total, value) => total + value, 0);',
        '}',
        '',
      ].join('\n'),
    }),
    Object.freeze({
      name: 'subject.test.mjs',
      content: [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        "import { sum } from './subject.mjs';",
        '',
        "test('sums the fixed sequence', () => {",
        '  assert.equal(sum([3, 5, 8, 13, 21, 34]), 84);',
        '});',
        '',
      ].join('\n'),
    }),
  ]),
});

const FIXED_COMMANDS = Object.freeze([
  Object.freeze({ command: 'node-check' as const, argv: ['--check', 'subject.mjs'] as const }),
  Object.freeze({ command: 'node-test' as const, argv: ['--test', 'subject.test.mjs'] as const }),
]);

type SpawnChild = (
  executable: string,
  argv: readonly string[],
  options: SpawnOptions
) => ChildProcess;

interface FixtureCommandRunnerDependencies {
  /** Test-only injection; request data never reaches these dependencies. */
  spawnChild: SpawnChild;
  temporaryRoot: string;
  commandTimeoutMs: number;
  outputMaxBytes: number;
}

interface FixtureCommandRunInput {
  taskId: TaskID;
  repetitions: number;
  signal: AbortSignal;
  onPulse?: (kind: ExecutorPulseKind, detail?: string) => void;
}

export interface FixtureCommandRunResult {
  outcome: 'completed' | 'failed';
  completed_command_count: number;
  commands: [WorkloadFixtureCommandObservation, WorkloadFixtureCommandObservation];
  cleanup_confirmed: true;
}

type CommandRunResult = {
  outcome: Exclude<WorkloadFixtureCommandOutcome, 'not-run'>;
  exitCode: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  stdout: Buffer;
  stderr: Buffer;
};

type CommandAggregate = {
  command: WorkloadFixtureCommand;
  attempted: number;
  completed: number;
  outcome: WorkloadFixtureCommandOutcome;
  exitCode: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutHash: Hash;
  stderrHash: Hash;
};

const DEFAULT_DEPENDENCIES: FixtureCommandRunnerDependencies = {
  spawnChild: (executable, argv, options) => spawn(executable, [...argv], options),
  temporaryRoot: tmpdir(),
  commandTimeoutMs: FIXED_COMMAND_TIMEOUT_MS,
  outputMaxBytes: WORKLOAD_FIXTURE_COMMAND_OUTPUT_MAX_BYTES,
};

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot.length > 0 &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function assertFixtureName(name: string): void {
  if (
    name !== basename(name) ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw new Error('WORKLOAD_FIXTURE_PATH_INVALID');
  }
}

async function materializeFixture(directory: string): Promise<void> {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new Error('WORKLOAD_FIXTURE_COPY_UNSAFE');
  }
  for (const file of FIXED_COMMAND_FIXTURE.files) {
    assertFixtureName(file.name);
    const target = resolve(directory, file.name);
    if (!isContained(directory, target)) throw new Error('WORKLOAD_FIXTURE_PATH_INVALID');
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      await handle.writeFile(file.content, 'utf8');
      const openedStats = await handle.stat();
      if (!openedStats.isFile()) throw new Error('WORKLOAD_FIXTURE_COPY_UNSAFE');
      const pathStats = await lstat(target);
      if (
        pathStats.isSymbolicLink() ||
        !pathStats.isFile() ||
        pathStats.dev !== openedStats.dev ||
        pathStats.ino !== openedStats.ino
      ) {
        throw new Error('WORKLOAD_FIXTURE_COPY_UNSAFE');
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

async function assertFixtureIntegrity(directory: string): Promise<void> {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new Error('WORKLOAD_FIXTURE_COPY_UNSAFE');
  }
  for (const file of FIXED_COMMAND_FIXTURE.files) {
    const target = resolve(directory, file.name);
    if (!isContained(directory, target)) throw new Error('WORKLOAD_FIXTURE_PATH_INVALID');
    const pathStats = await lstat(target);
    if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
      throw new Error('WORKLOAD_FIXTURE_COPY_UNSAFE');
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const openedStats = await handle.stat();
      if (
        !openedStats.isFile() ||
        openedStats.dev !== pathStats.dev ||
        openedStats.ino !== pathStats.ino
      ) {
        throw new Error('WORKLOAD_FIXTURE_COPY_UNSAFE');
      }
      const bytes = await readFile(handle);
      if (!bytes.equals(Buffer.from(file.content, 'utf8'))) {
        throw new Error('WORKLOAD_FIXTURE_INTEGRITY');
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

function killChildProcessGroup(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, 'SIGKILL');
      return;
    }
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // The close/error event remains the settlement source.
  }
}

async function runCommand(
  command: (typeof FIXED_COMMANDS)[number],
  directory: string,
  signal: AbortSignal,
  dependencies: FixtureCommandRunnerDependencies
): Promise<CommandRunResult | undefined> {
  if (signal.aborted) return undefined;
  let child: ChildProcess;
  try {
    child = dependencies.spawnChild(process.execPath, command.argv, {
      cwd: directory,
      env: FIXED_COMMAND_ENV,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return {
      outcome: 'spawn-failed',
      exitCode: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    };
  }

  return new Promise<CommandRunResult>((resolvePromise) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let capturedBytes = 0;
    let stopReason: Extract<
      WorkloadFixtureCommandOutcome,
      'timed-out' | 'output-limit-exceeded'
    > | null = null;
    let spawnFailed = false;
    let settled = false;

    const stop = (reason: NonNullable<typeof stopReason>) => {
      if (stopReason) return;
      stopReason = reason;
      killChildProcessGroup(child);
    };
    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if (stopReason) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = dependencies.outputMaxBytes - capturedBytes;
      if (remaining > 0) {
        const retained = Buffer.from(bytes.subarray(0, remaining));
        if (stream === 'stdout') {
          stdoutChunks.push(retained);
          stdoutBytes += retained.byteLength;
        } else {
          stderrChunks.push(retained);
          stderrBytes += retained.byteLength;
        }
        capturedBytes += retained.byteLength;
      }
      if (bytes.byteLength > remaining) stop('output-limit-exceeded');
    };
    const finish = (code: number | null, signalCode: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      const exitCode = Number.isInteger(code) && code! >= 0 && code! <= 255 ? code : null;
      const outcome = stopReason
        ? stopReason
        : spawnFailed
          ? 'spawn-failed'
          : exitCode === 0 && signalCode === null
            ? 'passed'
            : 'failed';
      resolvePromise({
        outcome,
        exitCode: outcome === 'passed' || outcome === 'failed' ? exitCode : null,
        stdoutBytes,
        stderrBytes,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    };
    const onAbort = () => {
      killChildProcessGroup(child);
    };
    const timeout = setTimeout(() => stop('timed-out'), dependencies.commandTimeoutMs);
    timeout.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdout?.on('data', (chunk) => capture('stdout', chunk));
    child.stderr?.on('data', (chunk) => capture('stderr', chunk));
    child.once('error', () => {
      spawnFailed = true;
    });
    child.once('close', finish);
  }).then((result) => (signal.aborted ? undefined : result));
}

function createAggregate(command: WorkloadFixtureCommand): CommandAggregate {
  return {
    command,
    attempted: 0,
    completed: 0,
    outcome: 'not-run',
    exitCode: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutHash: createHash('sha256'),
    stderrHash: createHash('sha256'),
  };
}

function addObservation(
  aggregate: CommandAggregate,
  repetition: number,
  result: CommandRunResult
): void {
  aggregate.attempted += 1;
  if (result.outcome === 'passed') aggregate.completed += 1;
  aggregate.outcome = result.outcome;
  aggregate.exitCode = result.exitCode;
  aggregate.stdoutBytes += result.stdoutBytes;
  aggregate.stderrBytes += result.stderrBytes;
  aggregate.stdoutHash.update(`${repetition}\0${result.stdoutBytes}\0`);
  aggregate.stdoutHash.update(result.stdout);
  aggregate.stderrHash.update(`${repetition}\0${result.stderrBytes}\0`);
  aggregate.stderrHash.update(result.stderr);
}

function finishAggregate(aggregate: CommandAggregate): WorkloadFixtureCommandObservation {
  return {
    command: aggregate.command,
    attempted: aggregate.attempted,
    completed: aggregate.completed,
    outcome: aggregate.outcome,
    exit_code: aggregate.exitCode,
    stdout_bytes: aggregate.stdoutBytes,
    stderr_bytes: aggregate.stderrBytes,
    stdout_sha256: aggregate.stdoutHash.digest('hex'),
    stderr_sha256: aggregate.stderrHash.digest('hex'),
  };
}

/**
 * Build the internal runner. Overrides exist only for deterministic process
 * supervision tests; the workload request never selects them.
 */
export function createFixtureCommandRunner(
  overrides: Partial<FixtureCommandRunnerDependencies> = {}
): (input: FixtureCommandRunInput) => Promise<FixtureCommandRunResult | undefined> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return async (input) => {
    if (input.signal.aborted) return undefined;
    const root = await realpath(dependencies.temporaryRoot);
    const taskKey = createHash('sha256').update(input.taskId).digest('hex').slice(0, 12);
    let directory: string | undefined;
    let executionOutcome: 'completed' | 'failed' = 'completed';
    const aggregates = FIXED_COMMANDS.map(({ command }) => createAggregate(command)) as [
      CommandAggregate,
      CommandAggregate,
    ];

    try {
      directory = await mkdtemp(join(root, `${FIXED_COMMAND_TEMP_PREFIX}${taskKey}-`));
      const directoryStats: Stats = await lstat(directory);
      const canonicalDirectory = await realpath(directory);
      if (
        directoryStats.isSymbolicLink() ||
        !directoryStats.isDirectory() ||
        !isContained(root, canonicalDirectory)
      ) {
        throw new Error('WORKLOAD_FIXTURE_TEMP_UNSAFE');
      }
      directory = canonicalDirectory;
      input.onPulse?.('progress', 'workload.fixture-command.directory-created');
      if (input.signal.aborted) return undefined;
      await materializeFixture(directory);

      outer: for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
        for (let commandIndex = 0; commandIndex < FIXED_COMMANDS.length; commandIndex += 1) {
          if (input.signal.aborted) return undefined;
          await assertFixtureIntegrity(directory);
          const command = FIXED_COMMANDS[commandIndex]!;
          input.onPulse?.('progress', `workload.fixture-command.${command.command}`);
          const result = await runCommand(command, directory, input.signal, dependencies);
          if (!result || input.signal.aborted) return undefined;
          addObservation(aggregates[commandIndex]!, repetition, result);
          if (result.outcome !== 'passed') {
            executionOutcome = 'failed';
            break outer;
          }
        }
      }
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }

    if (input.signal.aborted) return undefined;
    const commands = aggregates.map(finishAggregate) as [
      WorkloadFixtureCommandObservation,
      WorkloadFixtureCommandObservation,
    ];
    return {
      outcome: executionOutcome,
      completed_command_count: commands[0].completed + commands[1].completed,
      commands,
      cleanup_confirmed: true,
    };
  };
}

export const runFixedCommandFixture = createFixtureCommandRunner();
