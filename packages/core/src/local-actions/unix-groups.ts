import type { BranchID } from '../types/index.js';
import {
  createAdminExecutor,
  generateBranchGroupName,
  isValidBranchGroupName,
  UnixGroupCommands,
} from '../unix/index.js';
import { getReporter, type LocalActionOptions } from './types.js';

export interface CreateBranchGroupParams extends LocalActionOptions {
  branchId: string;
}

export async function createBranchGroupAction(params: CreateBranchGroupParams): Promise<void> {
  const reporter = getReporter(params);
  const executor = createAdminExecutor({ 'dry-run': !!params.dryRun, verbose: !!params.verbose });

  if (params.dryRun) reporter.log('🔍 Dry run mode - no changes will be made\n');

  const groupName = generateBranchGroupName(params.branchId as BranchID);
  if (!isValidBranchGroupName(groupName)) {
    throw new Error(`Invalid group name format: ${groupName}`);
  }

  const groupExists = await executor.check(UnixGroupCommands.groupExists(groupName));
  if (groupExists) {
    reporter.log(`✅ Group ${groupName} already exists`);
    return;
  }

  await executor.exec(UnixGroupCommands.createGroup(groupName));
  reporter.log(`✅ Created Unix group: ${groupName}`);
}

export interface DeleteBranchGroupParams extends LocalActionOptions {
  group: string;
}

export async function deleteBranchGroupAction(params: DeleteBranchGroupParams): Promise<void> {
  const reporter = getReporter(params);
  const executor = createAdminExecutor({ 'dry-run': !!params.dryRun, verbose: !!params.verbose });
  if (params.dryRun) reporter.log('🔍 Dry run mode - no changes will be made\n');

  const groupExists = await executor.check(UnixGroupCommands.groupExists(params.group));
  if (!groupExists) {
    reporter.log(`✅ Group ${params.group} does not exist`);
    return;
  }

  await executor.exec(UnixGroupCommands.deleteGroup(params.group));
  reporter.log(`✅ Deleted Unix group: ${params.group}`);
}

export interface BranchGroupMembershipParams extends LocalActionOptions {
  username: string;
  group: string;
}

export async function addToBranchGroupAction(params: BranchGroupMembershipParams): Promise<void> {
  const reporter = getReporter(params);
  const executor = createAdminExecutor({ 'dry-run': !!params.dryRun, verbose: !!params.verbose });
  if (params.dryRun) reporter.log('🔍 Dry run mode - no changes will be made\n');

  const isInGroup = await executor.check(
    UnixGroupCommands.isUserInGroup(params.username, params.group)
  );
  if (isInGroup) {
    reporter.log(`✅ User ${params.username} is already in group ${params.group}`);
    return;
  }

  await executor.exec(UnixGroupCommands.addUserToGroup(params.username, params.group));
  reporter.log(`✅ Added user ${params.username} to group ${params.group}`);
}

export async function removeFromBranchGroupAction(
  params: BranchGroupMembershipParams
): Promise<void> {
  const reporter = getReporter(params);
  const executor = createAdminExecutor({ 'dry-run': !!params.dryRun, verbose: !!params.verbose });
  if (params.dryRun) reporter.log('🔍 Dry run mode - no changes will be made\n');

  const isInGroup = await executor.check(
    UnixGroupCommands.isUserInGroup(params.username, params.group)
  );
  if (!isInGroup) {
    reporter.log(`✅ User ${params.username} is not in group ${params.group}`);
    return;
  }

  await executor.exec(UnixGroupCommands.removeUserFromGroup(params.username, params.group));
  reporter.log(`✅ Removed user ${params.username} from group ${params.group}`);
}
