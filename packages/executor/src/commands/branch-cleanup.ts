import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { cleanIgnoredWorkspace } from '@agor/core/git';
import { BRANCH_CLEANUP_TIMEOUT_MS, DEFAULT_BRANCH_CLEANUP_COMMAND } from '@agor/core/types';
import type { BranchArchivePayload, BranchCleanPayload, ExecutorResult } from '../payload-types.js';
import { runBoundedEnvironmentShell } from './environment-shell.js';
import type { CommandOptions } from './index.js';

/** Executor-side filesystem cycle, shared inline by standalone cleanup and archive.
 * Results require the launch owner's process-containment proof before DB settlement.
 * Neither path calls another daemon cleanup operation or acquires another fence.
 */
async function runCleanup(
  payload: BranchCleanPayload | BranchArchivePayload
): Promise<ExecutorResult> {
  const { cleanup, cwd } = payload.params;
  if (!cleanup) return { success: true };
  const identity = { operationId: cleanup.operationId, generation: cleanup.generation };
  if (payload.executorMode !== 'request' || !payload.executorResponse) {
    return {
      success: false,
      error: {
        code: 'CLEANUP_SUPERVISION_REQUIRED',
        message: 'Cleanup requires an authenticated contained request',
      },
    };
  }
  try {
    // No mkdir fallback and no symlink-root substitution for a missing mount.
    if (!isAbsolute(cwd) || !(await lstat(cwd)).isDirectory()) throw new Error('Unavailable');
  } catch {
    return {
      success: false,
      data: identity,
      error: {
        code: 'CLEANUP_WORKSPACE_UNAVAILABLE',
        message: 'The branch workspace is unavailable',
      },
    };
  }
  try {
    if (cleanup.command === DEFAULT_BRANCH_CLEANUP_COMMAND) {
      await cleanIgnoredWorkspace(cwd, BRANCH_CLEANUP_TIMEOUT_MS);
    } else {
      const result = await runBoundedEnvironmentShell({
        command: cleanup.command,
        action: 'cleanup',
        cwd,
        deadline: Date.now() + BRANCH_CLEANUP_TIMEOUT_MS,
        containment: 'executor',
        // Raw output is never retained, logged, or returned across the boundary.
        output: { append() {} },
      });
      if (result.outcome !== 'succeeded') {
        return {
          success: false,
          data: identity,
          error: {
            code: result.outcome === 'unknown' ? 'CLEANUP_INTERRUPTED' : 'CLEANUP_COMMAND_FAILED',
            message: 'Cleanup did not complete successfully; files may already have changed',
          },
        };
      }
    }
    return { success: true, data: identity };
  } catch {
    return {
      success: false,
      data: identity,
      error: {
        code: 'CLEANUP_COMMAND_FAILED',
        message: 'Cleanup did not complete successfully; files may already have changed',
      },
    };
  }
}

export function handleBranchClean(
  payload: BranchCleanPayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun)
    return Promise.resolve({
      success: false,
      error: {
        code: 'CLEANUP_PREVIEW_UNSUPPORTED',
        message: 'Cleanup has no filesystem preview operation',
      },
    });
  return runCleanup(payload);
}

export function handleBranchArchive(
  payload: BranchArchivePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun)
    return Promise.resolve({
      success: false,
      error: {
        code: 'CLEANUP_PREVIEW_UNSUPPORTED',
        message: 'Cleanup has no filesystem preview operation',
      },
    });
  // Metadata remains daemon-owned. No optional cleanup means no filesystem action.
  return runCleanup(payload);
}
