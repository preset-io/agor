/**
 * Environment Command Handlers for Executor
 *
 * Shell-based managed-environment lifecycle commands run here instead of in
 * the daemon. The daemon still owns authorization, webhook execution, and
 * health checks; the executor owns commands that require the branch checkout
 * filesystem and potentially long-running build output.
 */

import { spawn } from 'node:child_process';
import type { EnvironmentLifecycleResult } from '@agor/core/environment/lifecycle-result';
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
    case 'restart':
      return 'Restart command completed';
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
    case 'restart':
      return payload.params.startCommand!;
  }
}

async function updateBranchEnvironment(
  client: Awaited<ReturnType<typeof createExecutorClient>>,
  branchId: string,
  environmentUpdate: Record<string, unknown>
): Promise<void> {
  await client.service('branches').updateEnvironment({
    branch_id: branchId,
    environment_update: environmentUpdate,
  });
}

async function runShellCommand(options: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  commandType: 'start' | 'stop' | 'nuke' | 'logs';
  parseLifecycleResult?: boolean;
}): Promise<{
  pid?: number;
  output?: string;
  lifecycleResult?: EnvironmentLifecycleResult;
  facts: Record<string, string>;
}> {
  const { command, cwd, env, commandType, parseLifecycleResult = false } = options;
  assertEnvCommandAllowed(command, commandType);

  const child = spawn(command, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stdio: 'pipe',
    shell: true,
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
      child.on('close', (code: number | null) => {
        if (code === 0) {
          resolve();
        } else {
          const message =
            code === null
              ? `${commandType} command exited without a code`
              : `${commandType} command exited with code ${code}`;
          const error = new Error(message) as Error & { output?: string; pid?: number };
          error.output = capture.visibleOutput();
          error.pid = child.pid;
          reject(error);
        }
      });
      child.on('error', (error: Error) => {
        const enriched = error as Error & { output?: string; pid?: number };
        enriched.output = capture.visibleOutput();
        enriched.pid = child.pid;
        reject(enriched);
      });
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

  try {
    const branch = await client.service('branches').get(branchId);
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
        commandType: 'start',
        parseLifecycleResult: false,
      });
      await updateBranchEnvironment(client, branchId, {
        last_command: {
          action: 'sync',
          status: 'succeeded',
          timestamp: new Date().toISOString(),
          message: successMessage('sync'),
          ...(result.output ? { output: result.output } : {}),
        },
      });
      return { success: true, data: { branchId, action: 'sync' } };
    }

    if (payload.params.action === 'restart' && payload.params.stopCommand) {
      await updateBranchEnvironment(client, branchId, {
        status: 'stopping',
      });
      await runShellCommand({
        command: payload.params.stopCommand,
        cwd,
        env: payload.env,
        commandType: 'stop',
      });
    }

    if (payload.params.action === 'start' || payload.params.action === 'restart') {
      const startedAt = new Date().toISOString();
      await updateBranchEnvironment(client, branchId, {
        status: 'starting',
        process: {
          ...(branch.environment_instance?.process ?? {}),
          started_at: startedAt,
        },
        // This update crosses the Feathers/WebSocket JSON boundary; use null
        // as an explicit clear sentinel because JSON drops undefined values.
        last_health_check: null,
        last_error: null,
        last_command: null,
        ...(payload.params.appUrl
          ? { access_urls: [{ name: 'App', url: payload.params.appUrl }] }
          : {}),
      });

      const result = await runShellCommand({
        command: payload.params.startCommand!,
        cwd,
        env: payload.env,
        commandType: 'start',
        parseLifecycleResult: true,
      });

      const accessUrls =
        result.lifecycleResult?.access_urls ??
        (payload.params.appUrl ? [{ name: 'App', url: payload.params.appUrl }] : undefined);
      const effectiveHealthUrl =
        result.lifecycleResult?.health_url ?? payload.params.healthCheckUrl;
      const completedAt = new Date().toISOString();

      await updateBranchEnvironment(client, branchId, {
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
        access_urls: accessUrls ?? null,
        lifecycle_result: result.lifecycleResult ?? null,
        facts: Object.keys(result.facts).length > 0 ? result.facts : null,
        last_command: {
          action: payload.params.action,
          status: 'succeeded',
          timestamp: completedAt,
          message: successMessage(payload.params.action),
          ...(result.output ? { output: result.output } : {}),
        },
      });

      return { success: true, data: { branchId, action: payload.params.action } };
    }

    const command = commandForAction(payload);
    const commandType = payload.params.action;
    const result = await runShellCommand({
      command,
      cwd,
      env: payload.env,
      commandType,
    });

    await updateBranchEnvironment(client, branchId, {
      status: 'stopped',
      // This update crosses the Feathers/WebSocket JSON boundary; use null
      // as an explicit clear sentinel because JSON drops undefined values.
      process: null,
      // Nuke destroys the environment, so any address it reported is now dead —
      // clear facts. Stop only pauses (a Codespace keeps its name and resumes
      // to the same URL), so facts are preserved there.
      ...(payload.params.action === 'nuke'
        ? { facts: null, lifecycle_result: null, access_urls: null }
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
    });

    return { success: true, data: { branchId, action: payload.params.action } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const output =
      error instanceof Error ? (error as Error & { output?: string }).output : undefined;

    try {
      const current = await client.service('branches').get(branchId);
      const currentStatus = current.environment_instance?.status;
      const staleStartFailure =
        payload.params.action === 'start' &&
        (currentStatus === 'stopping' || currentStatus === 'stopped');
      if (!staleStartFailure) {
        await updateBranchEnvironment(client, branchId, {
          status: 'error',
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
        });
      }
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
