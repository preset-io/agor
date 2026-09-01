/**
 * Environment Command Handlers for Executor
 *
 * Shell-based managed-environment lifecycle commands run here instead of in
 * the daemon. The daemon still owns authorization, webhook execution, and
 * health checks; the executor owns commands that require the branch checkout
 * filesystem and potentially long-running build output.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { ENVIRONMENT } from '@agor/core/config';
import {
  type EnvironmentLifecycleResult,
  validateEnvironmentLifecycleResult,
} from '@agor/core/environment/lifecycle-result';
import type { Branch } from '@agor/core/types';
import { assertEnvCommandAllowed } from '@agor/core/unix';
import type {
  EnvironmentLifecyclePayload,
  EnvironmentLogsPayload,
  ExecutorResult,
} from '../payload-types.js';
import { createExecutorClient } from '../services/feathers-client.js';
import type { CommandOptions } from './index.js';

const MAX_OUTPUT_LINES = ENVIRONMENT.LOGS_MAX_LINES;
const ENVIRONMENT_RESULT_PREFIX = 'AGOR_ENVIRONMENT_RESULT=';
const MAX_ENVIRONMENT_RESULT_BYTES = 8 * 1024;

function stripEnvironmentResultLines(output: string): string {
  return output
    .split('\n')
    .filter((line) => !line.startsWith(ENVIRONMENT_RESULT_PREFIX))
    .join('\n');
}

/**
 * Extract the deliberately tiny, non-secret result protocol emitted by a
 * repository lifecycle command. The line is removed from persisted command
 * output; it may contain public/private app locations, never credentials.
 */
export function parseEnvironmentCommandOutput(output: string): {
  output: string;
  environmentResult?: EnvironmentLifecycleResult;
} {
  const resultLines: string[] = [];
  const visibleLines: string[] = [];

  for (const line of output.split('\n')) {
    if (line.startsWith(ENVIRONMENT_RESULT_PREFIX)) {
      resultLines.push(line.slice(ENVIRONMENT_RESULT_PREFIX.length));
    } else {
      visibleLines.push(line);
    }
  }

  if (resultLines.length === 0) return { output };
  if (resultLines.length !== 1) {
    throw new Error('environment command emitted more than one result line');
  }

  const encoded = resultLines[0];
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ENVIRONMENT_RESULT_BYTES) {
    throw new Error('environment command result exceeds the size limit');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    throw new Error('environment command emitted invalid result JSON');
  }

  return {
    output: visibleLines.join('\n'),
    environmentResult: validateEnvironmentLifecycleResult(decoded),
  };
}

export function startCompletionWithoutContinuousHealth(
  healthCheckUrl: string | undefined,
  timestamp: string
): Record<string, unknown> {
  if (healthCheckUrl) return {};
  return {
    status: 'running',
    last_health_check: {
      timestamp,
      status: 'unknown',
      message: 'Start command completed; health is unavailable',
    },
  };
}

function truncateOutput(outputChunks: string[]): string | undefined {
  const fullOutput = outputChunks.join('');
  const lines = fullOutput.split('\n');
  const truncated =
    lines.length > MAX_OUTPUT_LINES
      ? `... (truncated ${lines.length - MAX_OUTPUT_LINES} lines)\n${lines
          .slice(-MAX_OUTPUT_LINES)
          .join('\n')}`
      : fullOutput;
  const output = truncated.trim();
  return output || undefined;
}

function collectOutput(
  child: ChildProcess,
  outputChunks: string[],
  suppressEnvironmentResult: boolean
): void {
  const collect = (stream: NodeJS.ReadableStream | null, target: NodeJS.WriteStream) => {
    if (!stream) return;
    let visibleBuffer = '';
    stream.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      outputChunks.push(text);
      if (!suppressEnvironmentResult) {
        target.write(text);
        return;
      }
      visibleBuffer += text;
      const lines = visibleBuffer.split('\n');
      visibleBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith(ENVIRONMENT_RESULT_PREFIX)) target.write(`${line}\n`);
      }
    });
    stream.on('end', () => {
      if (visibleBuffer && !visibleBuffer.startsWith(ENVIRONMENT_RESULT_PREFIX)) {
        target.write(visibleBuffer);
      }
    });
  };
  collect(child.stdout, process.stdout);
  collect(child.stderr, process.stderr);
}

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
  }
}

