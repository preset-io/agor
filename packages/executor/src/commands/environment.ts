/**
 * Environment Command Handlers for Executor
 *
 * Shell-based managed-environment lifecycle commands run here instead of in
 * the daemon. The daemon still owns authorization, webhook execution, and
 * health checks; the executor owns commands that require the branch checkout
 * filesystem and potentially long-running build output.
 */

import { spawn } from 'node:child_process';
import { resolveEnvironmentStartupTimeoutMs } from '@agor/core/environment/health-transition';
import {
  ENVIRONMENT_LIFECYCLE_SUPERSEDED_CODE,
  type EnvironmentLifecycleResult,
  validateEnvironmentSourceRevision,
} from '@agor/core/environment/lifecycle-result';
import { assertEnvCommandAllowed } from '@agor/core/unix';
import type {
  EnvironmentLifecyclePayload,
  EnvironmentLogsPayload,
  ExecutorResult,
} from '../payload-types.js';
import { createExecutorClient } from '../services/feathers-client.js';
import { EnvironmentCommandOutputCapture } from './environment-command-output.js';
import type { CommandOptions } from './index.js';

function successMessage(action: EnvironmentLifecyclePayload['params']['action']): string {
  switch (action) {
    case 'start':
      return 'Start command completed';
    case 'stop':
      return 'Stop command completed';
    case 'nuke':
      return 'Nuke command completed';
    case 'sync':
      return 'Sync command completed';
  }
}

function commandForAction(payload: EnvironmentLifecyclePayload): string {
  switch (payload.params.action) {
    case 'start':
      return payload.params.startCommand!;
    case 'stop':
      return payload.params.stopCommand!;
    case 'nuke':
      return payload.params.nukeCommand!;
    case 'sync':
      return payload.params.syncCommand!;
  }
}

type EnvironmentStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

const ENVIRONMENT_COMMAND_TERM_GRACE_MS = 5_000;
const ENVIRONMENT_COMMAND_KILL_CONFIRMATION_MS = 5_000;
const ENVIRONMENT_COMMAND_CONTAINMENT_POLL_MS = 50;

async function updateBranchEnvironment(
  client: Awaited<ReturnType<typeof createExecutorClient>>,
  branchId: string,
  environmentUpdate: Record<string, unknown>,
  expectedEnvironmentGeneration?: number,
  expectedEnvironmentStatus?: EnvironmentStatus
): Promise<{ applied: boolean; generation?: number }> {
  try {
    const branch = await client.service('branches').updateEnvironment({
      branch_id: branchId,
      environment_update: environmentUpdate,
      ...(expectedEnvironmentGeneration !== undefined
        ? { expected_environment_generation: expectedEnvironmentGeneration }
        : {}),
      ...(expectedEnvironmentStatus !== undefined
        ? { expected_environment_status: expectedEnvironmentStatus }
        : {}),
    });
    return { applied: true, generation: branch.environment_generation };
  } catch (error) {
    const record = error as {
      message?: unknown;
      data?: { code?: unknown };
    };
    if (
      record.data?.code === ENVIRONMENT_LIFECYCLE_SUPERSEDED_CODE ||
      (typeof record.message === 'string' && record.message.includes('was superseded'))
    ) {
      return { applied: false };
    }
    throw error;
  }
}

function supersededResult(
  branchId: string,
  action: EnvironmentLifecyclePayload['params']['action']
): ExecutorResult {
  return { success: true, data: { branchId, action, superseded: true } };
}

function terminateCommandProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      // Shell commands may start grandchildren. The child is detached into its
      // own process group below, so terminate the whole command tree.
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The shell may have exited between the timeout and this signal. Fall
      // back to ChildProcess.kill so platforms without process-group support
      // still receive a best-effort cancellation.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // A concurrently exited command is already cancelled.
  }
}

