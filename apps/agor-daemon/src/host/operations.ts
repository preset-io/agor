export interface HostOperationOptions {
  dryRun: boolean;
  verbose: boolean;
}
export interface DaemonHostOperationResult {
  logs: string[];
}
export interface DaemonHostIdentityOperations {
  createBranchGroup(
    input: HostOperationOptions & { branchId: string }
  ): Promise<DaemonHostOperationResult>;
  deleteBranchGroup(
    input: HostOperationOptions & { group: string }
  ): Promise<DaemonHostOperationResult>;
  addUserToGroup(
    input: HostOperationOptions & { username: string; group: string }
  ): Promise<DaemonHostOperationResult>;
  removeUserFromGroup(
    input: HostOperationOptions & { username: string; group: string }
  ): Promise<DaemonHostOperationResult>;
  ensureUser(
    input: HostOperationOptions & { username: string; homeBase?: string }
  ): Promise<DaemonHostOperationResult>;
  deleteUser(
    input: HostOperationOptions & { username: string; deleteHome: boolean }
  ): Promise<DaemonHostOperationResult>;
}
export interface DaemonHostOperations {
  identity: DaemonHostIdentityOperations;
}
