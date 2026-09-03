import { z } from 'zod';
import type { TaskID } from './id';

/** The only profiles understood by the provider-free workload executor. */
export const WORKLOAD_PROFILES = [
  'wait',
  'controlled-failure',
  'cpu',
  'temporary-io',
  'compile-test',
  'workspace-inspection',
  'fixture-command',
] as const;

export type WorkloadProfile = (typeof WORKLOAD_PROFILES)[number];

export const WORKLOAD_REQUEST_MAX_BYTES = 2 * 1024;
export const WORKLOAD_RESULT_MAX_BYTES = 4 * 1024;
export const WORKLOAD_MIN_DURATION_MS = 100;
export const WORKLOAD_MAX_DURATION_MS = 120_000;
export const WORKLOAD_CPU_MIN_DURATION_MS = 10;
export const WORKLOAD_TEMP_IO_MAX_BYTES = 64 * 1024;
export const WORKLOAD_COMPILE_MAX_REPETITIONS = 1_000;
export const WORKLOAD_COMPILE_MAX_TOTAL_TIME_MS = 120_000;
export const WORKLOAD_FIXTURE_COMMAND_MAX_REPETITIONS = 10;
export const WORKLOAD_FIXTURE_COMMAND_OUTPUT_MAX_BYTES = 16 * 1024;
export const WORKLOAD_FIXTURE_COMMAND_ID = 'node-compile-test-v1';
export const WORKLOAD_FIXTURE_COMMAND_FAILURE_CODE = 'WORKLOAD_FIXTURE_COMMAND_FAILED';
export const WORKLOAD_SEED_MAX = 0xffff_ffff;
export const WORKLOAD_CONTROLLED_FAILURE_CODE = 'WORKLOAD_CONTROLLED_FAILURE';
export const WORKLOAD_LOCKFILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const;

export type WorkloadLockfile = (typeof WORKLOAD_LOCKFILES)[number];

export type WorkloadToolVersionObservation =
  | { state: 'available'; version: string }
  | { state: 'unavailable' | 'failed' | 'timed-out' | 'invalid-output' };

export type WorkloadFileObservation =
  | { state: 'present'; sha256: string }
  | { state: 'absent' | 'unsafe-symlink' | 'not-regular' | 'too-large' | 'unreadable' };

export type WorkloadPackageManagerObservation =
  | { state: 'valid'; name: 'npm' | 'pnpm' | 'yarn' | 'bun'; version: string }
  | { state: 'absent' | 'invalid' | 'unavailable' };

export interface WorkloadWorkspaceInspection {
  node: WorkloadToolVersionObservation;
  npm: WorkloadToolVersionObservation;
  pnpm: WorkloadToolVersionObservation;
  packageJson: WorkloadFileObservation;
  packageManager: WorkloadPackageManagerObservation;
  lockfiles: Array<{ name: WorkloadLockfile; file: WorkloadFileObservation }>;
  repositoryMarkerPresent: boolean;
}

export const WORKLOAD_FIXTURE_COMMANDS = ['node-check', 'node-test'] as const;
export type WorkloadFixtureCommand = (typeof WORKLOAD_FIXTURE_COMMANDS)[number];
export type WorkloadFixtureCommandOutcome =
  | 'not-run'
  | 'passed'
  | 'failed'
  | 'timed-out'
  | 'output-limit-exceeded'
  | 'spawn-failed';

export interface WorkloadFixtureCommandObservation {
  command: WorkloadFixtureCommand;
  attempted: number;
  completed: number;
  outcome: WorkloadFixtureCommandOutcome;
  exit_code: number | null;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_sha256: string;
  stderr_sha256: string;
}

const WORKLOAD_REQUEST_BASE = { schemaVersion: z.literal(1) };
const WORKLOAD_EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const WaitRequestSchema = z
  .object({
    ...WORKLOAD_REQUEST_BASE,
    profile: z.literal('wait'),
    durationMs: z.number().int().min(WORKLOAD_MIN_DURATION_MS).max(WORKLOAD_MAX_DURATION_MS),
  })
  .strict();

