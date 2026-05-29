/**
 * Codex cost estimation via the ccusage CLI.
 *
 * ccusage's current Codex support lives in its native CLI, not a stable JS
 * library surface, so Agor shells out defensively and treats failures as
 * "cost unavailable" rather than task-fatal errors.
 */

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Task } from '@agor/core/types';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const CCUSAGE_TIMEOUT_MS = 20_000;
const CCUSAGE_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

type CodexTaskLike = Pick<Task, 'task_id' | 'normalized_sdk_response'>;

interface CodexCcusageSessionSummary {
  sessionId?: string;
  sessionFile?: string;
  costUSD?: number | null;
}

interface CodexCcusageSessionReport {
  sessions?: CodexCcusageSessionSummary[];
}

function getCcusageCliPath(): string {
  const packageJsonPath = require.resolve('ccusage/package.json');
  return join(dirname(packageJsonPath), 'dist', 'cli.js');
}

function matchesSdkSessionId(value: string | undefined, sdkSessionId: string): boolean {
  if (!value) return false;
  return (
    value.endsWith(`/${sdkSessionId}.jsonl`) ||
    value.endsWith(`-${sdkSessionId}.jsonl`) ||
    value.includes(sdkSessionId)
  );
}

export function findCodexCcusageSession(
  report: CodexCcusageSessionReport,
  sdkSessionId: string
): CodexCcusageSessionSummary | undefined {
  return report.sessions?.find(
    (session) =>
      matchesSdkSessionId(session.sessionId, sdkSessionId) ||
      matchesSdkSessionId(session.sessionFile, sdkSessionId)
  );
}

function taskHasUsage(task: CodexTaskLike): boolean {
  return (task.normalized_sdk_response?.tokenUsage.totalTokens || 0) > 0;
}

export function previousCodexCostsAreReliable(previousTasks: CodexTaskLike[]): boolean {
  return previousTasks.every((task) => {
    if (!taskHasUsage(task)) return true;
    return task.normalized_sdk_response?.costUsd !== undefined;
  });
}

export function deriveCodexTaskCostUsd(
  sessionCostUsd: number,
  previousTasks: CodexTaskLike[]
): number | undefined {
  if (!Number.isFinite(sessionCostUsd) || sessionCostUsd < 0) return undefined;
  if (!previousCodexCostsAreReliable(previousTasks)) return undefined;

  const previousCostUsd = previousTasks.reduce(
    (sum, task) => sum + (task.normalized_sdk_response?.costUsd || 0),
    0
  );
  const delta = sessionCostUsd - previousCostUsd;

  // Small negative values can happen due to floating-point rounding; clamp
  // them away. Larger negatives indicate a mismatch between Agor's prior task
  // accounting and ccusage's session total, so treat that as unreliable.
  if (delta < -1e-6) return undefined;
  return Math.max(0, delta);
}

export async function estimateCodexTaskCostUsd(params: {
  sdkSessionId?: string | null;
  previousTasks: CodexTaskLike[];
  env?: NodeJS.ProcessEnv;
  execFileImpl?: typeof execFileAsync;
}): Promise<number | undefined> {
  const { sdkSessionId, previousTasks } = params;
  if (!sdkSessionId) return undefined;
  if (!previousCodexCostsAreReliable(previousTasks)) return undefined;

  const runExecFile = params.execFileImpl || execFileAsync;

  try {
    const cliPath = getCcusageCliPath();
    const { stdout } = await runExecFile(
      process.execPath,
      [cliPath, 'codex', 'session', '--json', '--offline'],
      {
        env: {
          ...process.env,
          ...params.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
        timeout: CCUSAGE_TIMEOUT_MS,
        maxBuffer: CCUSAGE_MAX_BUFFER_BYTES,
      }
    );

    if (!stdout) return undefined;

    const parsed = JSON.parse(stdout) as CodexCcusageSessionReport;
    const sessionSummary = findCodexCcusageSession(parsed, sdkSessionId);
    if (!sessionSummary || sessionSummary.costUSD == null) return undefined;

    return deriveCodexTaskCostUsd(sessionSummary.costUSD, previousTasks);
  } catch (error) {
    console.warn(`[codex] ccusage cost estimation failed: ${String(error)}`);
    return undefined;
  }
}
