import { BadRequest } from '@agor/core/feathers';
import type { Params } from '@agor/core/types';
import { AGOR_HOME_BASE } from '@agor/core/unix';
import type { DaemonHostOperationResult, DaemonHostOperations } from '../host/operations.js';

export type LocalActionName =
  | 'unix.group.createBranch'
  | 'unix.group.deleteBranch'
  | 'unix.group.addUser'
  | 'unix.group.removeUser'
  | 'unix.user.ensure'
  | 'unix.user.delete'
  | 'unix.symlink.create'
  | 'unix.symlink.remove'
  | 'unix.symlink.cleanupBroken'
  | 'git.remoteCredentials.scrubManaged';
export interface LocalActionRequest {
  action: LocalActionName;
  params?: Record<string, unknown>;
  dryRun?: boolean;
  verbose?: boolean;
}
function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequest(`Missing required string param: ${key}`);
  return value;
}
function homeBase(params: Record<string, unknown>): string | undefined {
  if (params.homeBase === undefined) return undefined;
  if (params.homeBase !== AGOR_HOME_BASE)
    throw new BadRequest(`homeBase must be the managed Agor home base: ${AGOR_HOME_BASE}`);
  return AGOR_HOME_BASE;
}
export function createLocalActionsService(host: DaemonHostOperations) {
  return {
    async create(data: LocalActionRequest, _params?: Params): Promise<DaemonHostOperationResult> {
      const p = data.params ?? {};
      const options = { dryRun: data.dryRun === true, verbose: data.verbose === true };
      switch (data.action) {
        case 'unix.group.createBranch':
          return host.identity.createBranchGroup({
            ...options,
            branchId: stringParam(p, 'branchId'),
          });
        case 'unix.group.deleteBranch':
          return host.identity.deleteBranchGroup({ ...options, group: stringParam(p, 'group') });
        case 'unix.group.addUser':
          return host.identity.addUserToGroup({
            ...options,
            username: stringParam(p, 'username'),
            group: stringParam(p, 'group'),
          });
        case 'unix.group.removeUser':
          return host.identity.removeUserFromGroup({
            ...options,
            username: stringParam(p, 'username'),
            group: stringParam(p, 'group'),
          });
        case 'unix.user.ensure':
          return host.identity.ensureUser({
            ...options,
            username: stringParam(p, 'username'),
            homeBase: homeBase(p),
          });
        case 'unix.user.delete':
          return host.identity.deleteUser({
            ...options,
            username: stringParam(p, 'username'),
            deleteHome: p.deleteHome === true,
          });
        case 'unix.symlink.create':
          return host.maintenance.createHomeSymlink({
            ...options,
            username: stringParam(p, 'username'),
            branchName: stringParam(p, 'branchName'),
            branchPath: stringParam(p, 'branchPath'),
            homeBase: homeBase(p),
          });
        case 'unix.symlink.remove':
          return host.maintenance.removeHomeSymlink({
            ...options,
            username: stringParam(p, 'username'),
            branchName: stringParam(p, 'branchName'),
            homeBase: homeBase(p),
          });
        case 'unix.symlink.cleanupBroken':
          return host.maintenance.cleanupHomeSymlinks({
            ...options,
            username: stringParam(p, 'username'),
            homeBase: homeBase(p),
          });
        case 'git.remoteCredentials.scrubManaged':
          return host.maintenance.scrubManagedGitRemotes({ ...options, write: p.write === true });
        default:
          throw new BadRequest(
            `Unsupported local action: ${(data as { action?: unknown }).action}`
          );
      }
    },
  };
}