const ControlledFailureRequestSchema = z
  .object({
    ...WORKLOAD_REQUEST_BASE,
    profile: z.literal('controlled-failure'),
    delayMs: z.number().int().min(0).max(WORKLOAD_MAX_DURATION_MS).optional().default(0),
  })
  .strict();

const CpuRequestSchema = z
  .object({
    ...WORKLOAD_REQUEST_BASE,
    profile: z.literal('cpu'),
    durationMs: z.number().int().min(WORKLOAD_CPU_MIN_DURATION_MS).max(WORKLOAD_MAX_DURATION_MS),
    seed: z.number().int().min(0).max(WORKLOAD_SEED_MAX),
  })
  .strict();

const TemporaryIoRequestSchema = z
  .object({
    ...WORKLOAD_REQUEST_BASE,
    profile: z.literal('temporary-io'),
    bytes: z.number().int().min(1).max(WORKLOAD_TEMP_IO_MAX_BYTES),
    seed: z.number().int().min(0).max(WORKLOAD_SEED_MAX),
  })
  .strict();

const CompileTestRequestSchema = z
  .object({
    ...WORKLOAD_REQUEST_BASE,
    profile: z.literal('compile-test'),
    repetitions: z.number().int().min(1).max(WORKLOAD_COMPILE_MAX_REPETITIONS),
    totalTimeMs: z.number().int().min(10).max(WORKLOAD_COMPILE_MAX_TOTAL_TIME_MS),
  })
  .strict();

const WorkspaceInspectionRequestSchema = z
  .object({
    ...WORKLOAD_REQUEST_BASE,
    profile: z.literal('workspace-inspection'),
  })
  .strict();

const FixtureCommandRequestSchema = z
  .object({
    ...WORKLOAD_REQUEST_BASE,
    profile: z.literal('fixture-command'),
    repetitions: z
      .number()
      .int()
      .min(1)
      .max(WORKLOAD_FIXTURE_COMMAND_MAX_REPETITIONS)
      .optional()
      .default(1),
  })
  .strict();

export const WorkloadRequestSchema = z.discriminatedUnion('profile', [
  WaitRequestSchema,
  ControlledFailureRequestSchema,
  CpuRequestSchema,
  TemporaryIoRequestSchema,
  CompileTestRequestSchema,
  WorkspaceInspectionRequestSchema,
  FixtureCommandRequestSchema,
]);

export type WorkloadRequest = z.infer<typeof WorkloadRequestSchema>;

export class WorkloadRequestError extends Error {
  constructor() {
    super('WORKLOAD_REQUEST_INVALID');
  }

  override readonly name = 'WorkloadRequestError';
  readonly code = 'WORKLOAD_REQUEST_INVALID';
}

export function parseWorkloadRequest(prompt: string): WorkloadRequest {
  if (Buffer.byteLength(prompt, 'utf8') > WORKLOAD_REQUEST_MAX_BYTES) {
    throw new WorkloadRequestError();
  }

  let input: unknown;
  try {
    input = JSON.parse(prompt);
  } catch {
    throw new WorkloadRequestError();
  }

  const parsed = WorkloadRequestSchema.safeParse(input);
  if (!parsed.success) throw new WorkloadRequestError();
  return parsed.data;
}

