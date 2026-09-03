import { createHash, type Hash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type ExecutorPulseKind,
  type TaskID,
  WORKLOAD_OFFLINE_INSTALL_ARTIFACT_SHA256,
  WORKLOAD_OFFLINE_INSTALL_LOCKFILE_SHA256,
  WORKLOAD_OFFLINE_INSTALL_PACKAGE_MANAGER_VERSION,
  WORKLOAD_OFFLINE_INSTALL_PACKAGE_NAME,
  WORKLOAD_OFFLINE_INSTALL_PACKAGE_VERSION,
  WORKLOAD_OFFLINE_INSTALL_STEPS,
  type WorkloadOfflineInstallFailureStage,
  type WorkloadOfflineInstallStep,
  type WorkloadOfflineInstallStepObservation,
  type WorkloadOfflineInstallStepOutcome,
} from '@agor/core/types';
import {
  OFFLINE_INSTALL_COMMANDS,
  OFFLINE_INSTALL_FIXTURE,
  type OfflineInstallFixtureFile,
  offlineInstallFixtureBytes,
} from './offline-install-fixture.js';
import {
  createOfflineInstallEnvironment,
  DEFAULT_OFFLINE_INSTALL_PROCESS_DEPENDENCIES,
  type OfflineInstallCommandResult,
  type OfflineInstallProcessDependencies,
  runOfflineInstallCommand,
} from './offline-install-process.js';

export const OFFLINE_INSTALL_TEMP_PREFIX = 'agor-workload-offline-install-';

interface OfflineInstallRunnerDependencies extends OfflineInstallProcessDependencies {
  temporaryRoot: string;
  removeDirectory: typeof rm;
}

interface OfflineInstallRunInput {
  taskId: TaskID;
  repetitions: number;
  signal: AbortSignal;
  onPulse?: (kind: ExecutorPulseKind, detail?: string) => void;
}

export interface OfflineInstallRunResult {
  outcome: 'completed' | 'failed';
  failure_stage: WorkloadOfflineInstallFailureStage | null;
  completed_step_count: number;
  steps: [
    WorkloadOfflineInstallStepObservation,
    WorkloadOfflineInstallStepObservation,
    WorkloadOfflineInstallStepObservation,
    WorkloadOfflineInstallStepObservation,
  ];
  cleanup_confirmed: boolean;
}

type StepAggregate = {
  step: WorkloadOfflineInstallStep;
  attempted: number;
  completed: number;
  outcome: WorkloadOfflineInstallStepOutcome;
  exitCode: number | null;
  elapsedMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutHash: Hash;
  stderrHash: Hash;
};

const DEFAULT_DEPENDENCIES: OfflineInstallRunnerDependencies = {
  ...DEFAULT_OFFLINE_INSTALL_PROCESS_DEPENDENCIES,
  temporaryRoot: tmpdir(),
  removeDirectory: rm,
};

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot.length > 0 &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertFixtureIdentity(): void {
  const lockfile = OFFLINE_INSTALL_FIXTURE.files.find(({ name }) => name === 'pnpm-lock.yaml');
  const artifact = OFFLINE_INSTALL_FIXTURE.files.find(({ name }) => name.endsWith('.tgz'));
  if (
    !lockfile ||
    !artifact ||
    sha256(offlineInstallFixtureBytes(lockfile)) !== WORKLOAD_OFFLINE_INSTALL_LOCKFILE_SHA256 ||
    sha256(offlineInstallFixtureBytes(artifact)) !== WORKLOAD_OFFLINE_INSTALL_ARTIFACT_SHA256
  ) {
    throw new Error('WORKLOAD_OFFLINE_INSTALL_BUNDLE_INVALID');
  }
  const lockText = lockfile.content;
  if (
    !lockText.includes(`'${WORKLOAD_OFFLINE_INSTALL_PACKAGE_NAME}@file:`) ||
    !lockText.includes('tarball: file:') ||
    /(?:https?:|registry|git\+|github:)/i.test(lockText)
  ) {
    throw new Error('WORKLOAD_OFFLINE_INSTALL_LOCK_INVALID');
  }
}

