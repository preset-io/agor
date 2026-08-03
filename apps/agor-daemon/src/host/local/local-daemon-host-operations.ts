import {
  addToBranchGroupAction,
  createBranchGroupAction,
  createBufferedReporter,
  deleteBranchGroupAction,
  deleteUnixUserAction,
  ensureUnixUserAction,
  removeFromBranchGroupAction,
} from '@agor/core/local-actions/identity';
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
  };
}