export type WorkloadCompletionInput =
  | {
      task_id: string;
      result_message_id: string;
      profile: 'controlled-failure';
      requested_delay_ms: number;
    }
  | {
      task_id: string;
      result_message_id: string;
      /** Omitted for compatibility with the original wait-only contract. */
      profile?: 'wait';
      requested_duration_ms: number;
      observed_elapsed_ms: number;
    }
  | {
      task_id: string;
      result_message_id: string;
      profile: 'cpu';
      requested_duration_ms: number;
      seed: number;
      observed_elapsed_ms: number;
      iterations: number;
      checksum: string;
    }
  | {
      task_id: string;
      result_message_id: string;
      profile: 'temporary-io';
      requested_bytes: number;
      seed: number;
      observed_elapsed_ms: number;
      bytes_written: number;
      bytes_read: number;
      sha256: string;
    }
  | {
      task_id: string;
      result_message_id: string;
      profile: 'compile-test';
      requested_repetitions: number;
      requested_total_time_ms: number;
      observed_elapsed_ms: number;
      observed_repetitions: number;
    }
  | {
      task_id: string;
      result_message_id: string;
      profile: 'workspace-inspection';
      inspection: WorkloadWorkspaceInspection;
    }
  | {
      task_id: string;
      result_message_id: string;
      profile: 'fixture-command';
      requested_repetitions: number;
      fixture_id: typeof WORKLOAD_FIXTURE_COMMAND_ID;
      outcome: 'completed' | 'failed';
      observed_elapsed_ms: number;
      completed_command_count: number;
      commands: [WorkloadFixtureCommandObservation, WorkloadFixtureCommandObservation];
      cleanup_confirmed: true;
    };

export type WorkloadResult =
  | {
      schemaVersion: 1;
      profile: 'wait';
      outcome: 'completed';
      taskId: TaskID;
      requested: { durationMs: number };
      observed: { elapsedMs: number };
    }
  | {
      schemaVersion: 1;
      profile: 'controlled-failure';
      outcome: 'failed';
      taskId: TaskID;
      requested: { delayMs: number };
      errorCode: typeof WORKLOAD_CONTROLLED_FAILURE_CODE;
    }
  | {
      schemaVersion: 1;
      profile: 'cpu';
      outcome: 'completed';
      taskId: TaskID;
      requested: { durationMs: number; seed: number };
      observed: { elapsedMs: number; iterations: number; checksum: string };
    }
  | {
      schemaVersion: 1;
      profile: 'temporary-io';
      outcome: 'completed';
      taskId: TaskID;
      requested: { bytes: number; seed: number };
      observed: { elapsedMs: number; bytesWritten: number; bytesRead: number; sha256: string };
    }
  | {
      schemaVersion: 1;
      profile: 'compile-test';
      outcome: 'completed';
      taskId: TaskID;
      requested: { repetitions: number; totalTimeMs: number };
      observed: { elapsedMs: number; repetitions: number; bundle: 'fixed-v1' };
    }
  | {
      schemaVersion: 1;
      profile: 'workspace-inspection';
      outcome: 'completed';
      taskId: TaskID;
      inspection: WorkloadWorkspaceInspection;
    }
  | {
      schemaVersion: 1;
      profile: 'fixture-command';
      outcome: 'completed' | 'failed';
      taskId: TaskID;
      requested: {
        repetitions: number;
        fixtureId: typeof WORKLOAD_FIXTURE_COMMAND_ID;
      };
      observed: {
        elapsedMs: number;
        completedCommandCount: number;
        commands: Array<{
          command: WorkloadFixtureCommand;
          attempted: number;
          completed: number;
          outcome: WorkloadFixtureCommandOutcome;
          exitCode: number | null;
          stdoutBytes: number;
          stderrBytes: number;
          stdoutSha256: string;
          stderrSha256: string;
        }>;
        cleanupConfirmed: true;
      };
      errorCode?: typeof WORKLOAD_FIXTURE_COMMAND_FAILURE_CODE;
    };

export class WorkloadContractError extends Error {
  constructor(message = 'WORKLOAD_COMPLETION_INVALID') {
    super(message);
  }

  override readonly name = 'WorkloadContractError';
  readonly code = 'WORKLOAD_COMPLETION_INVALID';
}

const COMMON_COMPLETION_FIELDS = new Set(['task_id', 'result_message_id', 'profile']);

function assertOnlyFields(input: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set([...COMMON_COMPLETION_FIELDS, ...fields]);
  const unknownFields = Object.keys(input).filter((field) => !allowed.has(field));
  if (unknownFields.length > 0) throw new WorkloadContractError();
}

