import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  BRANCH_CLEANUP_COMMAND,
  BRANCH_CLEANUP_REPORT_SERVICE,
  BRANCH_CLEANUP_TIMEOUT_MS,
  type BranchWorkspaceReportAction,
  DEFAULT_BRANCH_CLEANUP_COMMAND,
} from '@agor/core/types';
import { cleanIgnoredWorkspace, removeBranchWorkspace } from '@agor/git';
import type { BranchArchivePayload, BranchCleanPayload, ExecutorResult } from '../payload-types.js';
import type { CommandOptions } from './index.js';

type Outcome = 'succeeded' | 'failed' | 'unknown';

/** Shared inline filesystem cycle. No nested dispatch or second maintenance claim. */
export async function runBranchWorkspaceFiles(
  payload: BranchCleanPayload | BranchArchivePayload
): Promise<Outcome> {
  const p = payload.params;
  if (Date.now() >= p.deadlineAt) return 'failed';
  if (p.filesystemAction === 'deleted') {
    // The fixed storage owner runs outside the victim's branch-shell mount,
    // exactly like permanent deletion. No arbitrary command is allowed here.
    if (payload.command === BRANCH_CLEANUP_COMMAND) return 'failed';
    try {
      await removeBranchWorkspace(p.removal);
    } catch {
      return 'unknown';
    }
  } else {
    // Process-group disappearance cannot certify detached descendants. Until
    // the substrate provides that proof, never start custom cleanup commands.
    if (p.cleanup.command !== DEFAULT_BRANCH_CLEANUP_COMMAND) return 'failed';
    try {
      if (!isAbsolute(p.cwd) || !(await lstat(p.cwd)).isDirectory()) return 'failed';
    } catch {
      return 'failed';
    }
    try {
      await cleanIgnoredWorkspace(
        p.cwd,
        Math.min(BRANCH_CLEANUP_TIMEOUT_MS, p.deadlineAt - Date.now())
      );
    } catch {
      // A timed-out Git invocation is not certified stopped by an exception.
      return 'unknown';
    }
  }
  return 'succeeded';
}

/** The executor owns sequencing and bounded reporting; daemon restarts do not replay commands. */
async function run(
  payload: BranchCleanPayload | BranchArchivePayload,
  options: CommandOptions
): Promise<ExecutorResult> {
  if (options.dryRun)
    return {
      success: false,
      error: {
        code: 'CLEANUP_PREVIEW_UNSUPPORTED',
        message: 'Cleanup has no filesystem preview operation',
      },
    };
  const p = payload.params;
  const report = async (action: BranchWorkspaceReportAction) => {
    const response = await fetch(
      `${payload.daemonUrl.replace(/\/$/, '')}/${BRANCH_CLEANUP_REPORT_SERVICE}`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${payload.sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          branch_id: p.branchId,
          operation_id: p.operationId,
          generation: p.generation,
          execution_id: p.executionId,
          action,
        }),
      }
    );
    if (!response.ok) throw new Error('Workspace report rejected');
    const result = (await response.json()) as { ok?: boolean };
    if (result.ok !== true) throw new Error('Workspace report was not acknowledged');
  };
  try {
    await report('claim');
  } catch {
    return {
      success: false,
      error: {
        code: 'CLEANUP_NOT_CLAIMED',
        message: 'Workspace invocation was not acknowledged; no command was started',
      },
    };
  }
  let outcome: Outcome;
  try {
    outcome = await runBranchWorkspaceFiles(payload);
  } catch {
    outcome = 'unknown';
  }
  try {
    await report(outcome);
  } catch {
    return {
      success: false,
      error: {
        code: 'CLEANUP_REPORT_UNKNOWN',
        message: 'Workspace result could not be confirmed; reconciliation is required',
      },
    };
  }
  return outcome === 'succeeded'
    ? { success: true }
    : {
        success: false,
        error: {
          code: outcome === 'failed' ? 'CLEANUP_COMMAND_FAILED' : 'CLEANUP_OUTCOME_UNKNOWN',
          message:
            outcome === 'failed'
              ? 'Workspace command failed; files may already have changed'
              : 'Workspace command outcome is unknown; the branch remains fenced',
        },
      };
}
export const handleBranchClean = (payload: BranchCleanPayload, options: CommandOptions) =>
  run(payload, options);
export const handleBranchArchive = (payload: BranchArchivePayload, options: CommandOptions) =>
  run(payload, options);