function isCommandProcessGroupAlive(child: ReturnType<typeof spawn>): boolean {
  if (!child.pid) return false;
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export async function runShellCommand(options: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  commandType: 'start' | 'stop' | 'nuke' | 'sync' | 'logs';
  parseLifecycleResult?: boolean;
  timeoutMs?: number;
}): Promise<{
  pid?: number;
  output?: string;
  lifecycleResult?: EnvironmentLifecycleResult;
  facts: Record<string, string>;
}> {
  const { command, cwd, env, commandType, parseLifecycleResult = false, timeoutMs } = options;
  assertEnvCommandAllowed(command, commandType);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error(`${commandType} command timeout must be a positive integer`);
  }

  const child = spawn(command, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stdio: 'pipe',
    shell: true,
    // Every deadline-bound environment command gets a private process group, so
    // the deadline can terminate the whole command tree rather than a shell
    // whose grandchildren survive it.
    detached: timeoutMs !== undefined && process.platform !== 'win32',
  });

  const capture = new EnvironmentCommandOutputCapture({
    parseLifecycleResult,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  child.stdout?.on('data', (chunk: Buffer) => capture.writeStdout(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => capture.writeStderr(chunk.toString()));

  try {
    await new Promise<void>((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | undefined;
      let forceKillHandle: NodeJS.Timeout | undefined;
      let killConfirmationHandle: NodeJS.Timeout | undefined;
      let containmentPollHandle: NodeJS.Timeout | undefined;
      let timeoutError: (Error & { output?: string; pid?: number }) | undefined;
      let settled = false;
      const clearCommandTimers = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (forceKillHandle) clearTimeout(forceKillHandle);
        if (killConfirmationHandle) clearTimeout(killConfirmationHandle);
        if (containmentPollHandle) clearTimeout(containmentPollHandle);
      };
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearCommandTimers();
        callback();
      };
      child.on('close', (code: number | null) => {
        if (timeoutError) {
          if (!isCommandProcessGroupAlive(child)) settle(() => reject(timeoutError!));
          return;
        }
        if (code === 0) {
          settle(resolve);
        } else {
          const message =
            code === null
              ? `${commandType} command exited without a code`
              : `${commandType} command exited with code ${code}`;
          const error = new Error(message) as Error & { output?: string; pid?: number };
          error.output = capture.visibleOutput();
          error.pid = child.pid;
          settle(() => reject(error));
        }
      });
      child.on('error', (error: Error) => {
        if (timeoutError) {
          if (!isCommandProcessGroupAlive(child)) settle(() => reject(timeoutError!));
          return;
        }
        const enriched = error as Error & { output?: string; pid?: number };
        enriched.output = capture.visibleOutput();
        enriched.pid = child.pid;
        settle(() => reject(enriched));
      });
      if (timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          timeoutError = new Error(
            `${commandType} command exceeded its ${timeoutMs}ms deadline`
          ) as Error & { output?: string; pid?: number };
          timeoutError.output = capture.visibleOutput();
          timeoutError.pid = child.pid;
          terminateCommandProcess(child, 'SIGTERM');
          // Do not settle while the command tree can still mutate its provider.
          // The ref'd escalation timer keeps the CLI alive through containment.
          forceKillHandle = setTimeout(() => {
            terminateCommandProcess(child, 'SIGKILL');
            const confirmContainment = () => {
              if (!isCommandProcessGroupAlive(child)) {
                settle(() => reject(timeoutError!));
                return;
              }
              containmentPollHandle = setTimeout(
                confirmContainment,
                ENVIRONMENT_COMMAND_CONTAINMENT_POLL_MS
              );
            };
            killConfirmationHandle = setTimeout(() => {
              const error = new Error(
                `${commandType} command containment could not be verified after SIGKILL`
              ) as Error & {
                output?: string;
                pid?: number;
                containmentUnverified?: boolean;
              };
              error.output = capture.visibleOutput();
              error.pid = child.pid;
              error.containmentUnverified = true;
              settle(() => reject(error));
            }, ENVIRONMENT_COMMAND_KILL_CONFIRMATION_MS);
            confirmContainment();
          }, ENVIRONMENT_COMMAND_TERM_GRACE_MS);
        }, timeoutMs);
      }
    });
  } catch (error) {
    try {
      capture.finish();
    } catch {
      // The command failure remains authoritative; control records stay suppressed.
    }
    throw error;
  }

  try {
    return { pid: child.pid, ...capture.finish() };
  } catch (error) {
    const enriched = error as Error & { output?: string; pid?: number };
    enriched.output = capture.visibleOutput();
    enriched.pid = child.pid;
    throw enriched;
  }
}