const WAIT_COMPLETION_FIELDS = ['requested_duration_ms', 'observed_elapsed_ms'] as const;
const CONTROLLED_FAILURE_COMPLETION_FIELDS = ['requested_delay_ms'] as const;
const CPU_COMPLETION_FIELDS = [
  'requested_duration_ms',
  'seed',
  'observed_elapsed_ms',
  'iterations',
  'checksum',
] as const;
const TEMPORARY_IO_COMPLETION_FIELDS = [
  'requested_bytes',
  'seed',
  'observed_elapsed_ms',
  'bytes_written',
  'bytes_read',
  'sha256',
] as const;
const COMPILE_TEST_COMPLETION_FIELDS = [
  'requested_repetitions',
  'requested_total_time_ms',
  'observed_elapsed_ms',
  'observed_repetitions',
] as const;
const WORKSPACE_INSPECTION_COMPLETION_FIELDS = ['inspection'] as const;
const FIXTURE_COMMAND_COMPLETION_FIELDS = [
  'requested_repetitions',
  'fixture_id',
  'outcome',
  'observed_elapsed_ms',
  'completed_command_count',
  'commands',
  'cleanup_confirmed',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function requireFields(input: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (!(field in input)) throw new WorkloadContractError();
  }
}

function hasOnlyFields(input: Record<string, unknown>, fields: readonly string[]): boolean {
  const allowed = new Set(fields);
  return Object.keys(input).every((field) => allowed.has(field));
}

function isVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
  );
}

function isToolVersionObservation(value: unknown): value is WorkloadToolVersionObservation {
  if (!isRecord(value) || typeof value.state !== 'string') return false;
  if (value.state === 'available') {
    return hasOnlyFields(value, ['state', 'version']) && isVersion(value.version);
  }
  return (
    ['unavailable', 'failed', 'timed-out', 'invalid-output'].includes(value.state) &&
    hasOnlyFields(value, ['state'])
  );
}

function isFileObservation(value: unknown): value is WorkloadFileObservation {
  if (!isRecord(value) || typeof value.state !== 'string') return false;
  if (value.state === 'present') {
    return (
      hasOnlyFields(value, ['state', 'sha256']) &&
      typeof value.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(value.sha256)
    );
  }
  return (
    ['absent', 'unsafe-symlink', 'not-regular', 'too-large', 'unreadable'].includes(value.state) &&
    hasOnlyFields(value, ['state'])
  );
}

function isPackageManagerObservation(value: unknown): value is WorkloadPackageManagerObservation {
  if (!isRecord(value) || typeof value.state !== 'string') return false;
  if (value.state === 'valid') {
    return (
      hasOnlyFields(value, ['state', 'name', 'version']) &&
      ['npm', 'pnpm', 'yarn', 'bun'].includes(value.name as string) &&
      isVersion(value.version)
    );
  }
  return (
    ['absent', 'invalid', 'unavailable'].includes(value.state) && hasOnlyFields(value, ['state'])
  );
}