function assertFixturePath(name: string): void {
  const segments = name.split('/');
  if (
    name.includes('\\') ||
    isAbsolute(name) ||
    segments.some((segment) => segment !== basename(segment) || segment === '.' || segment === '..')
  ) {
    throw new Error('WORKLOAD_OFFLINE_INSTALL_PATH_INVALID');
  }
}

async function ensurePrivateDirectory(root: string, target: string): Promise<string> {
  await mkdir(target, { recursive: false, mode: 0o700 });
  const stats: Stats = await lstat(target);
  const canonical = await realpath(target);
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    (stats.mode & 0o077) !== 0 ||
    !isContained(root, canonical)
  ) {
    throw new Error('WORKLOAD_OFFLINE_INSTALL_TEMP_UNSAFE');
  }
  return canonical;
}

async function writeFixtureFile(directory: string, file: OfflineInstallFixtureFile): Promise<void> {
  assertFixturePath(file.name);
  const target = resolve(directory, file.name);
  if (!isContained(directory, target)) throw new Error('WORKLOAD_OFFLINE_INSTALL_PATH_INVALID');
  const parent = dirname(target);
  if (parent !== directory) {
    const parentStats = await lstat(parent);
    const canonicalParent = await realpath(parent);
    if (
      parentStats.isSymbolicLink() ||
      !parentStats.isDirectory() ||
      !isContained(directory, canonicalParent)
    ) {
      throw new Error('WORKLOAD_OFFLINE_INSTALL_COPY_UNSAFE');
    }
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(offlineInstallFixtureBytes(file));
    const openedStats = await handle.stat();
    const pathStats = await lstat(target);
    if (
      !openedStats.isFile() ||
      pathStats.isSymbolicLink() ||
      !pathStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino
    ) {
      throw new Error('WORKLOAD_OFFLINE_INSTALL_COPY_UNSAFE');
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function materializeFixture(directory: string): Promise<void> {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new Error('WORKLOAD_OFFLINE_INSTALL_COPY_UNSAFE');
  }
  await ensurePrivateDirectory(directory, join(directory, 'vendor'));
  for (const file of OFFLINE_INSTALL_FIXTURE.files) await writeFixtureFile(directory, file);
}

async function assertFixtureIntegrity(directory: string): Promise<void> {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new Error('WORKLOAD_OFFLINE_INSTALL_COPY_UNSAFE');
  }
  for (const file of OFFLINE_INSTALL_FIXTURE.files) {
    const target = resolve(directory, file.name);
    if (!isContained(directory, target)) throw new Error('WORKLOAD_OFFLINE_INSTALL_PATH_INVALID');
    const pathStats = await lstat(target);
    if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
      throw new Error('WORKLOAD_OFFLINE_INSTALL_COPY_UNSAFE');
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
        throw new Error('WORKLOAD_OFFLINE_INSTALL_COPY_UNSAFE');
      }
      const bytes = await readFile(handle);
      if (!bytes.equals(offlineInstallFixtureBytes(file))) {
        throw new Error('WORKLOAD_OFFLINE_INSTALL_INTEGRITY');
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

async function assertInstalledDependency(directory: string): Promise<void> {
  for (const name of [
    'node_modules/@agor/offline-fixture-dependency/package.json',
    'node_modules/@agor/offline-fixture-dependency/index.mjs',
  ]) {
    const canonical = await realpath(resolve(directory, name));
    if (!isContained(directory, canonical)) {
      throw new Error('WORKLOAD_OFFLINE_INSTALL_PACKAGE_ESCAPE');
    }
  }
  const manifest = JSON.parse(
    await readFile(
      resolve(directory, 'node_modules/@agor/offline-fixture-dependency/package.json'),
      'utf8'
    )
  ) as unknown;
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    (manifest as Record<string, unknown>).name !== WORKLOAD_OFFLINE_INSTALL_PACKAGE_NAME ||
    (manifest as Record<string, unknown>).version !== WORKLOAD_OFFLINE_INSTALL_PACKAGE_VERSION ||
    (manifest as Record<string, unknown>).type !== 'module' ||
    (manifest as Record<string, unknown>).exports !== './index.mjs' ||
    (manifest as Record<string, unknown>).scripts !== undefined
  ) {
    throw new Error('WORKLOAD_OFFLINE_INSTALL_PACKAGE_INVALID');
  }
}

function createAggregate(step: WorkloadOfflineInstallStep): StepAggregate {
  return {
    step,
    attempted: 0,
    completed: 0,
    outcome: 'not-run',
    exitCode: null,
    elapsedMs: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutHash: createHash('sha256'),
    stderrHash: createHash('sha256'),
  };
}

function addObservation(
  aggregate: StepAggregate,
  attempt: number,
  result: OfflineInstallCommandResult,
  outcome: WorkloadOfflineInstallStepOutcome = result.outcome
): void {
  aggregate.attempted += 1;
  if (outcome === 'passed') aggregate.completed += 1;
  aggregate.outcome = outcome;
  aggregate.exitCode = result.exitCode;
  aggregate.elapsedMs += result.elapsedMs;
  aggregate.stdoutBytes += result.stdoutBytes;
  aggregate.stderrBytes += result.stderrBytes;
  aggregate.stdoutHash.update(`${attempt}\0${result.stdoutBytes}\0`);
  aggregate.stdoutHash.update(result.stdout);
  aggregate.stderrHash.update(`${attempt}\0${result.stderrBytes}\0`);
  aggregate.stderrHash.update(result.stderr);
}

function finishAggregate(aggregate: StepAggregate): WorkloadOfflineInstallStepObservation {
  return {
    step: aggregate.step,
    attempted: aggregate.attempted,
    completed: aggregate.completed,
    outcome: aggregate.outcome,
    exit_code: aggregate.exitCode,
    elapsed_ms: aggregate.elapsedMs,
    stdout_bytes: aggregate.stdoutBytes,
    stderr_bytes: aggregate.stderrBytes,
    stdout_sha256: aggregate.stdoutHash.digest('hex'),
    stderr_sha256: aggregate.stderrHash.digest('hex'),
  };
}

function failedCommandResult(result: OfflineInstallCommandResult): OfflineInstallCommandResult {
  return { ...result, outcome: 'failed', exitCode: null };
}

function emptyFailedCommandResult(): OfflineInstallCommandResult {
  return {
    outcome: 'failed',
    exitCode: null,
    elapsedMs: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  };
}

/** Build the strict offline runner. Overrides exist only for process-boundary tests. */
export function createOfflineInstallRunner(
  overrides: Partial<OfflineInstallRunnerDependencies> = {}
): (input: OfflineInstallRunInput) => Promise<OfflineInstallRunResult | undefined> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return async (input) => {
    if (input.signal.aborted) return undefined;
    const aggregates = WORKLOAD_OFFLINE_INSTALL_STEPS.map(createAggregate) as [
      StepAggregate,
      StepAggregate,
      StepAggregate,
      StepAggregate,
    ];
    let directory: string | undefined;
    let failureStage: WorkloadOfflineInstallFailureStage | null = null;
    let cleanupConfirmed = false;

    try {
      assertFixtureIdentity();
      const root = await realpath(dependencies.temporaryRoot);
      const taskKey = createHash('sha256').update(input.taskId).digest('hex').slice(0, 12);
      directory = await mkdtemp(join(root, `${OFFLINE_INSTALL_TEMP_PREFIX}${taskKey}-`));
      const directoryStats: Stats = await lstat(directory);
      const canonicalDirectory = await realpath(directory);
      if (
        directoryStats.isSymbolicLink() ||
        !directoryStats.isDirectory() ||
        (directoryStats.mode & 0o077) !== 0 ||
        !isContained(root, canonicalDirectory)
      ) {
        throw new Error('WORKLOAD_OFFLINE_INSTALL_TEMP_UNSAFE');
      }
      directory = canonicalDirectory;
      input.onPulse?.('progress', 'workload.offline-install.directory-created');
      if (input.signal.aborted) return undefined;

      for (const name of ['home', 'tmp', 'cache', 'config', 'npm-cache', 'store']) {
        await ensurePrivateDirectory(directory, join(directory, name));
      }
      const environment = createOfflineInstallEnvironment(directory);
      input.onPulse?.('progress', 'workload.offline-install.package-manager-version');
      const versionResult = await runOfflineInstallCommand(
        OFFLINE_INSTALL_COMMANDS.packageManagerVersion,
        directory,
        environment,
        input.signal,
        dependencies
      );
      if (!versionResult || input.signal.aborted) return undefined;
      const versionMatches =
        versionResult.outcome === 'passed' &&
        versionResult.stderrBytes === 0 &&
        [
          WORKLOAD_OFFLINE_INSTALL_PACKAGE_MANAGER_VERSION,
          `${WORKLOAD_OFFLINE_INSTALL_PACKAGE_MANAGER_VERSION}\n`,
        ].includes(versionResult.stdout.toString('utf8'));
      addObservation(
        aggregates[0],
        1,
        versionResult,
        versionMatches
          ? 'passed'
          : versionResult.outcome === 'passed'
            ? 'version-mismatch'
            : versionResult.outcome
      );
      if (!versionMatches) {
        failureStage = 'package-manager-version';
      } else
        for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
          if (input.signal.aborted) return undefined;
          let runDirectory: string;
          try {
            runDirectory = await ensurePrivateDirectory(
              directory,
              join(directory, `run-${repetition}`)
            );
            input.onPulse?.('progress', 'workload.offline-install.fixture-created');
            await materializeFixture(runDirectory);
            await assertFixtureIntegrity(runDirectory);
          } catch {
            addObservation(aggregates[1], repetition, emptyFailedCommandResult());
            failureStage = 'install';
            break;
          }

          input.onPulse?.('progress', 'workload.offline-install.install');
          let installResult = await runOfflineInstallCommand(
            OFFLINE_INSTALL_COMMANDS.install,
            runDirectory,
            environment,
            input.signal,
            dependencies
          );
          if (!installResult || input.signal.aborted) return undefined;
          if (installResult.outcome === 'passed') {
            try {
              await assertFixtureIntegrity(runDirectory);
              await assertInstalledDependency(runDirectory);
            } catch {
              installResult = failedCommandResult(installResult);
            }
          }
          addObservation(aggregates[1], repetition, installResult);
          if (installResult.outcome !== 'passed') {
            failureStage = 'install';
            break;
          }

          try {
            await assertFixtureIntegrity(runDirectory);
          } catch {
            addObservation(aggregates[2], repetition, emptyFailedCommandResult());
            failureStage = 'compile';
            break;
          }
          input.onPulse?.('progress', 'workload.offline-install.compile');
          const compileResult = await runOfflineInstallCommand(
            OFFLINE_INSTALL_COMMANDS.compile,
            runDirectory,
            environment,
            input.signal,
            dependencies
          );
          if (!compileResult || input.signal.aborted) return undefined;
          addObservation(aggregates[2], repetition, compileResult);
          if (compileResult.outcome !== 'passed') {
            failureStage = 'compile';
            break;
          }

          try {
            await assertFixtureIntegrity(runDirectory);
          } catch {
            addObservation(aggregates[3], repetition, emptyFailedCommandResult());
            failureStage = 'test';
            break;
          }
          input.onPulse?.('progress', 'workload.offline-install.test');
          const testResult = await runOfflineInstallCommand(
            OFFLINE_INSTALL_COMMANDS.test,
            runDirectory,
            environment,
            input.signal,
            dependencies
          );
          if (!testResult || input.signal.aborted) return undefined;
          addObservation(aggregates[3], repetition, testResult);
          if (testResult.outcome !== 'passed') {
            failureStage = 'test';
            break;
          }
        }
    } catch {
      if (!input.signal.aborted && failureStage === null) failureStage = 'prepare';
    } finally {
      if (directory) {
        try {
          await dependencies.removeDirectory(directory, { recursive: true, force: true });
          cleanupConfirmed = true;
        } catch {
          cleanupConfirmed = false;
          if (!input.signal.aborted && failureStage === null) failureStage = 'cleanup';
        }
      } else {
        cleanupConfirmed = true;
      }
    }

    if (input.signal.aborted) return undefined;
    return finish();

    function finish(): OfflineInstallRunResult {
      const steps = aggregates.map(finishAggregate) as OfflineInstallRunResult['steps'];
      return {
        outcome: failureStage === null && cleanupConfirmed ? 'completed' : 'failed',
        failure_stage: failureStage,
        completed_step_count: steps.reduce((total, step) => total + step.completed, 0),
        steps,
        cleanup_confirmed: cleanupConfirmed,
      };
    }
  };
}

export const runOfflineInstallFixture = createOfflineInstallRunner();
