import type { ExecutorCommandResult } from '@agor/core/executor-protocol';
import { Conflict } from '@agor/core/feathers';
import { type BranchID, EXECUTOR_LAUNCH_REFUSED_MESSAGE } from '@agor/core/types';

// Only reviewed categories reach the caller: launcher/OS error text can contain
// credentials, commands or paths. A failed probe is never proof of absent files.
const failureReasons: Readonly<Record<string, string>> = {
  EXECUTOR_TIMEOUT: 'The filesystem executor did not respond in time. Check executor connectivity.',
  EXECUTOR_LAUNCH_REFUSED: EXECUTOR_LAUNCH_REFUSED_MESSAGE,
  EXECUTOR_SPAWN_ERROR:
    'The filesystem executor could not start. Check launcher configuration and execution identity.',
  EXECUTOR_RESPONSE_UNSUPPORTED:
    'The launcher does not support filesystem status responses. Check the executor response configuration.',
  UNKNOWN_COMMAND:
    'The executor does not support filesystem status. Check daemon/executor version compatibility.',
  BRANCH_FILESYSTEM_STATUS_FAILED:
    'The executor could not inspect the branch checkout. Check execution identity, file access and storage mounts.',
};

/** Read-only admission check, before archive metadata or destructive dispatch. */
export async function verifyBranchWorkspacePreflight(
  branchId: BranchID,
  probe: () => Promise<ExecutorCommandResult>
): Promise<void> {
  function fail(reason: string): never {
    throw new Conflict(
      `${reason} No archive or file changes were made by this request. ` +
        'To archive without touching files, choose Archive → Leave untouched (filesystemAction: preserved).'
    );
  }
  let status: ExecutorCommandResult;
  try {
    status = await probe();
  } catch {
    fail(
      'The filesystem executor could not be reached. Check executor connectivity and launcher configuration.'
    );
  }
  if (!status || typeof status !== 'object' || typeof status.success !== 'boolean') {
    fail(
      'The executor returned an invalid status response. Check daemon/executor version compatibility.'
    );
  }
  if (!status.success) {
    fail(
      (status.error?.code &&
        Object.hasOwn(failureReasons, status.error.code) &&
        failureReasons[status.error.code]) ||
        'The filesystem executor failed to return a usable status. Check executor connectivity, identity and storage mounts.'
    );
  }
  const data = status.data;
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !('branchId' in data) ||
    data.branchId !== branchId ||
    !('exists' in data) ||
    typeof data.exists !== 'boolean' ||
    !('kind' in data) ||
    typeof data.kind !== 'string' ||
    (data.exists ? !['directory', 'file', 'other'].includes(data.kind) : data.kind !== 'missing')
  ) {
    fail(
      'The executor returned an invalid filesystem status. Check daemon/executor version compatibility.'
    );
  }
  if (!data.exists) {
    fail(
      'The branch checkout directory is not visible to the executor. It may be missing or its storage may not be mounted.'
    );
  }
  if (data.kind !== 'directory') {
    fail('The branch checkout path is not a directory. Check the branch storage location.');
  }
}