function isWorkspaceInspection(value: unknown): value is WorkloadWorkspaceInspection {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, [
      'node',
      'npm',
      'pnpm',
      'packageJson',
      'packageManager',
      'lockfiles',
      'repositoryMarkerPresent',
    ]) ||
    !isToolVersionObservation(value.node) ||
    value.node.state !== 'available' ||
    !isToolVersionObservation(value.npm) ||
    !isToolVersionObservation(value.pnpm) ||
    !isFileObservation(value.packageJson) ||
    !isPackageManagerObservation(value.packageManager) ||
    typeof value.repositoryMarkerPresent !== 'boolean' ||
    !Array.isArray(value.lockfiles) ||
    value.lockfiles.length !== WORKLOAD_LOCKFILES.length
  ) {
    return false;
  }

  if (
    (value.packageJson.state === 'absent' && value.packageManager.state !== 'absent') ||
    (value.packageJson.state === 'present' && value.packageManager.state === 'unavailable') ||
    (!['absent', 'present'].includes(value.packageJson.state) &&
      value.packageManager.state !== 'unavailable')
  ) {
    return false;
  }

  return value.lockfiles.every((entry, index) => {
    if (!isRecord(entry) || !hasOnlyFields(entry, ['name', 'file'])) return false;
    return entry.name === WORKLOAD_LOCKFILES[index] && isFileObservation(entry.file);
  });
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isFixtureCommandObservation(
  value: unknown,
  command: WorkloadFixtureCommand,
  repetitions: number
): value is WorkloadFixtureCommandObservation {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, [
      'command',
      'attempted',
      'completed',
      'outcome',
      'exit_code',
      'stdout_bytes',
      'stderr_bytes',
      'stdout_sha256',
      'stderr_sha256',
    ]) ||
    value.command !== command ||
    !isBoundedInteger(value.attempted, 0, repetitions) ||
    !isBoundedInteger(value.completed, 0, value.attempted) ||
    !WORKLOAD_FIXTURE_COMMANDS.includes(value.command as WorkloadFixtureCommand) ||
    !['not-run', 'passed', 'failed', 'timed-out', 'output-limit-exceeded', 'spawn-failed'].includes(
      value.outcome as string
    ) ||
    !isBoundedInteger(
      value.stdout_bytes,
      0,
      repetitions * WORKLOAD_FIXTURE_COMMAND_OUTPUT_MAX_BYTES
    ) ||
    !isBoundedInteger(
      value.stderr_bytes,
      0,
      repetitions * WORKLOAD_FIXTURE_COMMAND_OUTPUT_MAX_BYTES
    ) ||
    value.stdout_bytes + value.stderr_bytes >
      repetitions * WORKLOAD_FIXTURE_COMMAND_OUTPUT_MAX_BYTES ||
    !isSha256(value.stdout_sha256) ||
    !isSha256(value.stderr_sha256)
  ) {
    return false;
  }

  if (value.outcome === 'not-run') {
    return (
      value.attempted === 0 &&
      value.completed === 0 &&
      value.exit_code === null &&
      value.stdout_bytes === 0 &&
      value.stderr_bytes === 0 &&
      value.stdout_sha256 === WORKLOAD_EMPTY_SHA256 &&
      value.stderr_sha256 === WORKLOAD_EMPTY_SHA256
    );
  }
  if (value.outcome === 'passed') {
    return value.attempted > 0 && value.completed === value.attempted && value.exit_code === 0;
  }
  if (value.outcome === 'failed') {
    return (
      value.attempted > 0 &&
      value.completed === value.attempted - 1 &&
      (value.exit_code === null || isBoundedInteger(value.exit_code, 1, 255))
    );
  }
  return value.attempted > 0 && value.completed === value.attempted - 1 && value.exit_code === null;
}

/**
 * Validate the executor-to-daemon completion seam independently of TypeScript.
 * This keeps a malformed or hand-crafted Feathers call from widening the
 * canonical assistant result.
 */
