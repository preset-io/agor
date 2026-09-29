/**
 * Environment Command Handlers for Executor
 *
 * Shell-based managed-environment lifecycle commands run here instead of in
 * the daemon. The daemon still owns authorization, webhook execution, and
 * health checks; the executor owns commands that require the branch checkout
 * filesystem and potentially long-running build output.
 */

import { ENVIRONMENT } from '@agor/core/config';
import { validateEnvironmentSyncResult } from '@agor/core/environment/lifecycle-result';
import type {
  EnvironmentLifecyclePayload,
  EnvironmentLogsPayload,
  EnvironmentSyncPayload,
  ExecutorResult,
} from '../payload-types.js';
import { createExecutorClient } from '../services/feathers-client.js';
import { handleEnvironmentAttempt } from './environment-attempt.js';
import { EnvironmentCommandOutputCapture } from './environment-command-output.js';
import { EnvironmentOutput, runBoundedEnvironmentShell } from './environment-shell.js';
import type { CommandOptions } from './index.js';

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
    const output = new EnvironmentOutput();
    const result = await runBoundedEnvironmentShell({
      command: payload.params.logsCommand,
      cwd,
      env: payload.env,
      action: 'logs',
      output,
      deadline: Date.now() + ENVIRONMENT.LOGS_TIMEOUT_MS - 5000,
    });
    if (result.outcome !== 'succeeded') throw new Error(result.message);

    return {
      success: true,
      data: {
        logs: output.text(),
        truncated: output.truncated,
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

  return handleEnvironmentAttempt(payload);
}

export async function handleEnvironmentSync(
  payload: EnvironmentSyncPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun) {
    return { success: true, data: { dryRun: true, command: 'environment.sync' } };
  }
  const output = new EnvironmentCommandOutputCapture({
    parseEnvironmentResult: true,
    validateResult: validateEnvironmentSyncResult,
  });
  try {
    const result = await runBoundedEnvironmentShell({
      command: payload.params.syncCommand,
      action: 'sync',
      cwd: payload.params.branchPath,
      env: payload.env,
      deadline: Date.parse(payload.params.commandDeadline),
      onStdout: (chunk) => output.writeStdout(chunk),
      onStderr: (chunk) => output.writeStderr(chunk),
    });
    if (result.outcome !== 'succeeded') throw new Error(result.message);
    const appliedRevision = output.finish().environmentResult?.applied_revision;
    if (appliedRevision !== payload.params.desiredRevision) {
      throw new Error('Environment did not acknowledge the requested source revision');
    }
    return { success: true, data: { appliedRevision } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'ENVIRONMENT_SYNC_FAILED',
        message: error instanceof Error ? error.message : String(error),
        details: { output: output.text(), truncated: output.truncated },
      },
    };
  }
}
