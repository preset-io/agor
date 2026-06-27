import { BadRequest } from '@agor/core/feathers';
import {
  addToBranchGroupAction,
  cleanupBrokenSymlinksAction,
  createBranchGroupAction,
  createBranchSymlinkAction,
  createBufferedReporter,
  deleteBranchGroupAction,
  deleteUnixUserAction,
  ensureUnixUserAction,
  type LocalActionResult,
  removeBranchSymlinkAction,
  removeFromBranchGroupAction,
  scrubGitRemotesAction,
} from '@agor/core/local-actions';
import type { Params } from '@agor/core/types';
import { AGOR_HOME_BASE } from '@agor/core/unix';

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

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequest(`Missing required string param: ${key}`);
  }
  return value;
}

function getManagedHomeBase(params: Record<string, unknown>): string | undefined {
  const value = params.homeBase;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value !== AGOR_HOME_BASE) {
    throw new BadRequest(`homeBase must be the managed Agor home base: ${AGOR_HOME_BASE}`);
  }
  return value;
}

export function createLocalActionsService() {
  return {
    async create(data: LocalActionRequest, _params?: Params): Promise<LocalActionResult> {
      const reporter = createBufferedReporter();
      const actionParams = data.params ?? {};
      const common = { dryRun: !!data.dryRun, verbose: !!data.verbose, reporter };

      switch (data.action) {
        case 'unix.group.createBranch':
          await createBranchGroupAction({
            ...common,
            branchId: requireString(actionParams, 'branchId'),
          });
          break;
        case 'unix.group.deleteBranch':
          await deleteBranchGroupAction({
            ...common,
            group: requireString(actionParams, 'group'),
          });
          break;
        case 'unix.group.addUser':
          await addToBranchGroupAction({
            ...common,
            username: requireString(actionParams, 'username'),
            group: requireString(actionParams, 'group'),
          });
          break;
        case 'unix.group.removeUser':
          await removeFromBranchGroupAction({
            ...common,
            username: requireString(actionParams, 'username'),
            group: requireString(actionParams, 'group'),
          });
          break;
        case 'unix.user.ensure':
          await ensureUnixUserAction({
            ...common,
            username: requireString(actionParams, 'username'),
            homeBase: getManagedHomeBase(actionParams),
          });
          break;
        case 'unix.user.delete':
          await deleteUnixUserAction({
            ...common,
            username: requireString(actionParams, 'username'),
            deleteHome: actionParams.deleteHome === true,
          });
          break;
        case 'unix.symlink.create':
          await createBranchSymlinkAction({
            ...common,
            username: requireString(actionParams, 'username'),
            branchName: requireString(actionParams, 'branchName'),
            branchPath: requireString(actionParams, 'branchPath'),
            homeBase: getManagedHomeBase(actionParams),
          });
          break;
        case 'unix.symlink.remove':
          await removeBranchSymlinkAction({
            ...common,
            username: requireString(actionParams, 'username'),
            branchName: requireString(actionParams, 'branchName'),
            homeBase: getManagedHomeBase(actionParams),
          });
          break;
        case 'unix.symlink.cleanupBroken':
          await cleanupBrokenSymlinksAction({
            ...common,
            username: requireString(actionParams, 'username'),
            homeBase: getManagedHomeBase(actionParams),
          });
          break;
        case 'git.remoteCredentials.scrubManaged':
          await scrubGitRemotesAction({
            ...common,
            write: actionParams.write === true,
          });
          break;
        default:
          throw new BadRequest(
            `Unsupported local action: ${(data as { action?: unknown }).action}`
          );
      }

      return { logs: reporter.logs };
    },
  };
}