export function assertValidWorkloadCompletionInput(
  value: unknown
): asserts value is WorkloadCompletionInput {
  if (!isRecord(value)) throw new WorkloadContractError();
  if (typeof value.task_id !== 'string' || typeof value.result_message_id !== 'string') {
    throw new WorkloadContractError();
  }
  if (value.profile !== undefined && typeof value.profile !== 'string') {
    throw new WorkloadContractError();
  }

  const profile = value.profile ?? 'wait';
  if (profile === 'wait') {
    assertOnlyFields(value, WAIT_COMPLETION_FIELDS);
    requireFields(value, ['requested_duration_ms', 'observed_elapsed_ms']);
    if (
      !isBoundedInteger(
        value.requested_duration_ms,
        WORKLOAD_MIN_DURATION_MS,
        WORKLOAD_MAX_DURATION_MS
      ) ||
      !isBoundedInteger(value.observed_elapsed_ms, 0, Number.MAX_SAFE_INTEGER)
    ) {
      throw new WorkloadContractError();
    }
    return;
  }

  if (profile === 'controlled-failure') {
    assertOnlyFields(value, CONTROLLED_FAILURE_COMPLETION_FIELDS);
    requireFields(value, ['requested_delay_ms']);
    if (!isBoundedInteger(value.requested_delay_ms, 0, WORKLOAD_MAX_DURATION_MS)) {
      throw new WorkloadContractError();
    }
    return;
  }

  if (profile === 'cpu') {
    assertOnlyFields(value, CPU_COMPLETION_FIELDS);
    requireFields(value, [
      'requested_duration_ms',
      'seed',
      'observed_elapsed_ms',
      'iterations',
      'checksum',
    ]);
    if (
      !isBoundedInteger(
        value.requested_duration_ms,
        WORKLOAD_CPU_MIN_DURATION_MS,
        WORKLOAD_MAX_DURATION_MS
      ) ||
      !isBoundedInteger(value.seed, 0, WORKLOAD_SEED_MAX) ||
      !isBoundedInteger(value.observed_elapsed_ms, 0, Number.MAX_SAFE_INTEGER) ||
      !isBoundedInteger(value.iterations, 1, Number.MAX_SAFE_INTEGER) ||
      typeof value.checksum !== 'string' ||
      !/^[0-9a-f]{8}$/.test(value.checksum)
    ) {
      throw new WorkloadContractError();
    }
    return;
  }

  if (profile === 'temporary-io') {
    assertOnlyFields(value, TEMPORARY_IO_COMPLETION_FIELDS);
    requireFields(value, [
      'requested_bytes',
      'seed',
      'observed_elapsed_ms',
      'bytes_written',
      'bytes_read',
      'sha256',
    ]);
    if (
      !isBoundedInteger(value.requested_bytes, 1, WORKLOAD_TEMP_IO_MAX_BYTES) ||
      !isBoundedInteger(value.seed, 0, WORKLOAD_SEED_MAX) ||
      !isBoundedInteger(value.observed_elapsed_ms, 0, Number.MAX_SAFE_INTEGER) ||
      value.bytes_written !== value.requested_bytes ||
      value.bytes_read !== value.requested_bytes ||
      typeof value.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.sha256)
    ) {
      throw new WorkloadContractError();
    }
    return;
  }

  if (profile === 'compile-test') {
    assertOnlyFields(value, COMPILE_TEST_COMPLETION_FIELDS);
    requireFields(value, [
      'requested_repetitions',
      'requested_total_time_ms',
      'observed_elapsed_ms',
      'observed_repetitions',
    ]);
    if (
      !isBoundedInteger(value.requested_repetitions, 1, WORKLOAD_COMPILE_MAX_REPETITIONS) ||
      !isBoundedInteger(value.requested_total_time_ms, 10, WORKLOAD_COMPILE_MAX_TOTAL_TIME_MS) ||
      !isBoundedInteger(value.observed_elapsed_ms, 0, Number.MAX_SAFE_INTEGER) ||
      value.observed_repetitions !== value.requested_repetitions
    ) {
      throw new WorkloadContractError();
    }
    return;
  }

  if (profile === 'workspace-inspection') {
    assertOnlyFields(value, WORKSPACE_INSPECTION_COMPLETION_FIELDS);
    requireFields(value, ['inspection']);
    if (!isWorkspaceInspection(value.inspection)) throw new WorkloadContractError();
    return;
  }

  if (profile === 'fixture-command') {
    assertOnlyFields(value, FIXTURE_COMMAND_COMPLETION_FIELDS);
    requireFields(value, FIXTURE_COMMAND_COMPLETION_FIELDS);
    if (
      !isBoundedInteger(value.requested_repetitions, 1, WORKLOAD_FIXTURE_COMMAND_MAX_REPETITIONS) ||
      value.fixture_id !== WORKLOAD_FIXTURE_COMMAND_ID ||
      !['completed', 'failed'].includes(value.outcome as string) ||
      !isBoundedInteger(value.observed_elapsed_ms, 0, Number.MAX_SAFE_INTEGER) ||
      !isBoundedInteger(
        value.completed_command_count,
        0,
        value.requested_repetitions * WORKLOAD_FIXTURE_COMMANDS.length
      ) ||
      !Array.isArray(value.commands) ||
      value.commands.length !== WORKLOAD_FIXTURE_COMMANDS.length ||
      value.cleanup_confirmed !== true
    ) {
      throw new WorkloadContractError();
    }

    const [nodeCheck, nodeTest] = value.commands;
    if (
      !isFixtureCommandObservation(nodeCheck, 'node-check', value.requested_repetitions) ||
      !isFixtureCommandObservation(nodeTest, 'node-test', value.requested_repetitions) ||
      value.completed_command_count !== nodeCheck.completed + nodeTest.completed
    ) {
      throw new WorkloadContractError();
    }

    const completed = value.outcome === 'completed';
    const successfulShape =
      nodeCheck.attempted === value.requested_repetitions &&
      nodeCheck.completed === value.requested_repetitions &&
      nodeCheck.outcome === 'passed' &&
      nodeTest.attempted === value.requested_repetitions &&
      nodeTest.completed === value.requested_repetitions &&
      nodeTest.outcome === 'passed';
    const failedCheckShape =
      nodeCheck.attempted === nodeTest.attempted + 1 &&
      nodeCheck.completed === nodeCheck.attempted - 1 &&
      nodeCheck.outcome !== 'passed' &&
      nodeCheck.outcome !== 'not-run' &&
      nodeTest.completed === nodeTest.attempted &&
      (nodeTest.attempted === 0 ? nodeTest.outcome === 'not-run' : nodeTest.outcome === 'passed');
    const failedTestShape =
      nodeCheck.attempted === nodeTest.attempted &&
      nodeCheck.completed === nodeCheck.attempted &&
      nodeCheck.outcome === 'passed' &&
      nodeTest.attempted > 0 &&
      nodeTest.completed === nodeTest.attempted - 1 &&
      nodeTest.outcome !== 'passed' &&
      nodeTest.outcome !== 'not-run';
    if ((completed && !successfulShape) || (!completed && !failedCheckShape && !failedTestShape)) {
      throw new WorkloadContractError();
    }
    return;
  }

  throw new WorkloadContractError();
}