export async function handleEnvironmentLogs(
  payload: EnvironmentLogsPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'environment.logs',
        branchId: payload.params.branchId,
      },
    };
  }

  const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
  const client = await createExecutorClient(daemonUrl, payload.sessionToken);
  const branch = await client.service('branches').get(payload.params.branchId);
  const cwd = payload.params.branchPath || branch.path;

  try {
    const result = await runShellCommand({
      command: payload.params.logsCommand,
      cwd,
      env: payload.env,
      commandType: 'logs',
      timeoutMs: payload.params.commandTimeoutMs,
    });

    return {
      success: true,
      data: {
        logs: result.output ?? '',
        timestamp: new Date().toISOString(),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const output =
      error instanceof Error ? (error as Error & { output?: string }).output : undefined;
    return {
      success: false,
      error: {
        code: 'ENVIRONMENT_LOGS_FAILED',
        message,
        details: { output },
      },
    };
  }
}

export async function handleEnvironmentLifecycle(
  payload: EnvironmentLifecyclePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        command: 'environment.lifecycle',
        action: payload.params.action,
        branchId: payload.params.branchId,
      },
    };
  }

  const daemonUrl = payload.daemonUrl || 'http://localhost:3030';
  const client = await createExecutorClient(daemonUrl, payload.sessionToken);
  const branchId = payload.params.branchId;
  let lifecycleGeneration = payload.params.lifecycleGeneration;

  try {
    const branch = await client.service('branches').get(branchId);
    if (
      lifecycleGeneration !== undefined &&
      branch.environment_generation !== lifecycleGeneration
    ) {
      return supersededResult(branchId, payload.params.action);
    }
    const cwd = payload.params.branchPath || branch.path;

    // Sync: push the branch's latest code into the already-running environment.
    // Distinct from start/stop — it does NOT change status (the environment
    // keeps running) and does NOT touch access_urls/facts (those describe the
    // environment's identity, not this push). It only records the command
    // outcome so the UI can show sync progress/errors.
    if (payload.params.action === 'sync') {
      const result = await runShellCommand({
        command: payload.params.syncCommand!,
        cwd,
        env: payload.env,
        commandType: 'sync',
        parseLifecycleResult: true,
        timeoutMs: payload.params.commandTimeoutMs,
      });
      const appliedRevision = validateEnvironmentSourceRevision(
        result.lifecycleResult?.applied_revision,
        'environment sync command acknowledgement'
      );
      if (appliedRevision !== payload.params.desiredRevision) {
        throw new Error(
          `Sync command acknowledged ${appliedRevision}, expected ${payload.params.desiredRevision}`
        );
      }
      return {
        success: true,
        data: {
          branchId,
          action: 'sync',
          claimToken: payload.params.syncClaimToken,
          appliedRevision,
        },
      };
    }

    // Start's own writes are fenced on the lifecycle generation ALONE. The
    // health monitor promotes `starting -> running` without advancing the
    // generation, deliberately, so that this command keeps ownership of
    // publishing its typed lifecycle result (see the comment on
    // `invalidatesTimedOutStart` in EnvironmentHealthRepository.commit). Adding
    // a status fence here would silently discard the access URLs, facts, and
    // pid of every environment whose readiness probe won that race — and, on
    // the claim below, would let a stale process still answering the health URL
    // stop the real start command from ever running.
    if (payload.params.action === 'start') {
      const startedAt = new Date().toISOString();
      const existingDeadline = Date.parse(branch.environment_instance?.startup_deadline_at ?? '');
      const startupDeadlineAt = Number.isFinite(existingDeadline)
        ? new Date(existingDeadline).toISOString()
        : new Date(
            Date.parse(startedAt) +
              resolveEnvironmentStartupTimeoutMs(payload.params.startupTimeoutMs)
          ).toISOString();
      const starting = await updateBranchEnvironment(
        client,
        branchId,
        {
          status: 'starting',
          process: {
            ...(branch.environment_instance?.process ?? {}),
            started_at: startedAt,
          },
          startup_deadline_at: startupDeadlineAt,
          // This update crosses the Feathers/WebSocket JSON boundary; use null
          // as an explicit clear sentinel because JSON drops undefined values.
          last_health_check: null,
          last_error: null,
          last_command: null,
        },
        lifecycleGeneration
      );
      if (!starting.applied) return supersededResult(branchId, payload.params.action);
      lifecycleGeneration = starting.generation ?? lifecycleGeneration;

      const result = await runShellCommand({
        command: payload.params.startCommand!,
        cwd,
        env: payload.env,
        commandType: 'start',
        parseLifecycleResult: true,
        timeoutMs: Math.min(
          resolveEnvironmentStartupTimeoutMs(payload.params.startupTimeoutMs),
          Math.max(1, Date.parse(startupDeadlineAt) - Date.now())
        ),
      });

      const effectiveHealthUrl =
        result.lifecycleResult?.health_url ?? payload.params.healthCheckUrl;
      const completedAt = new Date().toISOString();

      const completion = await updateBranchEnvironment(
        client,
        branchId,
        {
          ...(!effectiveHealthUrl
            ? {
                status: 'running',
                last_health_check: {
                  timestamp: completedAt,
                  status: 'unknown',
                  message: 'Start command completed; health is unavailable',
                },
              }
            : {}),
          process: {
            ...(branch.environment_instance?.process ?? {}),
            pid: result.pid,
            started_at: startedAt,
          },
          lifecycle_result: result.lifecycleResult ?? null,
          last_command: {
            action: payload.params.action,
            status: 'succeeded',
            timestamp: completedAt,
            message: successMessage(payload.params.action),
            ...(result.output ? { output: result.output } : {}),
          },
        },
        lifecycleGeneration
      );
      if (!completion.applied) return supersededResult(branchId, payload.params.action);

      return {
        success: true,
        data: {
          branchId,
          action: payload.params.action,
          ...(completion.generation !== undefined
            ? { lifecycleGeneration: completion.generation }
            : {}),
        },
      };
    }

    const command = commandForAction(payload);
    const commandType = payload.params.action;
    const result = await runShellCommand({
      command,
      cwd,
      env: payload.env,
      commandType,
      timeoutMs: payload.params.commandTimeoutMs,
    });

    const completion = await updateBranchEnvironment(
      client,
      branchId,
      {
        status: 'stopped',
        // This update crosses the Feathers/WebSocket JSON boundary; use null
        // as an explicit clear sentinel because JSON drops undefined values.
        process: null,
        startup_deadline_at: null,
        lifecycle_deadline_at: null,
        // Nuke destroys the environment, so any address it reported is now dead —
        // clear facts. Stop only pauses (a Codespace keeps its name and resumes
        // to the same URL), so facts are preserved there.
        ...(payload.params.action === 'nuke'
          ? { facts: null, lifecycle_result: null, access_urls: null, source_sync: null }
          : {}),
        last_health_check: {
          timestamp: new Date().toISOString(),
          status: 'unknown',
          message:
            payload.params.action === 'nuke'
              ? 'Environment nuked - all data and volumes destroyed'
              : 'Environment stopped',
        },
        last_error: null,
        last_command: {
          action: payload.params.action,
          status: 'succeeded',
          timestamp: new Date().toISOString(),
          message: successMessage(payload.params.action),
          ...(result.output ? { output: result.output } : {}),
        },
      },
      lifecycleGeneration,
      'stopping'
    );
    if (!completion.applied) return supersededResult(branchId, payload.params.action);

    // Restart sequences its Start phase from this exact settled generation, so
    // report the boundary this command actually produced rather than the one it
    // was dispatched with — the status change advanced it.
    return {
      success: true,
      data: {
        branchId,
        action: payload.params.action,
        ...(completion.generation !== undefined
          ? { lifecycleGeneration: completion.generation }
          : {}),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const output =
      error instanceof Error ? (error as Error & { output?: string }).output : undefined;
    const containmentUnverified =
      error instanceof Error &&
      (error as Error & { containmentUnverified?: boolean }).containmentUnverified === true;

    if (payload.params.action === 'sync') {
      return {
        success: false,
        error: {
          code: containmentUnverified
            ? 'ENVIRONMENT_CONTAINMENT_UNVERIFIED'
            : 'ENVIRONMENT_COMMAND_FAILED',
          message,
          details: { branchId, action: 'sync', output },
        },
      };
    }

    // Do not publish a retryable terminal state while a command tree may still
    // be mutating the external provider. Its persisted lifecycle boundary and
    // deadline remain authoritative for operator/reconciler recovery.
    if (containmentUnverified) {
      return {
        success: false,
        error: {
          code: 'ENVIRONMENT_CONTAINMENT_UNVERIFIED',
          message,
          details: { branchId, action: payload.params.action, output },
        },
      };
    }

    try {
      // One generation-fenced write, not a read followed by a write. Every
      // competing lifecycle claim opens a boundary and therefore advances the
      // generation, so the CAS alone already rejects a stale failure — while
      // re-reading the branch first spent a second acknowledgement budget this
      // command may no longer be authorized for.
      //
      // Deliberately NOT status-fenced. The health monitor moves an environment
      // `starting -> running` and `running -> error` WITHOUT advancing the
      // generation (see EnvironmentHealthRepository.commit), precisely so this
      // command keeps ownership of its own outcome. Fencing on the status this
      // command last saw would throw its result away every time readiness won
      // the race.
      const failure = await updateBranchEnvironment(
        client,
        branchId,
        {
          status: 'error',
          lifecycle_deadline_at: null,
          last_health_check: {
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            message,
          },
          last_error: output || message,
          last_command: {
            action: payload.params.action,
            status: 'failed',
            timestamp: new Date().toISOString(),
            message,
            ...(output ? { output } : {}),
          },
        },
        lifecycleGeneration
      );
      if (!failure.applied) return supersededResult(branchId, payload.params.action);
    } catch (patchError) {
      console.error(
        '[environment.lifecycle] Failed to patch environment error state:',
        patchError instanceof Error ? patchError.message : String(patchError)
      );
    }

    return {
      success: false,
      error: {
        code: 'ENVIRONMENT_COMMAND_FAILED',
        message,
        details: {
          branchId,
          action: payload.params.action,
          output,
        },
      },
    };
  }
}