function isCurrentStartAttempt(
  branch: Pick<Branch, 'environment_instance'>,
  attemptId: string | undefined
): boolean {
  const status = branch.environment_instance?.status;
  return (
    Boolean(attemptId) &&
    branch.environment_instance?.process?.attempt_id === attemptId &&
    (status === 'starting' || status === 'running')
  );
}

function commandForAction(payload: EnvironmentLifecyclePayload): string {
  switch (payload.params.action) {
    case 'start':
      return payload.params.startCommand!;
    case 'stop':
      return payload.params.stopCommand!;
    case 'nuke':
      return payload.params.nukeCommand!;
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
}): Promise<{ pid?: number; output?: string; environmentResult?: EnvironmentLifecycleResult }> {
  const { command, cwd, env, commandType } = options;
  assertEnvCommandAllowed(command, commandType);

  const child = spawn(command, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stdio: 'pipe',
    shell: true,
  });

  const outputChunks: string[] = [];
  collectOutput(child, outputChunks, commandType === 'start');

  await new Promise<void>((resolve, reject) => {
    child.on('exit', (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        const message =
          code === null
            ? `${commandType} command exited without a code`
            : `${commandType} command exited with code ${code}`;
        const error = new Error(message) as Error & { output?: string; pid?: number };
        const rawOutput = outputChunks.join('');
        error.output = truncateOutput([
          commandType === 'start' ? stripEnvironmentResultLines(rawOutput) : rawOutput,
        ]);
        error.pid = child.pid;
        reject(error);
      }
    });
    child.on('error', (error: Error) => {
      const enriched = error as Error & { output?: string; pid?: number };
      const rawOutput = outputChunks.join('');
      enriched.output = truncateOutput([
        commandType === 'start' ? stripEnvironmentResultLines(rawOutput) : rawOutput,
      ]);
      enriched.pid = child.pid;
      reject(enriched);
    });
  });

  const rawOutput = outputChunks.join('');
  const parsed =
    commandType === 'start'
      ? parseEnvironmentCommandOutput(rawOutput)
      : { output: rawOutput, environmentResult: undefined };
  return {
    pid: child.pid,
    output: truncateOutput([parsed.output]),
    environmentResult: parsed.environmentResult,
  };
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
      const isStart = payload.params.action === 'start';
      if (isStart && !isCurrentStartAttempt(branch, payload.params.lifecycleAttemptId)) {
        return {
          success: true,
          data: { branchId, action: payload.params.action, stale: true },
        };
      }
      const startedAt =
        (isStart ? branch.environment_instance?.process?.started_at : undefined) ??
        new Date().toISOString();
      if (!isStart) {
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
          health_url: null,
          access_urls: payload.params.appUrl ? [{ name: 'App', url: payload.params.appUrl }] : null,
        });
      }

      const result = await runShellCommand({
        command: payload.params.startCommand!,
        cwd,
        env: payload.env,
        commandType: 'start',
      });

      const accessUrls = result.environmentResult?.app
        ? [{ name: 'App', url: result.environmentResult.app }]
        : payload.params.appUrl
          ? [{ name: 'App', url: payload.params.appUrl }]
          : undefined;
      const effectiveHealthUrl = result.environmentResult?.health ?? payload.params.healthCheckUrl;
      const commandCompletedAt = new Date().toISOString();

      const current = await client.service('branches').get(branchId);
      if (isStart && !isCurrentStartAttempt(current, payload.params.lifecycleAttemptId)) {
        return {
          success: true,
          data: { branchId, action: payload.params.action, stale: true },
        };
      }

      await updateBranchEnvironment(client, branchId, {
        ...startCompletionWithoutContinuousHealth(effectiveHealthUrl, commandCompletedAt),
        process: {
          ...(current.environment_instance?.process ?? {}),
          pid: result.pid,
          started_at: startedAt,
        },
        health_url: result.environmentResult?.health ?? null,
        access_urls: accessUrls ?? null,
        last_command: {
          action: payload.params.action,
          status: 'succeeded',
          timestamp: commandCompletedAt,
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
      health_url: null,
      access_urls: payload.params.appUrl ? [{ name: 'App', url: payload.params.appUrl }] : null,
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
      const staleStartFailure =
        payload.params.action === 'start' &&
        !isCurrentStartAttempt(current, payload.params.lifecycleAttemptId);
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