/** Reject executor echoes that do not exactly match the durable workload request. */
export function assertWorkloadCompletionMatchesRequest(
  request: WorkloadRequest,
  input: WorkloadCompletionInput
): void {
  const inputProfile = input.profile ?? 'wait';
  if (request.profile !== inputProfile) throw new WorkloadContractError();

  switch (request.profile) {
    case 'wait': {
      const completion = input as Extract<WorkloadCompletionInput, { profile?: 'wait' }>;
      if (inputProfile !== 'wait' || completion.requested_duration_ms !== request.durationMs)
        throw new WorkloadContractError();
      return;
    }
    case 'controlled-failure': {
      const completion = input as Extract<
        WorkloadCompletionInput,
        { profile: 'controlled-failure' }
      >;
      if (
        inputProfile !== 'controlled-failure' ||
        completion.requested_delay_ms !== request.delayMs
      )
        throw new WorkloadContractError();
      return;
    }
    case 'cpu': {
      const completion = input as Extract<WorkloadCompletionInput, { profile: 'cpu' }>;
      if (
        inputProfile !== 'cpu' ||
        completion.requested_duration_ms !== request.durationMs ||
        completion.seed !== request.seed
      )
        throw new WorkloadContractError();
      return;
    }
    case 'temporary-io': {
      const completion = input as Extract<WorkloadCompletionInput, { profile: 'temporary-io' }>;
      if (
        inputProfile !== 'temporary-io' ||
        completion.requested_bytes !== request.bytes ||
        completion.seed !== request.seed
      )
        throw new WorkloadContractError();
      return;
    }
    case 'compile-test': {
      const completion = input as Extract<WorkloadCompletionInput, { profile: 'compile-test' }>;
      if (
        inputProfile !== 'compile-test' ||
        completion.requested_repetitions !== request.repetitions ||
        completion.requested_total_time_ms !== request.totalTimeMs
      )
        throw new WorkloadContractError();
      return;
    }
    case 'workspace-inspection':
      return;
    case 'fixture-command': {
      const completion = input as Extract<WorkloadCompletionInput, { profile: 'fixture-command' }>;
      if (
        completion.requested_repetitions !== request.repetitions ||
        completion.fixture_id !== WORKLOAD_FIXTURE_COMMAND_ID
      ) {
        throw new WorkloadContractError();
      }
      return;
    }
  }
}

