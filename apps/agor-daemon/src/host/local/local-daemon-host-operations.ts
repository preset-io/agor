import {
  addToBranchGroupAction,
  cleanupBrokenSymlinksAction,
  createBranchGroupAction,
  createBranchSymlinkAction,
  createBufferedReporter,
  deleteBranchGroupAction,
  deleteUnixUserAction,
  ensureUnixUserAction,
  removeBranchSymlinkAction,
  removeFromBranchGroupAction,
  scrubGitRemotesAction,
} from '@agor/core/local-actions';
import type { DaemonHostOperations, HostOperationOptions } from '../operations.js';

function invoke<T extends HostOperationOptions>(
  action: (input: T & { reporter: ReturnType<typeof createBufferedReporter> }) => Promise<void>,
  input: T
) {
  const reporter = createBufferedReporter();
  return action({ ...input, reporter }).then(() => ({ logs: reporter.logs }));
}
export function createLocalDaemonHostOperations(): DaemonHostOperations {
  return {
    identity: {
      createBranchGroup: (input) => invoke(createBranchGroupAction, input),
      deleteBranchGroup: (input) => invoke(deleteBranchGroupAction, input),
      addUserToGroup: (input) => invoke(addToBranchGroupAction, input),
      removeUserFromGroup: (input) => invoke(removeFromBranchGroupAction, input),
      ensureUser: (input) => invoke(ensureUnixUserAction, input),
      deleteUser: (input) => invoke(deleteUnixUserAction, input),
    },
    maintenance: {
      createHomeSymlink: (input) => invoke(createBranchSymlinkAction, input),
      removeHomeSymlink: (input) => invoke(removeBranchSymlinkAction, input),
      cleanupHomeSymlinks: (input) => invoke(cleanupBrokenSymlinksAction, input),
      scrubManagedGitRemotes: (input) => invoke(scrubGitRemotesAction, input),
    },
  };
}
