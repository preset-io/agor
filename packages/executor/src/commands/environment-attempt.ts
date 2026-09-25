import { constants } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeEnvironmentLifecycleResult,
  type EnvironmentLifecycleResult,
} from '@agor/core/environment/lifecycle-result';
import {
  type BranchID,
  ENVIRONMENT_COMMAND_REPORT_SERVICE,
  type EnvironmentCommandReport,
} from '@agor/core/types';
import type { EnvironmentLifecyclePayload, ExecutorResult } from '../payload-types.js';
import { EnvironmentCommandOutputCapture } from './environment-command-output.js';
import { runBoundedEnvironmentShell } from './environment-shell.js';

/** Each HTTP request authenticates independently and may reach any replica. */
async function report(
  payload: EnvironmentLifecyclePayload,
  data: EnvironmentCommandReport,
  deadline: number
) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Environment report deadline expired');
  const response = await fetch(
    `${payload.daemonUrl!.replace(/\/$/, '')}/${ENVIRONMENT_COMMAND_REPORT_SERVICE}`,
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(5000, remaining)),
      headers: {
        Authorization: `Bearer ${payload.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    }
  );
  if (!response.ok) throw new Error(`Environment report rejected (HTTP ${response.status})`);
  return response.json() as Promise<{ command_deadline: string; result_deadline: string }>;
}

export async function handleEnvironmentAttempt(
  payload: EnvironmentLifecyclePayload
): Promise<ExecutorResult> {
  const attempt = payload.params.attempt;
  const action = payload.params.action;
  const scope = { branch_id: payload.params.branchId as BranchID, attempt_id: attempt.id, action };
  // Never run after a failed, duplicate, late, or unacknowledged claim.
  const claimed = await report(
    payload,
    { ...scope, kind: 'claim' },
    Date.parse(attempt.claimDeadline)
  );
  const deadline = Math.min(
    Date.parse(claimed.command_deadline),
    Date.parse(attempt.commandDeadline)
  );
  const resultDeadline = Math.min(
    Date.parse(claimed.result_deadline),
    Date.parse(attempt.resultDeadline)
  );
  const output = new EnvironmentCommandOutputCapture({
    parseEnvironmentResult: action === 'start',
  });
  let directory: string | undefined;
  let sequence = 0;
  let progress: Promise<unknown> | undefined;
  const progressTimer = setInterval(() => {
    if (progress) return;
    progress = report(
      payload,
      {
        ...scope,
        kind: 'output',
        sequence: ++sequence,
        output: output.text(),
        truncated: output.truncated,
      },
      resultDeadline
    )
      .catch(() => undefined)
      .finally(() => {
        progress = undefined;
      });
  }, 2000);
  let outcome: 'succeeded' | 'failed' | 'unknown' = 'failed';
  let message = 'Command setup failed';
  let lifecycleResult: EnvironmentLifecycleResult | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'agor-environment-'));
    const resultFile = join(directory, 'result.json');
    const result = await runBoundedEnvironmentShell({
      command: (action === 'start'
        ? payload.params.startCommand
        : action === 'stop'
          ? payload.params.stopCommand
          : payload.params.nukeCommand)!,
      action,
      cwd: payload.params.branchPath!,
      env: { ...payload.env, AGOR_ENVIRONMENT_RESULT_FILE: resultFile },
      deadline,
      onStdout: (chunk) => output.writeStdout(chunk),
      onStderr: (chunk) => output.writeStderr(chunk),
    });
    outcome = result.outcome;
    message = result.message;
    let stdoutResult: EnvironmentLifecycleResult | undefined;
    try {
      stdoutResult = output.finish().environmentResult;
    } catch {
      if (outcome === 'succeeded') {
        outcome = 'unknown';
        message =
          'Command exited successfully but its stdout result was invalid; remote outcome is unknown';
      }
    }
    if (outcome === 'succeeded' && action === 'start') {
      try {
        const file = await open(
          resultFile,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 16384)
            throw new Error('Invalid environment result file');
          const buffer = Buffer.alloc(16385);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 16384) throw new Error('Environment result file too large');
          const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
          if (stdoutResult) throw new Error('Multiple environment command results');
          // The exact same strict decoder is checked again at daemon admission.
          lifecycleResult = decodeEnvironmentLifecycleResult(value);
        } finally {
          await file.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          lifecycleResult = stdoutResult;
        } else {
          outcome = 'unknown';
          message =
            'Command exited successfully but its result file was invalid; remote outcome is unknown';
          lifecycleResult = undefined;
        }
      }
    }
  } catch {
    outcome = 'unknown';
    message = 'Command execution failed; remote outcome is unknown';
  } finally {
    clearInterval(progressTimer);
    await progress;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
  const completion: EnvironmentCommandReport = {
    ...scope,
    kind: 'result',
    outcome,
    message,
    output: output.text(),
    truncated: output.truncated,
    ...(lifecycleResult ? { lifecycle_result: lifecycleResult } : {}),
  };
  // Retry only report delivery, never the command. First durable settlement wins.
  while (Date.now() < resultDeadline) {
    try {
      await report(payload, completion, resultDeadline);
      return { success: outcome === 'succeeded' };
    } catch {
      if (Date.now() < resultDeadline) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return {
    success: false,
    error: {
      code: 'ENVIRONMENT_REPORT_LOST',
      message:
        'Command result could not be delivered before its deadline; outcome will be reported as unknown',
    },
  };
}