/** Build the one server-authored assistant payload for a workload settlement. */
export function workloadResultFromCompletion(
  taskId: TaskID,
  request: WorkloadRequest,
  input: WorkloadCompletionInput
): WorkloadResult {
  assertWorkloadCompletionMatchesRequest(request, input);

  if (request.profile === 'wait') {
    const completion = input as Extract<WorkloadCompletionInput, { profile?: 'wait' }>;
    return {
      schemaVersion: 1,
      profile: 'wait',
      outcome: 'completed',
      taskId,
      requested: { durationMs: request.durationMs },
      observed: { elapsedMs: completion.observed_elapsed_ms },
    };
  }

  switch (request.profile) {
    case 'controlled-failure':
      return {
        schemaVersion: 1,
        profile: 'controlled-failure',
        outcome: 'failed',
        taskId,
        requested: { delayMs: request.delayMs },
        errorCode: WORKLOAD_CONTROLLED_FAILURE_CODE,
      };
    case 'cpu': {
      const completion = input as Extract<WorkloadCompletionInput, { profile: 'cpu' }>;
      return {
        schemaVersion: 1,
        profile: 'cpu',
        outcome: 'completed',
        taskId,
        requested: { durationMs: request.durationMs, seed: request.seed },
        observed: {
          elapsedMs: completion.observed_elapsed_ms,
          iterations: completion.iterations,
          checksum: completion.checksum,
        },
      };
    }
    case 'temporary-io': {
      const completion = input as Extract<WorkloadCompletionInput, { profile: 'temporary-io' }>;
      return {
        schemaVersion: 1,
        profile: 'temporary-io',
        outcome: 'completed',
        taskId,
        requested: { bytes: request.bytes, seed: request.seed },
        observed: {
          elapsedMs: completion.observed_elapsed_ms,
          bytesWritten: completion.bytes_written,
          bytesRead: completion.bytes_read,
          sha256: completion.sha256,
        },
      };
    }
    case 'compile-test': {
      const completion = input as Extract<WorkloadCompletionInput, { profile: 'compile-test' }>;
      return {
        schemaVersion: 1,
        profile: 'compile-test',
        outcome: 'completed',
        taskId,
        requested: {
          repetitions: request.repetitions,
          totalTimeMs: request.totalTimeMs,
        },
        observed: {
          elapsedMs: completion.observed_elapsed_ms,
          repetitions: completion.observed_repetitions,
          bundle: 'fixed-v1',
        },
      };
    }
    case 'workspace-inspection': {
      const completion = input as Extract<
        WorkloadCompletionInput,
        { profile: 'workspace-inspection' }
      >;
      return {
        schemaVersion: 1,
        profile: 'workspace-inspection',
        outcome: 'completed',
        taskId,
        inspection: completion.inspection,
      };
    }
    case 'fixture-command': {
      const completion = input as Extract<WorkloadCompletionInput, { profile: 'fixture-command' }>;
      return {
        schemaVersion: 1,
        profile: 'fixture-command',
        outcome: completion.outcome,
        taskId,
        requested: {
          repetitions: request.repetitions,
          fixtureId: WORKLOAD_FIXTURE_COMMAND_ID,
        },
        observed: {
          elapsedMs: completion.observed_elapsed_ms,
          completedCommandCount: completion.completed_command_count,
          commands: completion.commands.map((command) => ({
            command: command.command,
            attempted: command.attempted,
            completed: command.completed,
            outcome: command.outcome,
            exitCode: command.exit_code,
            stdoutBytes: command.stdout_bytes,
            stderrBytes: command.stderr_bytes,
            stdoutSha256: command.stdout_sha256,
            stderrSha256: command.stderr_sha256,
          })),
          cleanupConfirmed: true,
        },
        ...(completion.outcome === 'failed'
          ? { errorCode: WORKLOAD_FIXTURE_COMMAND_FAILURE_CODE }
          : {}),
      };
    }
  }
}
