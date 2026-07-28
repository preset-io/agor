import type { LocalActionResult } from '@agor/core/local-actions';

export interface HostOperationOptions {
  dryRun: boolean;
  verbose: boolean;
}
export interface CellHostIdentityOperations {
  createBranchGroup(input: HostOperationOptions & { branchId: string }): Promise<LocalActionResult>;
  deleteBranchGroup(input: HostOperationOptions & { group: string }): Promise<LocalActionResult>;
  addUserToGroup(
    input: HostOperationOptions & { username: string; group: string }
  ): Promise<LocalActionResult>;
  removeUserFromGroup(
    input: HostOperationOptions & { username: string; group: string }
  ): Promise<LocalActionResult>;
  ensureUser(
    input: HostOperationOptions & { username: string; homeBase?: string }
  ): Promise<LocalActionResult>;
  deleteUser(
    input: HostOperationOptions & { username: string; deleteHome: boolean }
  ): Promise<LocalActionResult>;
}
export interface CellHostMaintenanceOperations {
  createHomeSymlink(
    input: HostOperationOptions & {
      username: string;
      branchName: string;
      branchPath: string;
      homeBase?: string;
    }
  ): Promise<LocalActionResult>;
  removeHomeSymlink(
    input: HostOperationOptions & { username: string; branchName: string; homeBase?: string }
  ): Promise<LocalActionResult>;
  cleanupHomeSymlinks(
    input: HostOperationOptions & { username: string; homeBase?: string }
  ): Promise<LocalActionResult>;
  scrubManagedGitRemotes(
    input: HostOperationOptions & { write: boolean }
  ): Promise<LocalActionResult>;
}
export interface CellHostOperations {
  identity: CellHostIdentityOperations;
  maintenance: CellHostMaintenanceOperations;
}
